import {database} from "../config/firebase.config";
import {
  FixJob,
  FixJobWithResult,
  FixResult,
  FixScope,
  RoomAnalysis,
  Problem,
  Solution,
  FixedProblem,
} from "../types/api.types";
import {AIService, ContentModerationError} from "./ai.service";
import {StorageService} from "./storage.service";
import {UserService} from "./user.service";
import {CacheService} from "./cache.service";
import {CACHE_KEYS} from "../config/redis.config";
import {captureException} from "../observability";
import * as logger from "firebase-functions/logger";
import * as crypto from "crypto";

interface CreateFixOptions {
  userId: string;
  imageId: string;
  fixScope: FixScope;
  problemIds?: string[];
  parentFixId?: string;
}

interface ProblemWithSolution {
  problem: Problem;
  solution: Solution;
  dimension: string;
}

export class FixService {
  private static readonly MAX_CONCURRENT_FIXES = 3;

  /**
   * Generate a signature hash for fix deduplication
   * Based on imageId + sorted problemIds
   */
  private static generateFixSignature(
    imageId: string,
    problemIds: string[]
  ): string {
    const sortedIds = [...problemIds].sort();
    const data = `${imageId}:${sortedIds.join(",")}`;
    return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
  }

  /**
   * Find a completed fix with the same signature for this image
   * OPTIMIZED: Checks Redis cache first, then fetches all fix records in parallel
   */
  private static async findExistingFixWithSignature(
    imageId: string,
    signature: string
  ): Promise<FixJob | null> {
    // Check Redis cache first for quick lookup
    const cachedFixId = await CacheService.getFixBySignature(
      imageId,
      signature
    );
    if (cachedFixId) {
      const fixSnapshot = await database.ref(`fixes/${cachedFixId}`).get();
      if (fixSnapshot.exists()) {
        const fix: FixJob = fixSnapshot.val();
        if (fix.status === "completed") {
          logger.info("fix:cache_hit", {
            imageId,
            signature: signature.slice(0, 8),
          });
          return fix;
        }
      }
      // Cached fixId is stale, remove it
      await CacheService.delete(CACHE_KEYS.fixBySignature(imageId, signature));
    }

    // Cache miss - check database
    const indexSnapshot = await database.ref(`imageFixIndex/${imageId}`).get();
    if (!indexSnapshot.exists()) {
      return null;
    }

    const fixIds: string[] = [];
    indexSnapshot.forEach((child) => {
      fixIds.push(child.key!);
    });

    // OPTIMIZATION: Fetch all fix records in parallel
    const fixSnapshots = await Promise.all(
      fixIds.map((fixId) => database.ref(`fixes/${fixId}`).get())
    );

    // Find a completed fix with matching signature
    for (const fixSnapshot of fixSnapshots) {
      if (fixSnapshot.exists()) {
        const fix: FixJob = fixSnapshot.val();
        if (fix.status === "completed" && fix.fixSignature === signature) {
          // Cache for future lookups
          CacheService.cacheFixSignature(imageId, signature, fix.fixId).catch(
            () => {}
          );
          return fix;
        }
      }
    }

    return null;
  }

  /**
   * Create a new fix job
   */
  static async createFix(options: CreateFixOptions): Promise<FixJob> {
    const {userId, imageId, fixScope, problemIds, parentFixId} = options;

    // Validate image exists and belongs to user
    const imageSnapshot = await database.ref(`images/${imageId}`).get();
    if (!imageSnapshot.exists()) {
      throw {error: "Not Found", message: "Image not found"};
    }

    const imageData = imageSnapshot.val();
    if (imageData.userId !== userId) {
      throw {
        error: "Forbidden",
        message: "You don't have access to this image",
      };
    }

    // Check if analysis is completed
    if (imageData.analysisStatus !== "completed") {
      throw {
        error: "Bad Request",
        message: "Image analysis must be completed before creating a fix",
      };
    }

    // Check rate limit - max concurrent fixes per user
    const pendingFixes = await this.getPendingFixesCount(userId);
    if (pendingFixes >= this.MAX_CONCURRENT_FIXES) {
      throw {
        error: "Too Many Requests",
        message: `Maximum ${this.MAX_CONCURRENT_FIXES} concurrent fixes allowed`,
      };
    }

    // Get analysis to validate problem IDs
    const analysisSnapshot = await database.ref(`analysis/${imageId}`).get();
    if (!analysisSnapshot.exists()) {
      throw {error: "Not Found", message: "Analysis not found"};
    }

    const analysis: RoomAnalysis = analysisSnapshot.val();
    const {validProblemIds, dimensions} = this.validateAndGetProblems(
      analysis,
      fixScope,
      problemIds
    );

    // ============================================
    // Fix Deduplication: Check for existing fix with same problems
    // ============================================
    // If this image is a duplicate (has analysisSourceId), check fixes on the SOURCE image
    // This ensures: same image content + same problems = reuse fix result
    const sourceImageId = imageData.analysisSourceId || imageId;
    const fixSignature = this.generateFixSignature(
      sourceImageId,
      validProblemIds
    );

    // First check fixes on current image
    let existingFix = await this.findExistingFixWithSignature(
      imageId,
      fixSignature
    );

    // If not found and this is a duplicate, check fixes on source image
    if (!existingFix && imageData.analysisSourceId) {
      existingFix = await this.findExistingFixWithSignature(
        imageData.analysisSourceId,
        fixSignature
      );
      if (existingFix) {
        logger.info("fix:source_match", {
          currentImageId: imageId,
          sourceImageId: imageData.analysisSourceId,
          sourceFixId: existingFix.fixId,
        });
      }
    }

    // Get next version number for this image
    const version = await this.getNextVersion(imageId);

    // Generate unique fix ID
    const {v4: uuidv4} = await import("uuid");
    const fixId = `fix_${uuidv4()}`;
    const fixJob: FixJob = {
      fixId,
      originalImageId: imageId,
      userId,
      status: "pending",
      fixScope,
      problemIds: validProblemIds,
      dimensions,
      version,
      fixSignature,
      ...(existingFix ? {sourceFixId: existingFix.fixId} : {}),
      ...(parentFixId ? {parentFixId} : {}),
      createdAt: new Date().toISOString(),
    };

    // OPTIMIZATION: Save fix job and create index in parallel
    await Promise.all([
      database.ref(`fixes/${fixId}`).set(fixJob),
      database.ref(`imageFixIndex/${imageId}/${fixId}`).set({
        version,
        status: "pending",
        createdAt: fixJob.createdAt,
      }),
    ]);

    return fixJob;
  }

  /**
   * Process a fix job asynchronously
   * OPTIMIZED: Batches database operations where possible
   */
  static async processFix(fixId: string): Promise<void> {
    logger.info("fix:processing:start", {fixId});

    try {
      // Get fix job first (we need the imageId for the index update)
      const fixSnapshot = await database.ref(`fixes/${fixId}`).get();
      const fixJob: FixJob = fixSnapshot.val();

      // OPTIMIZATION: Update status to processing in parallel
      await Promise.all([
        database.ref(`fixes/${fixId}`).update({status: "processing"}),
        database
          .ref(`imageFixIndex/${fixJob.originalImageId}/${fixId}`)
          .update({status: "processing"}),
      ]);

      logger.info("fix:processing:status_updated", {fixId});

      let fixResult: FixResult;

      // Check if we can reuse a previous fix result (same problems, same image)
      if (fixJob.sourceFixId) {
        logger.info("fix:processing:reusing_existing", {
          fixId,
          sourceFixId: fixJob.sourceFixId,
        });

        // Get the source fix result
        const sourceResultSnapshot = await database
          .ref(`fixResults/${fixJob.sourceFixId}`)
          .get();

        if (!sourceResultSnapshot.exists()) {
          throw new Error(`Source fix result not found: ${fixJob.sourceFixId}`);
        }

        const sourceResult: FixResult = sourceResultSnapshot.val();

        // Create new result with same data but updated fixId and timestamp
        const resolvedSummary = this.resolveFixSummary(sourceResult.summary);
        const resolvedFixName = this.resolveFixName(sourceResult.fixName);

        fixResult = {
          ...sourceResult,
          fixId: fixJob.fixId,
          summary: resolvedSummary,
          fixName: this.buildUniqueFixName(resolvedFixName, fixJob.fixId),
          generatedAt: new Date().toISOString(),
        };
      } else {
        // Generate new fix - no previous result to reuse

        // Get analysis
        const analysisSnapshot = await database
          .ref(`analysis/${fixJob.originalImageId}`)
          .get();
        const analysis: RoomAnalysis = analysisSnapshot.val();

        // Get problems and solutions to fix
        const problemsToFix = this.getProblemsWithSolutions(
          analysis,
          fixJob.problemIds
        );

        // Download original image buffer
        const originalImageBuffer = await StorageService.downloadImage(
          fixJob.userId,
          fixJob.originalImageId
        );

        let fixedImageStoragePath = "";
        let changesApplied: string[] = [];
        let fixName = "";
        let summary = "";
        let fixDescription: string | undefined;

        try {
          // Try to generate fixed image using AI
          const generatedImage = await AIService.generateFixedImage(
            fixJob.userId,
            fixJob.originalImageId,
            problemsToFix,
            originalImageBuffer
          );

          // Upload fixed image to storage
          const fixedImageMetadata = await StorageService.uploadFixedImage({
            userId: fixJob.userId,
            fixId: fixJob.fixId,
            imageBuffer: generatedImage.imageBuffer,
          });

          fixedImageStoragePath = fixedImageMetadata.storagePath;
          changesApplied = generatedImage.changesApplied;
          fixName = generatedImage.fixName || "";
          summary = generatedImage.summary || "";
        } catch (error) {
          logger.warn("fix:image-generation-failed:falling-back", {
            fixId,
            error: error instanceof Error ? error.message : String(error),
          });

          // FALLBACK: Use original image but provide a detailed design plan
          // We wrap these in a separate try-catch to ensure the entire job doesn't fail
          try {
            const [designPlan, metadata] = await Promise.all([
              AIService.generateFixPlan(originalImageBuffer, problemsToFix),
              AIService.generateFixMetadata(problemsToFix),
            ]);

            // Get original image metadata to reuse storage path
            const imageSnapshot = await database
              .ref(`images/${fixJob.originalImageId}`)
              .get();
            const imageData = imageSnapshot.val();

            fixedImageStoragePath = imageData.storagePath;
            fixDescription = designPlan;
            changesApplied = problemsToFix.map((p) => p.solution.title);
            fixName = metadata.fixName;
            summary = metadata.summary;
          } catch (fallbackError) {
            logger.error("fix:fallback-generation-failed", {
              fixId,
              error: String(fallbackError),
            });
            throw new Error(
              `Failed to generate fix even after fallback: ${String(fallbackError)}`
            );
          }
        }

        // Calculate improved scores based on fixed problems (deterministic)
        const originalScore = analysis.overall.score;
        const calculatedScores = this.calculateFixedScores(
          analysis,
          fixJob.problemIds,
          fixJob.fixScope
        );
        const fixedScore = calculatedScores.fixedScore;
        const scoreDelta = fixedScore - originalScore;
        const originalDimensionScores = {
          lighting: analysis.dimensions.lighting.score,
          spatial: analysis.dimensions.spatial.score,
          color: analysis.dimensions.color.score,
          clutter: analysis.dimensions.clutter.score,
          biophilic: analysis.dimensions.biophilic.score,
          fengShui: analysis.dimensions.fengShui.score,
        };
        const fixedDimensionScores = calculatedScores.fixedDimensionScores;

        // Create fix result
        const problemsFixed: FixedProblem[] = problemsToFix.map((p) => ({
          problemId: p.problem.problemId,
          dimension: p.dimension,
          title: p.problem.title,
          solutionApplied: p.solution.title,
        }));

        const resolvedSummary = this.resolveFixSummary(summary);
        const resolvedFixName = this.resolveFixName(fixName);

        fixResult = {
          fixId: fixJob.fixId,
          originalImageId: fixJob.originalImageId,
          fixedImageStoragePath,
          problemsFixed,
          summary: resolvedSummary,
          fixName: this.buildUniqueFixName(resolvedFixName, fixJob.fixId),
          changesApplied,
          originalScore,
          fixedScore,
          scoreDelta,
          originalDimensionScores,
          fixedDimensionScores,
          generatedAt: new Date().toISOString(),
          ...(fixDescription ? {fixDescription} : {}),
        };
      }

      // OPTIMIZATION: Batch all completion database operations in parallel
      // Note: Transaction for fixCount must run separately as it's atomic
      const completedAt = new Date().toISOString();
      await Promise.all([
        // Save fix result to database
        database.ref(`fixResults/${fixId}`).set(fixResult),
        // Update fix job status
        database.ref(`fixes/${fixId}`).update({
          status: "completed",
          completedAt,
        }),
        // Update image fix index
        database
          .ref(`imageFixIndex/${fixJob.originalImageId}/${fixId}`)
          .update({status: "completed"}),
        // Update image fixCount (transaction for atomic increment)
        database
          .ref(`images/${fixJob.originalImageId}`)
          .transaction((currentData) => {
            if (currentData) {
              return {
                ...currentData,
                fixCount: (currentData.fixCount || 0) + 1,
              };
            }
            return currentData;
          }),
        // CACHE: Store fix result in Redis
        CacheService.cacheFixResult(fixId, fixResult),
        // CACHE: Store fix signature for deduplication
        CacheService.cacheFixSignature(
          fixJob.originalImageId,
          fixJob.fixSignature!,
          fixId
        ),
        // Invalidate fix index cache for this image
        CacheService.delete(CACHE_KEYS.fixIndex(fixJob.originalImageId)),
      ]);

      logger.info("fix:completed", {
        fixId,
        imageId: fixJob.originalImageId,
        signature: fixJob.fixSignature?.slice(0, 8),
      });
    } catch (error) {
      logger.error("fix:processing:failed", {
        fixId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      captureException(error, {fixId, context: "processFix"});

      // Get fix job to get image ID and user ID
      const fixSnapshot = await database.ref(`fixes/${fixId}`).get();
      if (fixSnapshot.exists()) {
        const failedFixJob: FixJob = fixSnapshot.val();

        // Record content violation if applicable
        if (
          error instanceof ContentModerationError &&
          error.category !== "error"
        ) {
          await UserService.recordContentViolation(
            failedFixJob.userId,
            error.category
          );
        }

        // OPTIMIZATION: Batch failure status updates in parallel
        const errorMessage =
          error instanceof Error ? error.message : "Fix generation failed";
        await Promise.all([
          database.ref(`fixes/${fixId}`).update({
            status: "failed",
            error: errorMessage,
          }),
          database
            .ref(`imageFixIndex/${failedFixJob.originalImageId}/${fixId}`)
            .update({status: "failed"}),
        ]);
      }

      throw error;
    }
  }

  /**
   * Get fix job status and result
   * OPTIMIZED: Checks Redis cache first for fix results
   */
  static async getFixResult(
    userId: string,
    imageId: string,
    fixId: string
  ): Promise<{fix: FixJob; result?: FixResult}> {
    // Get fix job
    const fixSnapshot = await database.ref(`fixes/${fixId}`).get();
    if (!fixSnapshot.exists()) {
      throw {error: "Not Found", message: "Fix not found"};
    }

    const fixJob: FixJob = fixSnapshot.val();

    // Validate ownership and image match
    if (fixJob.userId !== userId) {
      throw {error: "Forbidden", message: "You don't have access to this fix"};
    }
    if (fixJob.originalImageId !== imageId) {
      throw {
        error: "Bad Request",
        message: "Fix does not belong to this image",
      };
    }

    // Get result if completed - check cache first
    let result: FixResult | undefined;
    if (fixJob.status === "completed") {
      // Try cache first
      const cachedResult = await CacheService.getFixResult<FixResult>(fixId);
      if (cachedResult) {
        result = this.ensureFixResultSummary(cachedResult);
      } else {
        // Cache miss - fetch from database
        const resultSnapshot = await database.ref(`fixResults/${fixId}`).get();
        if (resultSnapshot.exists()) {
          result = this.ensureFixResultSummary(resultSnapshot.val());
          // Cache for future requests (fire-and-forget)
          CacheService.cacheFixResult(fixId, result).catch(() => {});
        }
      }
    }

    return {fix: fixJob, result};
  }

  /**
   * List all fixes for an image
   */
  static async listFixes(
    userId: string,
    imageId: string
  ): Promise<FixJobWithResult[]> {
    // Validate image ownership
    const imageSnapshot = await database.ref(`images/${imageId}`).get();
    if (!imageSnapshot.exists()) {
      throw {error: "Not Found", message: "Image not found"};
    }

    const imageData = imageSnapshot.val();
    if (imageData.userId !== userId) {
      throw {
        error: "Forbidden",
        message: "You don't have access to this image",
      };
    }

    // Get fixes for this image
    const indexSnapshot = await database
      .ref(`imageFixIndex/${imageId}`)
      .orderByChild("version")
      .get();

    if (!indexSnapshot.exists()) {
      return [];
    }

    const fixIds: string[] = [];
    indexSnapshot.forEach((child) => {
      fixIds.push(child.key!);
    });

    // Fetch full fix jobs
    const fixSnapshots = await Promise.all(
      fixIds.map((fixId) => database.ref(`fixes/${fixId}`).get())
    );

    const fixes: FixJob[] = fixSnapshots
      .filter((snap) => snap.exists())
      .map((snap) => snap.val());

    // Attach results for completed fixes (so UI can show fixed image + what changed)
    const fixesWithResults: FixJobWithResult[] = await Promise.all(
      fixes.map(async (fix) => {
        if (fix.status !== "completed") return fix;

        const resultSnapshot = await database
          .ref(`fixResults/${fix.fixId}`)
          .get();
        if (!resultSnapshot.exists()) return fix;

        const resultWithSummary = this.ensureFixResultSummary(
          resultSnapshot.val()
        );

        return {
          ...fix,
          result: resultWithSummary,
        };
      })
    );

    // Newest to oldest
    fixesWithResults.sort((a, b) => (b.version || 0) - (a.version || 0));

    return fixesWithResults;
  }

  /**
   * Delete a fix
   */
  static async deleteFix(
    userId: string,
    imageId: string,
    fixId: string
  ): Promise<void> {
    // Get fix job
    const fixSnapshot = await database.ref(`fixes/${fixId}`).get();
    if (!fixSnapshot.exists()) {
      throw {error: "Not Found", message: "Fix not found"};
    }

    const fixJob: FixJob = fixSnapshot.val();

    // Validate ownership and image match
    if (fixJob.userId !== userId) {
      throw {error: "Forbidden", message: "You don't have access to this fix"};
    }
    if (fixJob.originalImageId !== imageId) {
      throw {
        error: "Bad Request",
        message: "Fix does not belong to this image",
      };
    }

    // Delete fixed image from storage if completed
    if (fixJob.status === "completed") {
      try {
        await StorageService.deleteFixedImage(userId, fixId);
      } catch (error) {
        logger.error("Failed to delete fixed image:", error);
      }
    }

    // Delete from database
    await database.ref(`fixes/${fixId}`).remove();
    await database.ref(`fixResults/${fixId}`).remove();
    await database.ref(`imageFixIndex/${imageId}/${fixId}`).remove();
  }

  /**
   * Get count of pending/processing fixes for a user
   */
  private static async getPendingFixesCount(userId: string): Promise<number> {
    const fixesSnapshot = await database
      .ref("fixes")
      .orderByChild("userId")
      .equalTo(userId)
      .get();

    if (!fixesSnapshot.exists()) {
      return 0;
    }

    let count = 0;
    fixesSnapshot.forEach((child) => {
      const fix: FixJob = child.val();
      if (fix.status === "pending" || fix.status === "processing") {
        count++;
      }
    });

    return count;
  }

  /**
   * Get next version number for fixes on an image
   */
  private static async getNextVersion(imageId: string): Promise<number> {
    const indexSnapshot = await database.ref(`imageFixIndex/${imageId}`).get();
    if (!indexSnapshot.exists()) {
      return 1;
    }

    let maxVersion = 0;
    indexSnapshot.forEach((child) => {
      const version = child.val().version || 0;
      if (version > maxVersion) {
        maxVersion = version;
      }
    });

    return maxVersion + 1;
  }

  /**
   * Validate problem IDs and extract dimensions
   */
  private static validateAndGetProblems(
    analysis: RoomAnalysis,
    fixScope: FixScope,
    problemIds?: string[]
  ): {validProblemIds: string[]; dimensions: string[]} {
    const allProblems: {problemId: string; dimension: string}[] = [];

    // Collect all problems from analysis
    const dimensionKeys = Object.keys(analysis.dimensions) as Array<
      keyof typeof analysis.dimensions
    >;
    for (const dimension of dimensionKeys) {
      const dimAnalysis = analysis.dimensions[dimension];
      for (const problem of dimAnalysis.problems) {
        allProblems.push({problemId: problem.problemId, dimension});
      }
    }

    if (fixScope === "all") {
      return {
        validProblemIds: allProblems.map((p) => p.problemId),
        dimensions: [...new Set(allProblems.map((p) => p.dimension))],
      };
    }

    if (!problemIds || problemIds.length === 0) {
      throw {
        error: "Bad Request",
        message: "problemIds required for single/multiple fix scope",
      };
    }

    // Validate provided problem IDs exist
    const validProblems = allProblems.filter((p) =>
      problemIds.includes(p.problemId)
    );

    if (validProblems.length === 0) {
      throw {
        error: "Bad Request",
        message: "None of the provided problemIds were found in the analysis",
      };
    }

    if (fixScope === "single" && validProblems.length > 1) {
      // Take only the first valid problem for single scope
      return {
        validProblemIds: [validProblems[0].problemId],
        dimensions: [validProblems[0].dimension],
      };
    }

    return {
      validProblemIds: validProblems.map((p) => p.problemId),
      dimensions: [...new Set(validProblems.map((p) => p.dimension))],
    };
  }

  /**
   * Get problems with their solutions for fix generation
   */
  private static getProblemsWithSolutions(
    analysis: RoomAnalysis,
    problemIds: string[]
  ): ProblemWithSolution[] {
    const result: ProblemWithSolution[] = [];

    const dimensionKeys = Object.keys(analysis.dimensions) as Array<
      keyof typeof analysis.dimensions
    >;
    for (const dimension of dimensionKeys) {
      const dimAnalysis = analysis.dimensions[dimension];
      for (const problem of dimAnalysis.problems) {
        if (problemIds.includes(problem.problemId)) {
          // Find best solution for this problem
          const solution = dimAnalysis.solutions.find(
            (s) => s.problemId === problem.problemId
          );
          if (solution) {
            result.push({problem, solution, dimension});
          }
        }
      }
    }

    return result;
  }

  /**
   * Calculate improved scores based on which problems were fixed.
   * This provides deterministic scoring instead of re-analyzing the AI image.
   *
   * Logic:
   * - For each dimension, if ALL problems are fixed → score becomes 95-100
   * - If some problems are fixed → score improves proportionally
   * - Severity impacts the improvement amount (high=15pts, medium=10pts, low=5pts)
   */
  private static calculateFixedScores(
    analysis: RoomAnalysis,
    fixedProblemIds: string[],
    fixScope: FixScope
  ): {
    fixedScore: number;
    fixedDimensionScores: {
      lighting: number;
      spatial: number;
      color: number;
      clutter: number;
      biophilic: number;
      fengShui: number;
    };
  } {
    const dimensionKeys = [
      "lighting",
      "spatial",
      "color",
      "clutter",
      "biophilic",
      "fengShui",
    ] as const;

    const fixedDimensionScores: Record<string, number> = {};

    for (const dimension of dimensionKeys) {
      const dimAnalysis = analysis.dimensions[dimension];
      const originalScore = dimAnalysis.score;
      const totalProblems = dimAnalysis.problems.length;

      if (totalProblems === 0) {
        // No problems in this dimension, keep original score (likely already high)
        fixedDimensionScores[dimension] = Math.max(originalScore, 90);
        continue;
      }

      // Count fixed problems in this dimension
      const fixedInDimension = dimAnalysis.problems.filter((p) =>
        fixedProblemIds.includes(p.problemId)
      );
      const fixedCount = fixedInDimension.length;

      if (fixedCount === 0) {
        // No problems fixed in this dimension, keep original score
        fixedDimensionScores[dimension] = originalScore;
        continue;
      }

      // Calculate improvement based on severity of fixed problems
      let improvementPoints = 0;
      for (const problem of fixedInDimension) {
        switch (problem.severity) {
          case "high":
            improvementPoints += 15;
            break;
          case "medium":
            improvementPoints += 10;
            break;
          case "low":
            improvementPoints += 5;
            break;
        }
      }

      // If ALL problems in dimension are fixed, set score to 95-100
      if (fixedCount === totalProblems) {
        fixedDimensionScores[dimension] = Math.min(
          100,
          Math.max(95, originalScore + improvementPoints)
        );
      } else {
        // Partial fix - improve proportionally, cap at 90
        const newScore = originalScore + improvementPoints;
        fixedDimensionScores[dimension] = Math.min(90, newScore);
      }
    }

    // Calculate overall score as average of dimension scores
    const totalDimensionScore = dimensionKeys.reduce(
      (sum, dim) => sum + fixedDimensionScores[dim],
      0
    );
    let fixedScore = Math.round(totalDimensionScore / dimensionKeys.length);

    // If fixing ALL problems across all dimensions, ensure high score
    if (fixScope === "all") {
      fixedScore = Math.max(fixedScore, 95);
    }

    return {
      fixedScore,
      fixedDimensionScores: {
        lighting: fixedDimensionScores.lighting,
        spatial: fixedDimensionScores.spatial,
        color: fixedDimensionScores.color,
        clutter: fixedDimensionScores.clutter,
        biophilic: fixedDimensionScores.biophilic,
        fengShui: fixedDimensionScores.fengShui,
      },
    };
  }

  private static resolveFixSummary(summary: string | undefined): string {
    return this.normalizeSingleLine(summary || "");
  }

  private static resolveFixName(fixName: string | undefined): string {
    return this.normalizeSingleLine(fixName || "");
  }

  private static buildUniqueFixName(baseName: string, fixId: string): string {
    const normalizedBase = this.normalizeSingleLine(baseName);
    const suffix = fixId.slice(-6).toUpperCase();

    if (!normalizedBase) {
      return suffix;
    }

    const upperBase = normalizedBase.toUpperCase();

    // If baseName is already just the suffix, don't duplicate it
    if (upperBase === suffix) {
      return suffix;
    }

    const expectedSuffix = `• ${suffix}`;

    if (upperBase.endsWith(expectedSuffix)) {
      return normalizedBase;
    }

    return `${normalizedBase} • ${suffix}`;
  }

  private static normalizeSingleLine(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }

  private static ensureFixResultSummary(result: FixResult): FixResult {
    const resolvedSummary = this.resolveFixSummary(result.summary);
    const resolvedFixName = this.buildUniqueFixName(
      this.resolveFixName(result.fixName),
      result.fixId
    );

    return {
      ...result,
      summary: resolvedSummary,
      fixName: resolvedFixName,
    };
  }
}
