import {
  Controller,
  Get,
  Post,
  Delete,
  Path,
  Body,
  Request,
  Response,
  Route,
  Security,
  SuccessResponse,
  Tags,
} from "tsoa";
import {Request as ExpressRequest} from "express";
import {VideoFixService} from "../services/video-fix.service";
import {UserService} from "../services/user.service";
import {VIDEO_FIX_CREDIT_COST} from "../config/constants";
import {
  CreateVideoFixRequest,
  CreateVideoFixResponse,
  VideoFixStatusResponse,
  VideoFixListResponse,
  DeleteVideoFixResponse,
} from "../types/video.types";
import {ErrorResponse} from "../types/api.types";
import {AuthUser} from "../middleware/tsoa-auth.middleware";
import * as logger from "firebase-functions/logger";

@Route("v1/videos")
@Tags("VideoFixes")
@Security("BearerAuth")
export class VideoFixController extends Controller {
  /**
   * Create a fix request for a video.
   * Processing happens asynchronously via Pub/Sub - poll the GET endpoint for results.
   * Consumes 2 credits on completion (not on request).
   * Uses deduplication to avoid re-processing identical fix requests.
   * @summary Create video fix request
   * @param videoId Unique video identifier
   * @param body Fix request parameters
   */
  @Post("{videoId}/fixes")
  @SuccessResponse(201, "Fix job created")
  @Response<ErrorResponse>(400, "Bad request - invalid parameters")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(403, "Forbidden - not the owner or not enough credits")
  @Response<ErrorResponse>(404, "Video not found")
  @Response<ErrorResponse>(429, "Too many concurrent fixes")
  @Response<ErrorResponse>(500, "Internal server error")
  public async createFix(
    @Request() request: ExpressRequest,
    @Path() videoId: string,
    @Body() body: CreateVideoFixRequest
  ): Promise<CreateVideoFixResponse> {
    const user = request.user as AuthUser;

    // Reserve credits upfront (atomic check + deduct)
    try {
      await UserService.reserveBetaCredits(
        user.uid,
        VIDEO_FIX_CREDIT_COST,
        "video_fix",
        videoId
      );
    } catch (error: unknown) {
      const err = error as {error?: string};
      if (err.error === "Beta Limit Reached") {
        this.setStatus(403);
      }
      throw error;
    }

    try {
      const result = await VideoFixService.createVideoFix({
        userId: user.uid,
        videoId,
        fixScope: body.fixScope === "all" ? "all" : "selected",
        generalProblemIds: body.generalProblemIds,
        frameFixes: body.frameFixes,
      });

      logger.info("video:fix:request:created", {
        userId: user.uid,
        videoId,
        fixId: result.fixId,
        isCached: result.isCached,
      });

      this.setStatus(201);
      return {
        fixId: result.fixId,
        status: result.status,
        message: result.isCached
          ? "Fix job created (cached result available)"
          : "Fix job created and queued for processing",
        isCached: result.isCached,
      };
    } catch (error: unknown) {
      const err = error as {error?: string};

      if (err.error === "Not Found") {
        this.setStatus(404);
        throw error;
      }
      if (err.error === "Forbidden") {
        this.setStatus(403);
        throw error;
      }
      if (err.error === "Bad Request") {
        this.setStatus(400);
        throw error;
      }
      if (err.error === "Too Many Requests") {
        this.setStatus(429);
        throw error;
      }

      logger.error("video:fix:create:failed", {
        userId: user.uid,
        videoId,
        error: error instanceof Error ? error.message : String(error),
      });

      this.setStatus(500);
      throw {
        error: "Internal Server Error",
        message: "Failed to create video fix",
      };
    }
  }

  /**
   * Get the status and result of a video fix.
   * Poll this endpoint to check if the fix has completed.
   * @summary Get video fix status/result
   * @param videoId Unique video identifier
   * @param fixId Unique fix identifier
   */
  @Get("{videoId}/fixes/{fixId}")
  @Response<ErrorResponse>(400, "Bad request")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(403, "Forbidden - not the owner")
  @Response<ErrorResponse>(404, "Fix not found")
  @Response<ErrorResponse>(500, "Internal server error")
  public async getFixStatus(
    @Request() request: ExpressRequest,
    @Path() videoId: string,
    @Path() fixId: string
  ): Promise<VideoFixStatusResponse> {
    const user = request.user as AuthUser;

    try {
      const {fix, result} = await VideoFixService.getVideoFixResult(
        user.uid,
        videoId,
        fixId
      );

      switch (fix.status) {
        case "pending":
          return {
            status: "pending",
            fixId: fix.fixId,
            message: "Fix job is pending",
          };

        case "processing":
          return {
            status: "processing",
            fixId: fix.fixId,
            message: "Fix is being processed",
          };

        case "failed":
          return {
            status: "failed",
            fixId: fix.fixId,
            error: fix.error || "Fix failed",
          };

        case "completed":
          if (!result) {
            this.setStatus(500);
            throw {
              error: "Internal Server Error",
              message: "Fix result not found",
            };
          }
          return {
            status: "completed",
            fix,
            result,
          };

        default:
          return {
            status: "pending",
            fixId: fix.fixId,
            message: "Unknown status",
          };
      }
    } catch (error: unknown) {
      const err = error as {error?: string};

      if (err.error === "Not Found") {
        this.setStatus(404);
        throw error;
      }
      if (err.error === "Forbidden") {
        this.setStatus(403);
        throw error;
      }
      if (err.error === "Bad Request") {
        this.setStatus(400);
        throw error;
      }

      logger.error("video:fix:get:failed", {
        userId: user.uid,
        videoId,
        fixId,
        error: error instanceof Error ? error.message : String(error),
      });

      this.setStatus(500);
      throw {
        error: "Internal Server Error",
        message: "Failed to get video fix",
      };
    }
  }

  /**
   * List all fixes for a video.
   * Returns fixes sorted by version (newest first).
   * @summary List video fixes
   * @param videoId Unique video identifier
   */
  @Get("{videoId}/fixes")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(403, "Forbidden - not the owner")
  @Response<ErrorResponse>(404, "Video not found")
  @Response<ErrorResponse>(500, "Internal server error")
  public async listFixes(
    @Request() request: ExpressRequest,
    @Path() videoId: string
  ): Promise<VideoFixListResponse> {
    const user = request.user as AuthUser;

    try {
      const fixes = await VideoFixService.listVideoFixes(user.uid, videoId);
      return {fixes};
    } catch (error: unknown) {
      const err = error as {error?: string};

      if (err.error === "Not Found") {
        this.setStatus(404);
        throw error;
      }
      if (err.error === "Forbidden") {
        this.setStatus(403);
        throw error;
      }

      logger.error("video:fix:list:failed", {
        userId: user.uid,
        videoId,
        error: error instanceof Error ? error.message : String(error),
      });

      this.setStatus(500);
      throw {
        error: "Internal Server Error",
        message: "Failed to list video fixes",
      };
    }
  }

  /**
   * Delete a video fix.
   * @summary Delete video fix
   * @param videoId Unique video identifier
   * @param fixId Unique fix identifier
   */
  @Delete("{videoId}/fixes/{fixId}")
  @Response<ErrorResponse>(400, "Bad request")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(403, "Forbidden - not the owner")
  @Response<ErrorResponse>(404, "Fix not found")
  @Response<ErrorResponse>(500, "Internal server error")
  public async deleteFix(
    @Request() request: ExpressRequest,
    @Path() videoId: string,
    @Path() fixId: string
  ): Promise<DeleteVideoFixResponse> {
    const user = request.user as AuthUser;

    try {
      await VideoFixService.deleteVideoFix(user.uid, videoId, fixId);

      logger.info("video:fix:deleted", {
        userId: user.uid,
        videoId,
        fixId,
      });

      return {message: "Video fix deleted successfully"};
    } catch (error: unknown) {
      const err = error as {error?: string};

      if (err.error === "Not Found") {
        this.setStatus(404);
        throw error;
      }
      if (err.error === "Forbidden") {
        this.setStatus(403);
        throw error;
      }
      if (err.error === "Bad Request") {
        this.setStatus(400);
        throw error;
      }

      logger.error("video:fix:delete:failed", {
        userId: user.uid,
        videoId,
        fixId,
        error: error instanceof Error ? error.message : String(error),
      });

      this.setStatus(500);
      throw {
        error: "Internal Server Error",
        message: "Failed to delete video fix",
      };
    }
  }
}
