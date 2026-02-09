/**
 * Video Service
 * Orchestrates video upload, processing, and status management
 */

import {database, storage, isEmulator} from "../config/firebase.config";
import {publishVideoAnalysisJob} from "../config/pubsub.config";
import {VideoAnalysisService} from "./video-analysis.service";
import {AIService, ContentModerationError} from "./ai.service";
import {UserService} from "./user.service";
import {CacheService} from "./cache.service";
import {CACHE_KEYS} from "../config/redis.config";
import {
  VIDEO_MAX_SIZE,
  VIDEO_MAX_DURATION,
  VIDEO_ALLOWED_MIME_TYPES,
} from "../config/constants";
import {
  VideoMetadata,
  VideoAnalysis,
  VideoAnalysisStatus,
} from "../types/video.types";
import * as logger from "firebase-functions/logger";
import * as crypto from "crypto";

interface UploadVideoOptions {
  userId: string;
  videoBuffer: Buffer;
  originalName: string;
  mimeType: string;
}

interface UploadVideoResult {
  videoId: string;
  videoStoragePath: string;
  thumbnailStoragePath: string;
  duration: number;
  uploadedAt: string;
}

export class VideoService {
  /**
   * Validate video file before upload
   */
  static validateVideo(
    buffer: Buffer,
    mimeType: string
  ): {
    valid: boolean;
    error?: string;
    errorCode?: "FILE_TOO_LARGE" | "INVALID_FORMAT";
  } {
    // Check file size
    if (buffer.length > VIDEO_MAX_SIZE) {
      return {
        valid: false,
        error: `Video must be smaller than ${VIDEO_MAX_SIZE / 1024 / 1024}MB`,
        errorCode: "FILE_TOO_LARGE",
      };
    }

    // Check mime type
    if (!VIDEO_ALLOWED_MIME_TYPES.includes(mimeType)) {
      return {
        valid: false,
        error: "Invalid video format. Allowed: MP4, MOV, WebM",
        errorCode: "INVALID_FORMAT",
      };
    }

    return {valid: true};
  }

  /**
   * Upload video and queue for processing
   */
  static async uploadVideo(
    options: UploadVideoOptions
  ): Promise<UploadVideoResult> {
    const {userId, videoBuffer, originalName, mimeType} = options;

    // Generate unique video ID
    const {v4: uuidv4} = await import("uuid");
    const videoId = `vid_${uuidv4()}`;

    // Generate content hash for deduplication
    const contentHash = crypto
      .createHash("sha256")
      .update(videoBuffer)
      .digest("hex")
      .slice(0, 32);

    // Extract thumbnail (first frame) and validate duration
    const validationResult =
      await VideoAnalysisService.validateAndExtractThumbnail(
        videoBuffer,
        mimeType
      );

    if (!validationResult.valid) {
      throw {
        error: "Bad Request",
        message: validationResult.error || "Invalid video file",
      };
    }

    if (
      validationResult.duration &&
      validationResult.duration > VIDEO_MAX_DURATION
    ) {
      throw {
        error: "Bad Request",
        message: `Video must be ${VIDEO_MAX_DURATION} seconds or shorter`,
      };
    }

    // Moderate thumbnail before proceeding
    if (validationResult.thumbnailBuffer) {
      await AIService.validateImageContent(validationResult.thumbnailBuffer);
    }

    // Upload video to Cloud Storage
    const bucket = storage.bucket();
    const downloadToken = isEmulator ? uuidv4() : undefined;

    // Upload video file
    const videoPath = `users/${userId}/videos/${videoId}/video.${this.getExtension(mimeType)}`;
    const videoFile = bucket.file(videoPath);
    await videoFile.save(videoBuffer, {
      metadata: {
        contentType: mimeType,
        metadata: {
          userId,
          videoId,
          originalName,
          uploadedAt: new Date().toISOString(),
          ...(downloadToken
            ? {firebaseStorageDownloadTokens: downloadToken}
            : {}),
        },
      },
      public: false,
    });

    // Upload thumbnail
    const thumbnailPath = `users/${userId}/videos/${videoId}/thumbnail.jpg`;
    const thumbnailFile = bucket.file(thumbnailPath);
    const thumbnailToken = isEmulator ? uuidv4() : undefined;

    if (validationResult.thumbnailBuffer) {
      await thumbnailFile.save(validationResult.thumbnailBuffer, {
        metadata: {
          contentType: "image/jpeg",
          metadata: {
            userId,
            videoId,
            ...(thumbnailToken
              ? {firebaseStorageDownloadTokens: thumbnailToken}
              : {}),
          },
        },
        public: false,
      });
    }

    // Don't generate signed URLs - store paths only
    const uploadedAt = new Date().toISOString();

    // Create video metadata record
    const videoMetadata: VideoMetadata = {
      videoId,
      userId,
      videoStoragePath: videoPath,
      thumbnailStoragePath: thumbnailPath,
      originalName,
      mimeType,
      size: videoBuffer.length,
      duration: validationResult.duration || 0,
      width: validationResult.width || 0,
      height: validationResult.height || 0,
      frameCount: 0,
      analysisStatus: "queued",
      overallScore: 0,
      uploadedAt,
      contentHash,
      fixCount: 0,
    };

    // Save to database
    await database.ref(`videos/${videoId}`).set(videoMetadata);

    // Invalidate caches
    await Promise.all([
      CacheService.delete(CACHE_KEYS.videoList(userId)),
      CacheService.delete(CACHE_KEYS.assetList(userId)),
    ]).catch(() => {});

    // Publish to Pub/Sub for async processing
    await publishVideoAnalysisJob(videoId, userId);

    logger.info("video:uploaded", {
      videoId,
      userId,
      size: videoBuffer.length,
      duration: validationResult.duration,
    });

    return {
      videoId,
      videoStoragePath: videoPath,
      thumbnailStoragePath: thumbnailPath,
      duration: validationResult.duration || 0,
      uploadedAt,
    };
  }

  /**
   * Process video analysis (called by Pub/Sub worker)
   */
  static async processVideo(videoId: string, userId: string): Promise<void> {
    logger.info("video:processing:start", {videoId, userId});

    try {
      // Get video metadata
      const videoSnapshot = await database.ref(`videos/${videoId}`).get();
      if (!videoSnapshot.exists()) {
        throw new Error(`Video not found: ${videoId}`);
      }

      const video: VideoMetadata = videoSnapshot.val();

      // Verify ownership
      if (video.userId !== userId) {
        throw new Error("Video ownership mismatch");
      }

      // Update status to extracting
      await this.updateVideoStatus(videoId, "extracting");

      // Download video from storage using the path
      const bucket = storage.bucket();
      const [videoBuffer] = await bucket
        .file(video.videoStoragePath)
        .download();

      // Extract frames
      const frames = await VideoAnalysisService.extractFrames(
        videoBuffer,
        video.mimeType,
        videoId,
        userId
      );

      // Update frame count
      await database
        .ref(`videos/${videoId}`)
        .update({frameCount: frames.length});

      // Update status to moderating
      await this.updateVideoStatus(videoId, "moderating");

      // Moderate all frames in batches
      await VideoAnalysisService.moderateFrames(frames);

      // Update status to analyzing
      await this.updateVideoStatus(videoId, "analyzing");

      // Analyze video with Gemini 1.5 Pro
      const analysis = await VideoAnalysisService.analyzeVideo(
        videoBuffer,
        video.mimeType,
        frames,
        videoId,
        userId
      );

      // Update status to aggregating
      await this.updateVideoStatus(videoId, "aggregating");

      // Save analysis results
      await Promise.all([
        database.ref(`videoAnalysis/${videoId}`).set(analysis),
        database.ref(`videos/${videoId}`).update({
          analysisStatus: "completed",
          analyzedAt: new Date().toISOString(),
          overallScore: analysis.overall.score,
        }),
        UserService.incrementUserPhotoCounters(userId, {
          totalPhotoCompleted: 1,
        }),
        CacheService.delete(CACHE_KEYS.imageList(userId)),
        CacheService.delete(CACHE_KEYS.videoList(userId)),
        CacheService.delete(CACHE_KEYS.assetList(userId)),
      ]);

      logger.info("video:processing:completed", {
        videoId,
        userId,
        score: analysis.overall.score,
        timelineMarkers: analysis.timeline.length,
      });
    } catch (error) {
      logger.error("video:processing:failed", {
        videoId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Handle content moderation error
      if (
        error instanceof ContentModerationError &&
        error.category !== "error"
      ) {
        await UserService.recordContentViolation(userId, error.category);
      }

      // Update status to failed
      await database.ref(`videos/${videoId}`).update({
        analysisStatus: "failed",
        error:
          error instanceof Error ? error.message : "Video processing failed",
      });

      // Do not re-throw error to prevent infinite Pub/Sub retries
      // The error is already handled (logged + DB updated)
    }
  }

  /**
   * Get video metadata
   */
  static async getVideo(
    userId: string,
    videoId: string
  ): Promise<VideoMetadata | null> {
    const snapshot = await database.ref(`videos/${videoId}`).get();
    if (!snapshot.exists()) {
      return null;
    }

    const video: VideoMetadata = snapshot.val();
    if (video.userId !== userId) {
      return null;
    }

    return video;
  }

  /**
   * Get video analysis results
   */
  static async getVideoAnalysis(
    userId: string,
    videoId: string
  ): Promise<{video: VideoMetadata; analysis?: VideoAnalysis}> {
    const video = await this.getVideo(userId, videoId);
    if (!video) {
      throw {error: "Not Found", message: "Video not found"};
    }

    if (video.analysisStatus !== "completed") {
      return {video};
    }

    const analysisSnapshot = await database
      .ref(`videoAnalysis/${videoId}`)
      .get();
    const analysis = analysisSnapshot.exists()
      ? (analysisSnapshot.val() as VideoAnalysis)
      : undefined;

    return {video, analysis};
  }

  /**
   * List user's videos
   */
  static async listVideos(userId: string): Promise<VideoMetadata[]> {
    const snapshot = await database
      .ref("videos")
      .orderByChild("userId")
      .equalTo(userId)
      .get();

    if (!snapshot.exists()) {
      return [];
    }

    const videos: VideoMetadata[] = [];
    snapshot.forEach((child) => {
      videos.push(child.val());
    });

    // Sort by upload date, newest first
    videos.sort(
      (a, b) =>
        new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
    );

    return videos;
  }

  /**
   * Update video analysis status
   */
  private static async updateVideoStatus(
    videoId: string,
    status: VideoAnalysisStatus
  ): Promise<void> {
    await database.ref(`videos/${videoId}`).update({analysisStatus: status});
  }

  /**
   * Get file extension from mime type
   */
  private static getExtension(mimeType: string): string {
    const extensions: Record<string, string> = {
      "video/mp4": "mp4",
      "video/quicktime": "mov",
      "video/webm": "webm",
    };
    return extensions[mimeType] || "mp4";
  }
}
