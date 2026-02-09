import {database} from "../config/firebase.config";
import {
  VideoFixJob,
  VideoFixJobWithResult,
  VideoFixResult,
  VideoFixScope,
  VideoFixedProblem,
  VideoDimensionScores,
  VideoAnalysis,
  VideoMetadata,
  FixedFrameData,
  FrameFixSelection,
  GeneralProblem,
  ProblemFrame,
  FrameProblem,
  FrameAnalysis,
} from "../types/video.types";
import {AIService, ContentModerationError} from "./ai.service";
import {StorageService} from "./storage.service";
import {UserService} from "./user.service";
import {CacheService} from "./cache.service";
import {CACHE_KEYS} from "../config/redis.config";
import {publishVideoFixJob} from "../config/pubsub.config";
import {VIDEO_REPRESENTATIVE_FRAMES} from "../config/constants";
import {captureException} from "../observability";
import * as logger from "firebase-functions/logger";
import * as crypto from "crypto";

interface CreateVideoFixOptions {
  userId: string;
  videoId: string;
  fixScope: VideoFixScope;
  generalProblemIds?: string[];
  frameFixes?: FrameFixSelection[];
}

export class VideoFixService {
  private static readonly MAX_CONCURRENT_FIXES = 3;

  /**
   * Generate a 16-char signature hash for fix deduplication
   * SHA256(videoId + sorted problemIds)
   */
  private static generateFixSignature(
    videoId: string,
    problemIds: string[]
  ): string {
    const sortedIds = [...problemIds].sort();
    const data = `${videoId}:${sortedIds.join(",")}`;
    return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
  }

  /**
   * Generate a 32-char content hash for video deduplication
   */
  static generateVideoHash(buffer: Buffer): string {
    return crypto
      .createHash("sha256")
      .update(buffer)
      .digest("hex")
      .slice(0, 32);
  }

  /**
   * Check if a video with this hash already exists for user
   */
  static async findDuplicateVideo(
    userId: string,
    contentHash: string
  ): Promise<string | null> {
    // Check cache first
    const cachedVideoId = await CacheService.getVideoByHash(
      userId,
      contentHash
    );
    if (cachedVideoId) {
      return cachedVideoId;
    }

    // Check database
    const snapshot = await database
      .ref(`videoHashes/${userId}/${contentHash}`)
      .get();

    if (snapshot.exists()) {
      const data = snapshot.val();
      // Cache for future lookups
      CacheService.cacheVideoHash(userId, contentHash, data.videoId);
      return data.videoId;
    }

    return null;
  }

  /**
   * Register a video content hash for deduplication
   */
  static async registerVideoHash(
    userId: string,
    contentHash: string,
    videoId: string
  ): Promise<void> {
    await database.ref(`videoHashes/${userId}/${contentHash}`).set({
      videoId,
      createdAt: new Date().toISOString(),
    });

    // Cache for future lookups
    CacheService.cacheVideoHash(userId, contentHash, videoId);
  }

  /**
   * Find an existing fix with the same signature
   * Also checks source video if this video is a duplicate
   */
  private static async findExistingFixWithSignature(
    videoId: string,
    fixSignature: string
  ): Promise<string | null> {
    // Check cache first
    const cachedFixId = await CacheService.getVideoFixBySignature(
      videoId,
      fixSignature
    );
    if (cachedFixId) {
      return cachedFixId;
    }

    // Check database for this video's fixes
    const snapshot = await database
      .ref(`videoFixSignatures/${videoId}/${fixSignature}`)
      .get();

    if (snapshot.exists()) {
      const fixId = snapshot.val();
      CacheService.cacheVideoFixSignature(videoId, fixSignature, fixId);
      return fixId;
    }

    // Check if this video has an analysis source (is a duplicate)
    const videoSnapshot = await database.ref(`videos/${videoId}`).get();
    if (videoSnapshot.exists()) {
      const videoData: VideoMetadata = videoSnapshot.val();
      if (videoData.analysisSourceId) {
        // Check the source video's fixes
        const sourceSnapshot = await database
          .ref(
            `videoFixSignatures/${videoData.analysisSourceId}/${fixSignature}`
          )
          .get();

        if (sourceSnapshot.exists()) {
          return sourceSnapshot.val();
        }
      }
    }

    return null;
  }

  /**
   * Create a new fix job for a video
   * Returns immediately with fix ID, processing happens async via Pub/Sub
   */
  static async createVideoFix(
    options: CreateVideoFixOptions
  ): Promise<{fixId: string; status: "pending"; isCached: boolean}> {
    const {userId, videoId, fixScope, generalProblemIds, frameFixes} = options;

    // Validate video exists and belongs to user
    const videoSnapshot = await database.ref(`videos/${videoId}`).get();
    if (!videoSnapshot.exists()) {
      throw {error: "Not Found", message: "Video not found"};
    }

    const videoData: VideoMetadata = videoSnapshot.val();
    if (videoData.userId !== userId) {
      throw {
        error: "Forbidden",
        message: "You don't have access to this video",
      };
    }

    // Check if analysis is completed
    if (videoData.analysisStatus !== "completed") {
      throw {
        error: "Bad Request",
        message: "Video analysis must be completed before creating a fix",
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
    const analysisSnapshot = await database
      .ref(`videoAnalysis/${videoId}`)
      .get();
    if (!analysisSnapshot.exists()) {
      throw {error: "Not Found", message: "Analysis not found"};
    }

    const analysis: VideoAnalysis = analysisSnapshot.val();

    // Validate and get problems
    const validated = this.validateAndGetProblems(
      analysis,
      fixScope,
      generalProblemIds,
      frameFixes
    );

    const fixSignature = this.generateFixSignature(
      videoId,
      validated.allProblemIds
    );
    const version = await this.getNextVersion(videoId);

    // Check for existing fix with same signature (deduplication)
    const existingFixId = await this.findExistingFixWithSignature(
      videoId,
      fixSignature
    );

    // Generate unique fix ID
    const {v4: uuidv4} = await import("uuid");
    const fixId = `vfix_${uuidv4()}`;

    const fixJob: VideoFixJob = {
      fixId,
      originalVideoId: videoId,
      userId,
      status: "pending",
      fixScope,
      problemIds: validated.allProblemIds,
      dimensions: validated.dimensions,
      version,
      fixSignature,
      ...(existingFixId ? {sourceFixId: existingFixId} : {}),
      ...(generalProblemIds?.length ? {generalProblemIds} : {}),
      ...(frameFixes?.length ? {frameFixes} : {}),
      createdAt: new Date().toISOString(),
    };

    // Save fix job and index
    await Promise.all([
      database.ref(`videoFixes/${fixId}`).set(fixJob),
      database.ref(`videoFixIndex/${videoId}/${fixId}`).set({
        version,
        status: "pending",
        createdAt: fixJob.createdAt,
      }),
    ]);

    // Publish to Pub/Sub queue for async processing
    await publishVideoFixJob(fixId, videoId, userId);

    logger.info("video:fix:created", {
      fixId,
      videoId,
      userId,
      isCached: !!existingFixId,
    });

    return {
      fixId,
      status: "pending",
      isCached: !!existingFixId,
    };
  }

  /**
   * Process a video fix job
   * Called by Pub/Sub worker
   */
  static async processVideoFix(fixId: string): Promise<void> {
    logger.info("video:fix:processing:start", {fixId});

    try {
      const fixSnapshot = await database.ref(`videoFixes/${fixId}`).get();
      if (!fixSnapshot.exists()) {
        throw new Error(`Fix job ${fixId} not found`);
      }

      const fixJob: VideoFixJob = fixSnapshot.val();
      const videoId = fixJob.originalVideoId;

      // Update status to processing
      await Promise.all([
        database.ref(`videoFixes/${fixId}`).update({status: "processing"}),
        database
          .ref(`videoFixIndex/${videoId}/${fixId}`)
          .update({status: "processing"}),
      ]);

      // Check if this is a cached result (sourceFixId exists)
      if (fixJob.sourceFixId) {
        await this.copyFixFromSource(fixId, fixJob);
        return;
      }

      // Get video metadata and analysis
      const [videoSnapshot, analysisSnapshot] = await Promise.all([
        database.ref(`videos/${videoId}`).get(),
        database.ref(`videoAnalysis/${videoId}`).get(),
      ]);

      const videoData: VideoMetadata = videoSnapshot.val();
      const analysis: VideoAnalysis = analysisSnapshot.val();

      // Get the existing frames from the analysis
      const analysisFrames = analysis.frames || [];
      if (analysisFrames.length === 0) {
        throw new Error("No frames found in video analysis");
      }

      // Get validated problems from the fix job
      const validated = this.validateAndGetProblems(
        analysis,
        fixJob.fixScope,
        fixJob.generalProblemIds,
        fixJob.frameFixes
      );
      const {generalProblems, frameProblems: frameProblemsMap} = validated;

      // Determine which frames to process
      const frameIndicesSet = new Set<number>();

      // 1. Add exact frames for frame-specific problems
      for (const frameIndex of frameProblemsMap.keys()) {
        frameIndicesSet.add(frameIndex);
      }

      // 2. If no specific frames are being fixed, but we have general problems,
      // select representative frames to show the general fixes.
      // If we ARE fixing specific frames, general problems will be applied to those frames automatically,
      // so we don't need to generate extra representative frames (reduces cost/noise).
      if (frameIndicesSet.size === 0 && generalProblems.length > 0) {
        const representativeIndices =
          this.getRepresentativeFrameIndices(analysisFrames);
        representativeIndices.forEach((idx) => frameIndicesSet.add(idx));
      }

      // Get frame objects
      let framesToProcess = analysisFrames.filter((f) =>
        frameIndicesSet.has(f.frameIndex)
      );

      // Fallback to first frame if nothing selected
      if (framesToProcess.length === 0 && analysisFrames.length > 0) {
        framesToProcess = [analysisFrames[0]];
      }

      const fixedFrameData: FixedFrameData[] = [];
      const allChangesApplied: Set<string> = new Set();
      let finalFixName = "";
      let finalSummary = "";

      // Process frames (in small batches to avoid overloading)
      const BATCH_SIZE = 2;
      for (let i = 0; i < framesToProcess.length; i += BATCH_SIZE) {
        const batch = framesToProcess.slice(i, i + BATCH_SIZE);

        await Promise.all(
          batch.map(async (frame) => {
            const frameBuffer = await StorageService.downloadVideoFrame(
              fixJob.userId,
              videoId,
              frame.frameIndex
            );

            // Combine general problems + frame-specific problems for this frame
            const specificProblems =
              frameProblemsMap.get(frame.frameIndex) || [];
            const allFrameProblems = [...generalProblems, ...specificProblems];

            // Convert to the format AIService expects
            const frameProblems = allFrameProblems.map((p) => ({
              problem: {
                problemId: p.problemId,
                title: p.title,
                description: p.description,
                impact: p.impact,
                research: p.research,
                severity: p.severity,
              },
              solution: {
                solutionId: p.solution.solutionId,
                problemId: p.problemId,
                title: p.solution.title,
                description: p.solution.description,
                steps: p.solution.steps,
                costEstimate: p.solution.costEstimate,
                difficulty: p.solution.difficulty,
                timeEstimate: p.solution.timeEstimate,
                priority: p.solution.priority,
              },
              dimension: p.dimension,
            }));

            const problemsInFrame: VideoFixedProblem[] = allFrameProblems.map(
              (p) => ({
                problemId: p.problemId,
                dimension: p.dimension,
                title: p.title,
                solutionApplied: p.solution.title,
              })
            );

            // Skip if no problems to fix for this frame
            if (frameProblems.length === 0) {
              return;
            }

            try {
              // 1. Try to generate a visually fixed image
              const result = await AIService.generateFixedImage(
                fixJob.userId,
                "", // imageId not needed for buffer
                frameProblems,
                frameBuffer
              );

              // 2. Upload the new fixed image
              const fixedImageMetadata = await StorageService.uploadFixedImage({
                userId: fixJob.userId,
                fixId: `${fixId}_f${frame.frameIndex}`,
                imageBuffer: result.imageBuffer,
              });

              fixedFrameData.push({
                frameIndex: frame.frameIndex,
                timestamp: frame.timestamp,
                originalFrameStoragePath: frame.storagePath,
                fixedFrameStoragePath: fixedImageMetadata.storagePath,
                fixDescription: result.summary,
                problems: problemsInFrame,
              });

              result.changesApplied.forEach((c) => allChangesApplied.add(c));
              if (!finalFixName) finalFixName = result.fixName || "";
              if (!finalSummary) finalSummary = result.summary || "";
            } catch (error) {
              logger.warn("video:fix:frame-gen-failed:falling-back", {
                fixId,
                frameIndex: frame.frameIndex,
                error: String(error),
              });

              // 3. FALLBACK: Use original image + detailed design plan
              const [designPlan, metadata] = await Promise.all([
                AIService.generateFixPlan(frameBuffer, frameProblems),
                AIService.generateFixMetadata(frameProblems),
              ]);

              fixedFrameData.push({
                frameIndex: frame.frameIndex,
                timestamp: frame.timestamp,
                originalFrameStoragePath: frame.storagePath,
                fixedFrameStoragePath: frame.storagePath,
                fixDescription: designPlan,
                problems: problemsInFrame,
              });

              if (!finalFixName) finalFixName = metadata.fixName;
              if (!finalSummary) finalSummary = metadata.summary;
              frameProblems.forEach((p) =>
                allChangesApplied.add(p.solution.title)
              );
            }
          })
        );
      }

      // Sort frames by timestamp to ensure correct order
      fixedFrameData.sort((a, b) => a.timestamp - b.timestamp);

      // Calculate scores
      const originalScore = analysis.overall.score;
      const calculatedScores = this.calculateFixedScores(
        analysis,
        fixJob.problemIds,
        fixJob.fixScope
      );

      const fixedScore = calculatedScores.fixedScore;
      const scoreDelta = fixedScore - originalScore;

      const originalDimensionScores: VideoDimensionScores = {
        lighting: analysis.dimensions.lighting.score,
        spatial: analysis.dimensions.spatial.score,
        color: analysis.dimensions.color.score,
        clutter: analysis.dimensions.clutter.score,
        biophilic: analysis.dimensions.biophilic.score,
        fengShui: analysis.dimensions.fengShui.score,
      };

      // Build problemsFixed list
      const problemsFixed: VideoFixedProblem[] = [
        ...generalProblems.map((p) => ({
          problemId: p.problemId,
          dimension: p.dimension,
          title: p.title,
          solutionApplied: p.solution.title,
        })),
        ...Array.from(frameProblemsMap.values())
          .flat()
          .map((p) => ({
            problemId: p.problemId,
            dimension: p.dimension,
            title: p.title,
            solutionApplied: p.solution.title,
          })),
      ];

      const fixResult: VideoFixResult = {
        fixId,
        originalVideoId: videoId,
        fixedFrames: fixedFrameData,
        problemsFixed,
        summary: finalSummary || "Video frames fixed successfully",
        fixName: finalFixName || "Fixed Frames",
        changesApplied: Array.from(allChangesApplied),
        originalScore,
        fixedScore,
        scoreDelta,
        originalDimensionScores,
        fixedDimensionScores: calculatedScores.fixedDimensionScores,
        duration: videoData.duration,
        generatedAt: new Date().toISOString(),
      };

      const completedAt = new Date().toISOString();

      // Save result and update status
      await Promise.all([
        database.ref(`videoFixResults/${fixId}`).set(fixResult),
        database.ref(`videoFixes/${fixId}`).update({
          status: "completed",
          completedAt,
        }),
        database
          .ref(`videoFixIndex/${videoId}/${fixId}`)
          .update({status: "completed"}),
        // Update video fixCount (transaction for atomic increment)
        database.ref(`videos/${videoId}`).transaction((currentData) => {
          if (currentData) {
            return {
              ...currentData,
              fixCount: (currentData.fixCount || 0) + 1,
            };
          }
          return currentData;
        }),
        // Store signature mapping ONLY on successful completion for deduplication
        database
          .ref(`videoFixSignatures/${videoId}/${fixJob.fixSignature}`)
          .set(fixId),
        CacheService.cacheVideoFixResult(fixId, fixResult),
        CacheService.cacheVideoFixSignature(
          videoId,
          fixJob.fixSignature,
          fixId
        ),
        CacheService.delete(CACHE_KEYS.videoFixIndex(videoId)),
      ]);

      // TODO: Future enhancement - Analyze the generated fixed video
      // Similar to uploaded videos, we could extract frames from the fixed video
      // and run full analysis to get actual scores instead of calculated ones.
      // This would involve:
      // 1. Creating a video metadata record for the fixed video
      // 2. Publishing to VIDEO_ANALYSIS_QUEUE via publishVideoAnalysisJob
      // 3. Storing frame-by-frame analysis results
      // This allows verification of the AI-generated improvements and provides
      // more accurate quality metrics.

      logger.info("video:fix:completed", {
        fixId,
        videoId,
      });
    } catch (error) {
      logger.error("video:fix:failed", {fixId, error: String(error)});
      captureException(error, {fixId, context: "processVideoFix"});

      const fixSnapshot = await database.ref(`videoFixes/${fixId}`).get();
      if (fixSnapshot.exists()) {
        const failedFixJob: VideoFixJob = fixSnapshot.val();
        const videoId = failedFixJob.originalVideoId;

        if (
          error instanceof ContentModerationError &&
          error.category !== "error"
        ) {
          await UserService.recordContentViolation(
            failedFixJob.userId,
            error.category
          );
        }

        await Promise.all([
          database.ref(`videoFixes/${fixId}`).update({
            status: "failed",
            error: error instanceof Error ? error.message : "Fix failed",
          }),
          database
            .ref(`videoFixIndex/${videoId}/${fixId}`)
            .update({status: "failed"}),
        ]);
      }

      throw error;
    }
  }

  /**
   * Copy fix result from a source fix (for deduplication)
   * Still deducts credits since user intentionally requested
   */
  private static async copyFixFromSource(
    fixId: string,
    fixJob: VideoFixJob
  ): Promise<void> {
    const sourceFixId = fixJob.sourceFixId!;

    logger.info("video:fix:copying:start", {fixId, sourceFixId});

    // Verify source fix was successful
    const sourceFixSnapshot = await database
      .ref(`videoFixes/${sourceFixId}`)
      .get();

    if (!sourceFixSnapshot.exists()) {
      throw new Error(`Source fix ${sourceFixId} not found`);
    }

    const sourceFix: VideoFixJob = sourceFixSnapshot.val();
    if (sourceFix.status !== "completed") {
      throw new Error(
        `Cannot copy from source fix ${sourceFixId} - status is ${sourceFix.status}, not completed`
      );
    }

    // Get source result
    const sourceResultSnapshot = await database
      .ref(`videoFixResults/${sourceFixId}`)
      .get();

    if (!sourceResultSnapshot.exists()) {
      throw new Error(`Source fix result ${sourceFixId} not found`);
    }

    const sourceResult: VideoFixResult = sourceResultSnapshot.val();

    // Create new result with updated IDs
    const fixResult: VideoFixResult = {
      ...sourceResult,
      fixId,
      originalVideoId: fixJob.originalVideoId,
      generatedAt: new Date().toISOString(),
    };

    const completedAt = new Date().toISOString();

    await Promise.all([
      database.ref(`videoFixResults/${fixId}`).set(fixResult),
      database.ref(`videoFixes/${fixId}`).update({
        status: "completed",
        completedAt,
      }),
      database
        .ref(`videoFixIndex/${fixJob.originalVideoId}/${fixId}`)
        .update({status: "completed"}),
      // Update video fixCount (transaction for atomic increment)
      database
        .ref(`videos/${fixJob.originalVideoId}`)
        .transaction((currentData) => {
          if (currentData) {
            return {
              ...currentData,
              fixCount: (currentData.fixCount || 0) + 1,
            };
          }
          return currentData;
        }),
      // Store signature mapping for this successful copy too
      database
        .ref(
          `videoFixSignatures/${fixJob.originalVideoId}/${fixJob.fixSignature}`
        )
        .set(fixId),
      CacheService.cacheVideoFixResult(fixId, fixResult),
      CacheService.cacheVideoFixSignature(
        fixJob.originalVideoId,
        fixJob.fixSignature,
        fixId
      ),
    ]);

    logger.info("video:fix:copying:completed", {
      fixId,
      sourceFixId,
    });
  }

  /**
   * List all fixes for a video
   */
  static async listVideoFixes(
    userId: string,
    videoId: string
  ): Promise<VideoFixJobWithResult[]> {
    const videoSnapshot = await database.ref(`videos/${videoId}`).get();
    if (!videoSnapshot.exists()) {
      throw {error: "Not Found", message: "Video not found"};
    }

    if (videoSnapshot.val().userId !== userId) {
      throw {error: "Forbidden", message: "Access denied"};
    }

    const indexSnapshot = await database
      .ref(`videoFixIndex/${videoId}`)
      .orderByChild("version")
      .get();

    if (!indexSnapshot.exists()) {
      return [];
    }

    const fixIds: string[] = [];
    indexSnapshot.forEach((child) => {
      fixIds.push(child.key!);
    });

    const fixSnapshots = await Promise.all(
      fixIds.map((id) => database.ref(`videoFixes/${id}`).get())
    );

    const fixes: VideoFixJob[] = fixSnapshots
      .filter((s) => s.exists())
      .map((s) => s.val());

    // Attach results for completed fixes
    const fixesWithResults = await Promise.all(
      fixes.map(async (fix) => {
        if (fix.status !== "completed") {
          return fix as VideoFixJobWithResult;
        }

        // Try cache first
        const cachedResult =
          await CacheService.getVideoFixResult<VideoFixResult>(fix.fixId);
        if (cachedResult) {
          return {...fix, result: cachedResult} as VideoFixJobWithResult;
        }

        // Fall back to database
        const resultSnapshot = await database
          .ref(`videoFixResults/${fix.fixId}`)
          .get();

        if (resultSnapshot.exists()) {
          const result = resultSnapshot.val() as VideoFixResult;
          CacheService.cacheVideoFixResult(fix.fixId, result);
          return {...fix, result} as VideoFixJobWithResult;
        }

        return fix as VideoFixJobWithResult;
      })
    );

    return fixesWithResults.sort((a, b) => (b.version || 0) - (a.version || 0));
  }

  /**
   * Get a specific fix result
   */
  static async getVideoFixResult(
    userId: string,
    videoId: string,
    fixId: string
  ): Promise<{fix: VideoFixJob; result?: VideoFixResult}> {
    const fixSnapshot = await database.ref(`videoFixes/${fixId}`).get();
    if (!fixSnapshot.exists()) {
      throw {error: "Not Found", message: "Fix not found"};
    }

    const fix: VideoFixJob = fixSnapshot.val();

    if (fix.userId !== userId) {
      throw {error: "Forbidden", message: "Access denied"};
    }

    if (fix.originalVideoId !== videoId) {
      throw {
        error: "Bad Request",
        message: "Fix does not belong to this video",
      };
    }

    let result: VideoFixResult | undefined;

    if (fix.status === "completed") {
      // Try cache first
      result =
        (await CacheService.getVideoFixResult<VideoFixResult>(fixId)) ||
        undefined;

      if (!result) {
        const resultSnapshot = await database
          .ref(`videoFixResults/${fixId}`)
          .get();
        if (resultSnapshot.exists()) {
          result = resultSnapshot.val();
          CacheService.cacheVideoFixResult(fixId, result);
        }
      }
    }

    return {fix, result};
  }

  /**
   * Delete a video fix
   */
  static async deleteVideoFix(
    userId: string,
    videoId: string,
    fixId: string
  ): Promise<void> {
    const fixSnapshot = await database.ref(`videoFixes/${fixId}`).get();
    if (!fixSnapshot.exists()) {
      throw {error: "Not Found", message: "Fix not found"};
    }

    const fix: VideoFixJob = fixSnapshot.val();

    if (fix.userId !== userId) {
      throw {error: "Forbidden", message: "Access denied"};
    }

    if (fix.originalVideoId !== videoId) {
      throw {
        error: "Bad Request",
        message: "Fix does not belong to this video",
      };
    }

    // Delete storage files if completed
    if (fix.status === "completed") {
      await StorageService.deleteFixedVideo(userId, fixId).catch(() => {});
    }

    // Delete from database
    await Promise.all([
      database.ref(`videoFixes/${fixId}`).remove(),
      database.ref(`videoFixResults/${fixId}`).remove(),
      database.ref(`videoFixIndex/${videoId}/${fixId}`).remove(),
      database
        .ref(`videoFixSignatures/${videoId}/${fix.fixSignature}`)
        .remove(),
    ]);

    // Invalidate cache
    CacheService.invalidateVideoFixCache(fixId, videoId, fix.fixSignature);

    logger.info("video:fix:deleted", {fixId, videoId, userId});
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private static async getPendingFixesCount(userId: string): Promise<number> {
    const fixesSnapshot = await database
      .ref("videoFixes")
      .orderByChild("userId")
      .equalTo(userId)
      .get();

    if (!fixesSnapshot.exists()) {
      return 0;
    }

    let count = 0;
    fixesSnapshot.forEach((child) => {
      const fix: VideoFixJob = child.val();
      if (fix.status === "pending" || fix.status === "processing") {
        count++;
      }
    });

    return count;
  }

  private static async getNextVersion(videoId: string): Promise<number> {
    const indexSnapshot = await database.ref(`videoFixIndex/${videoId}`).get();
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
   * Get representative frame indices at 10%, 50%, 90% of video for general fixes
   */
  private static getRepresentativeFrameIndices(
    frames: FrameAnalysis[]
  ): number[] {
    if (frames.length === 0) return [];
    if (frames.length === 1) return [0];

    const indices: number[] = [];
    for (const percentage of VIDEO_REPRESENTATIVE_FRAMES) {
      const index = Math.min(
        Math.floor(frames.length * percentage),
        frames.length - 1
      );
      if (!indices.includes(index)) {
        indices.push(index);
      }
    }

    return indices.sort((a, b) => a - b);
  }

  /**
   * Extended FrameProblem with frame context for fix processing
   */
  private static frameProblemToExtended(
    problem: FrameProblem,
    frame: ProblemFrame
  ): FrameProblem & {
    frameIndex: number;
    timestamp: number;
    frameStoragePath: string;
  } {
    return {
      ...problem,
      frameIndex: frame.frameIndex,
      timestamp: frame.timestamp,
      frameStoragePath: frame.frameStoragePath,
    };
  }

  /**
   * Validate and get problems from categorized problems
   * Supports both old (frameSpecific) and new (problemFrames) structures
   */
  private static validateAndGetProblems(
    analysis: VideoAnalysis,
    fixScope: VideoFixScope,
    generalProblemIds?: string[],
    frameFixes?: FrameFixSelection[]
  ): {
    generalProblems: GeneralProblem[];
    frameProblems: Map<
      number,
      (FrameProblem & {
        frameIndex: number;
        timestamp: number;
        frameStoragePath: string;
      })[]
    >;
    dimensions: string[];
    allProblemIds: string[];
  } {
    const generalProblems: GeneralProblem[] = [];
    const frameProblems = new Map<
      number,
      Array<
        FrameProblem & {
          frameIndex: number;
          timestamp: number;
          frameStoragePath: string;
        }
      >
    >();
    const dimensions = new Set<string>();
    const allProblemIds: string[] = [];

    const {categorizedProblems} = analysis;

    // Support both old (frameSpecific) and new (problemFrames) structures
    const problemFrames: ProblemFrame[] =
      categorizedProblems.problemFrames || [];

    // Handle legacy frameSpecific data by converting to problemFrames format
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const legacyFrameSpecific = (categorizedProblems as any).frameSpecific as any[] | undefined;
    if (
      legacyFrameSpecific &&
      legacyFrameSpecific.length > 0 &&
      problemFrames.length === 0
    ) {
      // Convert old frameSpecific to problemFrames format
      const frameMap = new Map<number, ProblemFrame>();
      for (const oldProblem of legacyFrameSpecific) {
        const frameIndex = oldProblem.frameIndex ?? 0;
        let pf = frameMap.get(frameIndex);
        if (!pf) {
          pf = {
            frameId: `legacy_pf_${frameIndex}`,
            frameIndex,
            timestamp: oldProblem.timestamp ?? 0,
            frameStoragePath: oldProblem.frameStoragePath ?? "",
            problems: [],
          };
          frameMap.set(frameIndex, pf);
        }
        pf.problems.push({
          problemId: oldProblem.problemId,
          dimension: oldProblem.dimension,
          title: oldProblem.title,
          description: oldProblem.description,
          impact: oldProblem.impact,
          research: oldProblem.research,
          severity: oldProblem.severity,
          solution: oldProblem.solution,
        });
      }
      problemFrames.push(...frameMap.values());
    }

    // Build a lookup map for problemFrames by frameId
    const frameByIdMap = new Map<string, ProblemFrame>();
    for (const pf of problemFrames) {
      frameByIdMap.set(pf.frameId, pf);
    }

    if (fixScope === "all") {
      // Include all general problems
      for (const problem of categorizedProblems.general || []) {
        generalProblems.push(problem);
        dimensions.add(problem.dimension);
        allProblemIds.push(problem.problemId);
      }

      // Include all problems from all problemFrames
      for (const pf of problemFrames) {
        const existing = frameProblems.get(pf.frameIndex) || [];
        for (const problem of pf.problems) {
          existing.push(this.frameProblemToExtended(problem, pf));
          dimensions.add(problem.dimension);
          allProblemIds.push(problem.problemId);
        }
        frameProblems.set(pf.frameIndex, existing);
      }
    } else {
      // Handle selected general problems
      if (generalProblemIds?.length) {
        for (const problemId of generalProblemIds) {
          const problem = (categorizedProblems.general || []).find(
            (p) => p.problemId === problemId
          );
          if (problem) {
            generalProblems.push(problem);
            dimensions.add(problem.dimension);
            allProblemIds.push(problem.problemId);
          } else {
            logger.warn("video:fix:general-problem-not-found", {
              problemId,
              availableIds: (categorizedProblems.general || []).map(
                (p) => p.problemId
              ),
            });
          }
        }
      }

      // Handle frame-level selections (using frameId)
      if (frameFixes?.length) {
        for (const frameFix of frameFixes) {
          const problemFrame = frameByIdMap.get(frameFix.frameId);
          if (!problemFrame) {
            logger.warn("video:fix:frame-not-found", {
              frameId: frameFix.frameId,
            });
            continue;
          }

          for (const problemId of frameFix.problemIds) {
            const problem = problemFrame.problems.find(
              (p) => p.problemId === problemId
            );
            if (problem) {
              const existing = frameProblems.get(problemFrame.frameIndex) || [];
              if (!existing.find((p) => p.problemId === problemId)) {
                existing.push(
                  this.frameProblemToExtended(problem, problemFrame)
                );
                frameProblems.set(problemFrame.frameIndex, existing);
              }
              dimensions.add(problem.dimension);
              if (!allProblemIds.includes(problem.problemId)) {
                allProblemIds.push(problem.problemId);
              }
            } else {
              logger.warn("video:fix:frame-problem-not-found", {
                frameId: frameFix.frameId,
                problemId,
                availableIds: problemFrame.problems.map((p) => p.problemId),
              });
            }
          }
        }
      }
    }

    if (allProblemIds.length === 0 && fixScope !== "all") {
      throw {
        error: "Bad Request",
        message:
          "No valid problems selected. Use generalProblemIds or frameFixes.",
      };
    }

    return {
      generalProblems,
      frameProblems,
      dimensions: Array.from(dimensions),
      allProblemIds,
    };
  }

  private static calculateFixedScores(
    analysis: VideoAnalysis,
    problemIds: string[],
    scope: VideoFixScope
  ): {fixedScore: number; fixedDimensionScores: VideoDimensionScores} {
    const dimKeys = [
      "lighting",
      "spatial",
      "color",
      "clutter",
      "biophilic",
      "fengShui",
    ] as const;

    const fixedDimensionScores: Record<string, number> = {};

    // Get all problems from categorizedProblems (general + all problems from problemFrames)
    const allProblems: Array<{
      problemId: string;
      dimension: string;
      severity: string;
    }> = [...(analysis.categorizedProblems.general || [])];

    // Support both new problemFrames and legacy frameSpecific
    const problemFrames = analysis.categorizedProblems.problemFrames || [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const legacyFrameSpecific = (analysis.categorizedProblems as any).frameSpecific as any[] | undefined;

    // Flatten problems from problemFrames
    for (const pf of problemFrames) {
      for (const problem of pf.problems) {
        allProblems.push(problem);
      }
    }

    // Also include legacy frameSpecific problems
    if (legacyFrameSpecific) {
      for (const problem of legacyFrameSpecific) {
        allProblems.push(problem);
      }
    }

    for (const dim of dimKeys) {
      const dimAnalysis = analysis.dimensions[dim];
      const originalScore = dimAnalysis.score;

      // Get problems for this dimension
      const problemsInDim = allProblems.filter((p) => p.dimension === dim);

      if (problemsInDim.length === 0) {
        fixedDimensionScores[dim] = Math.max(originalScore, 90);
        continue;
      }

      const fixedProblemsInDim = problemsInDim.filter((p) =>
        problemIds.includes(p.problemId)
      );

      if (fixedProblemsInDim.length === 0) {
        fixedDimensionScores[dim] = originalScore;
        continue;
      }

      // Calculate points gained from fixing problems
      let pointsGained = 0;
      for (const problem of fixedProblemsInDim) {
        pointsGained +=
          problem.severity === "high"
            ? 15
            : problem.severity === "medium"
              ? 10
              : 5;
      }

      // If all problems in dimension fixed, score goes higher
      if (fixedProblemsInDim.length === problemsInDim.length) {
        fixedDimensionScores[dim] = Math.min(
          100,
          Math.max(95, originalScore + pointsGained)
        );
      } else {
        fixedDimensionScores[dim] = Math.min(90, originalScore + pointsGained);
      }
    }

    const totalScore = dimKeys.reduce(
      (sum, dim) => sum + fixedDimensionScores[dim],
      0
    );
    let fixedScore = Math.round(totalScore / 6);

    // If fixing all problems, ensure high score
    if (scope === "all") {
      fixedScore = Math.max(fixedScore, 95);
    }

    return {
      fixedScore,
      fixedDimensionScores:
        fixedDimensionScores as unknown as VideoDimensionScores,
    };
  }
}
