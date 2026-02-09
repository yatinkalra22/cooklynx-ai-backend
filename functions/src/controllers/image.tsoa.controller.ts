import {
  Controller,
  Get,
  Post,
  Path,
  Request,
  Response,
  Route,
  Security,
  SuccessResponse,
  Tags,
  UploadedFile,
} from "tsoa";
import {Request as ExpressRequest} from "express";
import {database} from "../config/firebase.config";
import {StorageService} from "../services/storage.service";
import {AIService, ContentModerationError} from "../services/ai.service";
import {UserService} from "../services/user.service";
import {CacheService} from "../services/cache.service";
import {DedupService} from "../services/dedup.service";
import {CACHE_KEYS, CACHE_TTL} from "../config/redis.config";
import {MAX_CONTENT_VIOLATIONS, IMAGE_CREDIT_COST} from "../config/constants";
import {
  ImageUploadResponse,
  ImageListResponse,
  AnalysisResponse,
  ErrorResponse,
  ImageMetadata,
  RoomAnalysis,
} from "../types/api.types";
import {AuthUser} from "../middleware/tsoa-auth.middleware";
import * as logger from "firebase-functions/logger";

@Route("v1/images")
@Tags("Images")
@Security("BearerAuth")
export class ImageController extends Controller {
  /**
   * Upload a room image for AI-powered analysis.
   * Supported formats: JPEG, PNG, WebP. Maximum size: 10MB.
   * Analysis runs asynchronously - use the analysis endpoint to check status.
   * Consumes 1 credit after successful analysis.
   * @summary Upload an image for analysis
   * @param image Image file (JPEG, PNG, or WebP)
   */
  @Post("upload")
  @SuccessResponse(201, "Image uploaded successfully")
  @Response<ErrorResponse>(400, "Bad request - no file or invalid type")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(403, "Forbidden - beta limit reached")
  @Response<ErrorResponse>(413, "Image file too large")
  @Response<ErrorResponse>(500, "Internal server error")
  public async uploadImage(
    @Request() request: ExpressRequest,
    @UploadedFile() image: Express.Multer.File
  ): Promise<ImageUploadResponse> {
    const user = request.user as AuthUser;

    // Reserve credits upfront (atomic check + deduct)
    try {
      await UserService.reserveBetaCredits(
        user.uid,
        IMAGE_CREDIT_COST,
        "image_analysis",
        "image-upload"
      );
    } catch (error: unknown) {
      const err = error as {error?: string};
      if (err.error === "Beta Limit Reached") {
        this.setStatus(403);
      }
      throw error;
    }

    // Check if file exists
    if (!image) {
      this.setStatus(400);
      throw {error: "Bad Request", message: "No image file provided"};
    }

    const {buffer, originalname, mimetype, size} = image;

    // Validate file size (10MB max)
    const maxSize = parseInt(process.env.MAX_IMAGE_SIZE || "10485760");
    if (size > maxSize) {
      this.setStatus(413);
      throw {
        error: "Payload Too Large",
        message: `Image must be smaller than ${maxSize / 1024 / 1024}MB`,
      };
    }

    // Validate mime type
    const allowedTypes = (
      process.env.ALLOWED_MIME_TYPES || "image/jpeg,image/png,image/webp"
    ).split(",");

    if (!allowedTypes.includes(mimetype)) {
      this.setStatus(400);
      throw {
        error: "Bad Request",
        message: "Invalid file type. Allowed: JPEG, PNG, WebP",
      };
    }

    try {
      // ============================================
      // Step 1: Check for duplicate (before upload)
      // ============================================
      const dedupResult = await DedupService.checkDuplicate(user.uid, buffer);
      const isDuplicate = dedupResult.isDuplicate && dedupResult.sourceImageId;

      if (isDuplicate) {
        logger.info("dedup:duplicate_detected", {
          userId: user.uid,
          sourceImageId: dedupResult.sourceImageId,
          hash: dedupResult.hash.slice(0, 16),
        });
      }

      // ============================================
      // Step 2: Always upload image to storage
      // ============================================
      const imageMetadata = await StorageService.uploadImage({
        userId: user.uid,
        imageBuffer: buffer,
        originalName: originalname,
        mimeType: mimetype,
      });

      // ============================================
      // Step 3: Always create new image record
      // ============================================
      await database.ref(`images/${imageMetadata.imageId}`).set({
        imageId: imageMetadata.imageId,
        userId: imageMetadata.userId,
        storagePath: imageMetadata.storagePath,
        originalName: imageMetadata.originalName,
        mimeType: imageMetadata.mimeType,
        size: imageMetadata.size,
        width: imageMetadata.width,
        height: imageMetadata.height,
        uploadedAt: imageMetadata.uploadedAt,
        analysisStatus: isDuplicate ? "completed" : "pending",
        overallScore: 0,
        fixCount: 0,
        contentHash: dedupResult.hash,
        ...(isDuplicate ? {analysisSourceId: dedupResult.sourceImageId} : {}),
      });

      // Record hash index (first image with this hash wins)
      DedupService.recordImageHash(
        user.uid,
        imageMetadata.imageId,
        dedupResult.hash
      ).catch(() => {});

      // Increment user photo counter
      await UserService.incrementUserPhotoCounters(user.uid, {totalPhotos: 1});

      // Invalidate image list cache
      CacheService.delete(CACHE_KEYS.imageList(user.uid)).catch(() => {});
      CacheService.delete(CACHE_KEYS.assetList(user.uid)).catch(() => {});

      // ============================================
      // Step 4: Handle analysis (duplicate vs new)
      // ============================================
      if (isDuplicate && dedupResult.sourceImageId) {
        // DUPLICATE: Copy analysis from source (saves AI cost, but user still pays)
        const copied = await DedupService.copyAnalysis(
          dedupResult.sourceImageId,
          imageMetadata.imageId,
          user.uid
        );

        if (copied) {
          // Get the copied analysis score
          const analysisSnapshot = await database
            .ref(`analysis/${imageMetadata.imageId}`)
            .get();
          const analysis = analysisSnapshot.val();

          this.setStatus(201);
          return {
            message: "Image uploaded. Analysis copied from previous upload.",
            image: {
              imageId: imageMetadata.imageId,
              storagePath: imageMetadata.storagePath,
              width: imageMetadata.width,
              height: imageMetadata.height,
              uploadedAt: imageMetadata.uploadedAt,
            },
            status: "completed",
            isDuplicate: true,
            overallScore: analysis?.overall?.score,
          } as ImageUploadResponse;
        }

        // Copy failed - fall through to run new analysis
        logger.warn("dedup:copy_failed_fallback", {
          sourceImageId: dedupResult.sourceImageId,
          targetImageId: imageMetadata.imageId,
        });
      }

      // NEW IMAGE: Run AI analysis (credit already consumed above)

      // Start async analysis (don't wait for it)
      this.analyzeImageAsync(user.uid, imageMetadata.imageId).catch((error) => {
        logger.error("Analysis error:", error);
      });

      this.setStatus(201);
      return {
        message: "Image uploaded successfully. Analysis starting...",
        image: {
          imageId: imageMetadata.imageId,
          storagePath: imageMetadata.storagePath,
          width: imageMetadata.width,
          height: imageMetadata.height,
          uploadedAt: imageMetadata.uploadedAt,
        },
        status: "pending",
      };
    } catch (error) {
      // Handle content moderation rejection
      if (error instanceof ContentModerationError) {
        // Record violation (skip if it was a moderation system error)
        if (error.category !== "error") {
          const violationCount = await UserService.recordContentViolation(
            user.uid,
            error.category
          );

          // Include warning about account status
          const remaining = MAX_CONTENT_VIOLATIONS - violationCount;
          const warningMsg =
            remaining > 0
              ? ` Warning: ${remaining} more violation(s) will result in account suspension.`
              : " Your account has been suspended due to repeated violations.";

          this.setStatus(400);
          throw {
            error: "Content Policy Violation",
            message: error.message + warningMsg,
          };
        }

        this.setStatus(400);
        throw {
          error: "Content Policy Violation",
          message: error.message,
        };
      }

      this.setStatus(500);
      throw {error: "Internal Server Error", message: "Failed to upload image"};
    }
  }

  /**
   * Async analysis job (runs in background)
   * OPTIMIZED: Batches database operations + caches results
   */
  private async analyzeImageAsync(
    userId: string,
    imageId: string
  ): Promise<void> {
    try {
      // Update status to processing
      await database.ref(`images/${imageId}`).update({
        analysisStatus: "processing",
      });

      // Run AI analysis
      const analysis = await AIService.analyzeFood(userId, imageId);

      const analysisData = {
        imageId,
        userId,
        ...analysis,
      };

      // OPTIMIZATION: Batch all post-analysis database operations in parallel
      await Promise.all([
        // Save analysis results to database
        database.ref(`analysis/${imageId}`).set(analysisData),
        // Update image status to completed
        database.ref(`images/${imageId}`).update({
          analysisStatus: "completed",
          analyzedAt: new Date().toISOString(),
          // Food analysis doesn't have an overall score in the same way, 
          // but we can use the number of items or just 100 if successful
          overallScore: analysis.items.length > 0 ? 100 : 0,
        }),
        // Increment user's completed photos counter
        UserService.incrementUserPhotoCounters(userId, {
          totalPhotoCompleted: 1,
        }),
        // CACHE: Store analysis in Redis (24h TTL)
        CacheService.cacheAnalysis(imageId, analysisData),
        // Invalidate image metadata cache
        CacheService.delete(CACHE_KEYS.imageMetadata(imageId)),
      ]);

      logger.info("analysis:completed", {
        userId,
        imageId,
        itemsCount: analysis.items.length,
      });
    } catch (error) {
      logger.error("Analysis failed:", error);

      // OPTIMIZATION: Batch failure database operations in parallel
      await Promise.all([
        database.ref(`images/${imageId}`).update({
          analysisStatus: "failed",
          error: error instanceof Error ? error.message : "Analysis failed",
        }),
        UserService.incrementUserPhotoCounters(userId, {
          totalPhotoFailed: 1,
        }),
        // Invalidate any cached data for this image
        CacheService.delete(CACHE_KEYS.imageMetadata(imageId)),
      ]);
    }
  }

  /**
   * Get image metadata and details.
   * Returns full image information including storage path, dimensions, and analysis status.
   * @summary Get image details
   * @param imageId Unique image identifier
   */
  @Get("{imageId}")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(403, "Forbidden - not the owner")
  @Response<ErrorResponse>(404, "Image not found")
  @Response<ErrorResponse>(500, "Internal server error")
  public async getImage(
    @Request() request: ExpressRequest,
    @Path() imageId: string
  ): Promise<ImageMetadata> {
    const user = request.user as AuthUser;

    try {
      // Get image metadata
      const imageSnapshot = await database.ref(`images/${imageId}`).get();

      if (!imageSnapshot.exists()) {
        this.setStatus(404);
        throw {error: "Not Found", message: "Image not found"};
      }

      const imageData = imageSnapshot.val() as ImageMetadata;

      // Check ownership
      if (imageData.userId !== user.uid) {
        this.setStatus(403);
        throw {
          error: "Forbidden",
          message: "You do not have access to this image",
        };
      }

      return imageData;
    } catch (error: unknown) {
      if ((error as {error?: string}).error) {
        throw error;
      }
      this.setStatus(500);
      throw {
        error: "Internal Server Error",
        message: "Failed to get image details",
      };
    }
  }

  /**
   * Generate a fresh signed URL for an image.
   * Returns a fresh signed URL that expires in 7 days.
   * Call this endpoint to get a working download URL from the storagePath.
   * @summary Get fresh signed URL for image
   * @param imageId Unique image identifier
   */
  @Get("{imageId}/url")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(403, "Forbidden - not the owner")
  @Response<ErrorResponse>(404, "Image not found")
  @Response<ErrorResponse>(500, "Internal server error")
  public async getImageUrl(
    @Request() request: ExpressRequest,
    @Path() imageId: string
  ): Promise<{publicUrl: string}> {
    const user = request.user as AuthUser;

    try {
      // Get image metadata to verify ownership
      const imageSnapshot = await database.ref(`images/${imageId}`).get();

      if (!imageSnapshot.exists()) {
        this.setStatus(404);
        throw {error: "Not Found", message: "Image not found"};
      }

      const imageData = imageSnapshot.val();

      // Check ownership
      if (imageData.userId !== user.uid) {
        this.setStatus(403);
        throw {
          error: "Forbidden",
          message: "You do not have access to this image",
        };
      }

      // Generate fresh signed URL
      const publicUrl = await StorageService.getSignedUrl(user.uid, imageId);

      return {publicUrl};
    } catch (error: unknown) {
      if ((error as {error?: string}).error) {
        throw error;
      }
      this.setStatus(500);
      throw {
        error: "Internal Server Error",
        message: "Failed to generate image URL",
      };
    }
  }

  /**
   * Retrieve AI analysis results for an image.
   * Returns status (pending/processing/completed/failed) and analysis data when ready.
   * @summary Get image analysis results
   * @param imageId Unique image identifier
   */
  @Get("{imageId}/analysis")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(403, "Forbidden - not the owner")
  @Response<ErrorResponse>(404, "Image not found")
  @Response<ErrorResponse>(500, "Internal server error")
  public async getAnalysis(
    @Request() request: ExpressRequest,
    @Path() imageId: string
  ): Promise<AnalysisResponse> {
    const user = request.user as AuthUser;

    try {
      // Get image metadata
      const imageSnapshot = await database.ref(`images/${imageId}`).get();

      if (!imageSnapshot.exists()) {
        this.setStatus(404);
        throw {error: "Not Found", message: "Image not found"};
      }

      const imageData = imageSnapshot.val();

      // Check ownership
      if (imageData.userId !== user.uid) {
        this.setStatus(403);
        throw {
          error: "Forbidden",
          message: "You don't have access to this image",
        };
      }

      // Check analysis status
      if (imageData.analysisStatus === "pending") {
        return {
          status: "pending",
          message: "Analysis not started yet",
        };
      }

      if (imageData.analysisStatus === "processing") {
        return {
          status: "processing",
          message: "Analysis in progress. Please check back in a moment.",
        };
      }

      if (imageData.analysisStatus === "failed") {
        this.setStatus(500);
        return {
          status: "failed",
          error: imageData.error || "Analysis failed",
        };
      }

      // Get analysis results - check cache first
      const cacheKey = CACHE_KEYS.analysis(imageId);
      let analysis = await CacheService.getAnalysis<RoomAnalysis>(imageId);

      if (!analysis) {
        // Cache miss - fetch from database
        const analysisSnapshot = await database
          .ref(`analysis/${imageId}`)
          .get();

        if (!analysisSnapshot.exists()) {
          this.setStatus(404);
          throw {error: "Not Found", message: "Analysis results not found"};
        }

        analysis = analysisSnapshot.val() as RoomAnalysis;

        // Cache for future requests (fire-and-forget)
        CacheService.set(cacheKey, analysis, CACHE_TTL.ANALYSIS_RESULT).catch(
          () => {}
        );
      }

      return {
        status: "completed",
        image: {
          imageId: imageData.imageId,
          storagePath: imageData.storagePath,
          uploadedAt: imageData.uploadedAt,
        },
        analysis,
      };
    } catch (error: unknown) {
      if ((error as {error?: string}).error) {
        throw error;
      }
      this.setStatus(500);
      throw {error: "Internal Server Error", message: "Failed to get analysis"};
    }
  }

  /**
   * Get all images uploaded by the authenticated user.
   * Images are returned in reverse chronological order (newest first).
   * @summary List user's images
   */
  @Get("")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(500, "Internal server error")
  public async listImages(
    @Request() request: ExpressRequest
  ): Promise<ImageListResponse> {
    const user = request.user as AuthUser;

    if (!user?.uid) {
      this.setStatus(401);
      throw {error: "Unauthorized", message: "Invalid or missing auth token"};
    }

    try {
      // Check cache first for image list
      const cacheKey = CACHE_KEYS.imageList(user.uid);
      const cachedList = await CacheService.get<ImageListResponse>(cacheKey);

      if (cachedList) {
        return cachedList;
      }

      // Cache miss - query database
      const imagesSnapshot = await database
        .ref("images")
        .orderByChild("userId")
        .equalTo(user.uid)
        .get();

      if (!imagesSnapshot.exists()) {
        const emptyResult = {images: []};
        // Cache empty result with shorter TTL
        CacheService.set(
          cacheKey,
          emptyResult,
          CACHE_TTL.API_RESPONSE_SHORT
        ).catch(() => {});
        return emptyResult;
      }

      const images: ImageMetadata[] = [];
      imagesSnapshot.forEach((child) => {
        const value = child.val();
        if (!value || typeof value !== "object") {
          return;
        }
        images.push({
          ...(value as ImageMetadata),
          imageId: (value as ImageMetadata).imageId || child.key!,
        });
      });

      const result = {
        images: images.reverse(), // Newest first
      };

      // Cache the result
      CacheService.set(cacheKey, result, CACHE_TTL.IMAGE_LIST).catch(() => {});

      return result;
    } catch (error) {
      logger.error("Failed to list images:", error);
      this.setStatus(500);
      throw {error: "Internal Server Error", message: "Failed to list images"};
    }
  }
}
