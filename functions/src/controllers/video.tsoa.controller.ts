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
import {VideoService} from "../services/video.service";
import {UserService} from "../services/user.service";
import {ContentModerationError} from "../services/ai.service";
import {VIDEO_CREDIT_COST, MAX_CONTENT_VIOLATIONS} from "../config/constants";
import {
  VideoUploadResponse,
  VideoListResponse,
  VideoAnalysisResponse,
} from "../types/video.types";
import {ErrorResponse} from "../types/api.types";
import {AuthUser} from "../middleware/tsoa-auth.middleware";
import * as logger from "firebase-functions/logger";

@Route("v1/videos")
@Tags("Videos")
@Security("BearerAuth")
export class VideoController extends Controller {
  /**
   * Upload a video walkthrough for AI-powered room analysis.
   * Supported formats: MP4, MOV, WebM. Maximum size: 50MB. Maximum duration: 60 seconds.
   * Analysis runs asynchronously via Pub/Sub - use the analysis endpoint to check status.
   * Consumes 2 credits after successful upload.
   * @summary Upload a video for analysis
   * @param video Video file (MP4, MOV, or WebM)
   */
  @Post("upload")
  @SuccessResponse(201, "Video uploaded and queued for analysis")
  @Response<ErrorResponse>(400, "Bad request - no file or invalid type")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(403, "Forbidden - not enough credits")
  @Response<ErrorResponse>(413, "Video file too large")
  @Response<ErrorResponse>(500, "Internal server error")
  public async uploadVideo(
    @Request() request: ExpressRequest,
    @UploadedFile() video: Express.Multer.File
  ): Promise<VideoUploadResponse> {
    const user = request.user as AuthUser;

    // Reserve credits upfront (atomic check + deduct)
    try {
      await UserService.reserveBetaCredits(
        user.uid,
        VIDEO_CREDIT_COST,
        "video_analysis",
        "video-upload"
      );
    } catch (error: unknown) {
      const err = error as {error?: string};
      if (err.error === "Beta Limit Reached") {
        this.setStatus(403);
      }
      throw error;
    }

    // Check if file exists
    if (!video) {
      this.setStatus(400);
      throw {error: "Bad Request", message: "No video file provided"};
    }

    const {buffer, originalname, mimetype, size} = video;

    // Validate video
    const validation = VideoService.validateVideo(buffer, mimetype);
    if (!validation.valid) {
      this.setStatus(validation.errorCode === "FILE_TOO_LARGE" ? 413 : 400);
      throw {
        error:
          validation.errorCode === "FILE_TOO_LARGE"
            ? "Payload Too Large"
            : "Bad Request",
        message: validation.error,
      };
    }

    try {
      // Upload video and queue for processing
      const result = await VideoService.uploadVideo({
        userId: user.uid,
        videoBuffer: buffer,
        originalName: originalname,
        mimeType: mimetype,
      });

      logger.info("video:upload:success", {
        userId: user.uid,
        videoId: result.videoId,
        size,
        credits: VIDEO_CREDIT_COST,
      });

      this.setStatus(201);
      return {
        message: "Video uploaded successfully. Analysis queued.",
        video: {
          videoId: result.videoId,
          videoStoragePath: result.videoStoragePath,
          thumbnailStoragePath: result.thumbnailStoragePath,
          duration: result.duration,
          uploadedAt: result.uploadedAt,
        },
        status: "queued",
        creditsUsed: VIDEO_CREDIT_COST,
      };
    } catch (error) {
      // Handle content moderation rejection
      if (error instanceof ContentModerationError) {
        if (error.category !== "error") {
          const violationCount = await UserService.recordContentViolation(
            user.uid,
            error.category
          );

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

      // Re-throw known errors
      if ((error as {error?: string}).error) {
        throw error;
      }

      logger.error("video:upload:failed", {
        userId: user.uid,
        error: error instanceof Error ? error.message : String(error),
      });

      this.setStatus(500);
      throw {error: "Internal Server Error", message: "Failed to upload video"};
    }
  }

  /**
   * Retrieve AI analysis results for a video.
   * Returns status (pending/queued/extracting/moderating/analyzing/aggregating/completed/failed)
   * and analysis data when ready, including timeline markers.
   * @summary Get video analysis results
   * @param videoId Unique video identifier
   */
  @Get("{videoId}/analysis")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(403, "Forbidden - not the owner")
  @Response<ErrorResponse>(404, "Video not found")
  @Response<ErrorResponse>(500, "Internal server error")
  public async getAnalysis(
    @Request() request: ExpressRequest,
    @Path() videoId: string
  ): Promise<VideoAnalysisResponse> {
    const user = request.user as AuthUser;

    try {
      const {video, analysis} = await VideoService.getVideoAnalysis(
        user.uid,
        videoId
      );

      // Return appropriate response based on status
      switch (video.analysisStatus) {
        case "pending":
          return {
            status: "pending",
            message: "Video analysis not started yet",
          };

        case "queued":
          return {
            status: "queued",
            message: "Video is queued for processing",
          };

        case "extracting":
          return {
            status: "extracting",
            message: "Extracting frames from video...",
            progress: {
              currentFrame: 0,
              totalFrames: video.frameCount || 0,
              percentComplete: 10,
              currentStep: "extracting",
            },
          };

        case "moderating":
          return {
            status: "moderating",
            message: "Moderating video content...",
            progress: {
              currentFrame: video.frameCount || 0,
              totalFrames: video.frameCount || 0,
              percentComplete: 30,
              currentStep: "moderating",
            },
          };

        case "analyzing":
          return {
            status: "analyzing",
            message: "Analyzing room with AI...",
            progress: {
              currentFrame: video.frameCount || 0,
              totalFrames: video.frameCount || 0,
              percentComplete: 60,
              currentStep: "analyzing",
            },
          };

        case "aggregating":
          return {
            status: "aggregating",
            message: "Generating timeline and aggregating results...",
            progress: {
              currentFrame: video.frameCount || 0,
              totalFrames: video.frameCount || 0,
              percentComplete: 90,
              currentStep: "aggregating",
            },
          };

        case "failed":
          this.setStatus(500);
          return {
            status: "failed",
            error: video.error || "Video analysis failed",
          };

        case "completed":
          if (!analysis) {
            this.setStatus(404);
            throw {error: "Not Found", message: "Analysis results not found"};
          }

          return {
            status: "completed",
            video: {
              videoId: video.videoId,
              videoStoragePath: video.videoStoragePath,
              thumbnailStoragePath: video.thumbnailStoragePath,
              duration: video.duration,
              uploadedAt: video.uploadedAt,
            },
            analysis,
          };

        default:
          return {
            status: "pending",
            message: "Unknown status",
          };
      }
    } catch (error: unknown) {
      if ((error as {error?: string}).error) {
        const knownError = error as {error: string; message?: string};
        if (knownError.error === "Not Found") {
          this.setStatus(404);
        }
        throw error;
      }

      logger.error("video:analysis:get:failed", {
        userId: user.uid,
        videoId,
        error: error instanceof Error ? error.message : String(error),
      });

      this.setStatus(500);
      throw {error: "Internal Server Error", message: "Failed to get analysis"};
    }
  }

  /**
   * Get all videos uploaded by the authenticated user.
   * Videos are returned in reverse chronological order (newest first).
   * @summary List user's videos
   */
  @Get("")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(500, "Internal server error")
  public async listVideos(
    @Request() request: ExpressRequest
  ): Promise<VideoListResponse> {
    const user = request.user as AuthUser;

    if (!user?.uid) {
      this.setStatus(401);
      throw {error: "Unauthorized", message: "Invalid or missing auth token"};
    }

    try {
      const videos = await VideoService.listVideos(user.uid);
      return {videos};
    } catch (error) {
      logger.error("video:list:failed", {
        userId: user.uid,
        error: error instanceof Error ? error.message : String(error),
      });

      this.setStatus(500);
      throw {error: "Internal Server Error", message: "Failed to list videos"};
    }
  }
}
