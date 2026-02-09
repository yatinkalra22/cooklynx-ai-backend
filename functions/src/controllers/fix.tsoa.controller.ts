import {
  Controller,
  Get,
  Post,
  Delete,
  Path,
  Body,
  Query,
  Request,
  Response,
  Route,
  Security,
  SuccessResponse,
  Tags,
} from "tsoa";
import {Request as ExpressRequest} from "express";
import {FixService} from "../services/fix.service";
import {UserService} from "../services/user.service";
import {IMAGE_FIX_CREDIT_COST} from "../config/constants";
import {
  CreateFixRequest,
  CreateFixResponse,
  FixStatusResponse,
  FixListResponse,
  DeleteFixResponse,
  ErrorResponse,
} from "../types/api.types";
import {AuthUser} from "../middleware/tsoa-auth.middleware";

@Route("v1/images")
@Tags("Fixes")
@Security("BearerAuth")
export class FixController extends Controller {
  /**
   * Create a fix request to generate an improved version of the room image.
   * Fixes run asynchronously - use the status endpoint to check progress.
   * Consumes 1 credit after successful fix creation.
   * @summary Create fix request
   * @param imageId Image ID to fix
   * @param body Fix request details
   */
  @Post("{imageId}/fixes")
  @SuccessResponse(202, "Fix request accepted")
  @Response<ErrorResponse>(400, "Bad request - invalid parameters")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(
    403,
    "Forbidden - not the owner or beta limit reached"
  )
  @Response<ErrorResponse>(404, "Image not found")
  @Response<ErrorResponse>(429, "Too many concurrent fixes")
  @Response<ErrorResponse>(500, "Internal server error")
  public async createFix(
    @Request() request: ExpressRequest,
    @Path() imageId: string,
    @Body() body: CreateFixRequest,
    @Query() includeFixesList?: boolean
  ): Promise<CreateFixResponse> {
    const user = request.user as AuthUser;

    try {
      // Reserve credits upfront (atomic check + deduct)
      await UserService.reserveBetaCredits(
        user.uid,
        IMAGE_FIX_CREDIT_COST,
        "image_fix",
        imageId
      );

      // Validate fixScope and problemIds
      if (
        (body.fixScope === "single" || body.fixScope === "multiple") &&
        (!body.problemIds || body.problemIds.length === 0)
      ) {
        this.setStatus(400);
        throw {
          error: "Bad Request",
          message: "problemIds required for single/multiple fix scope",
        };
      }

      // Create fix job
      const fixJob = await FixService.createFix({
        userId: user.uid,
        imageId,
        fixScope: body.fixScope,
        problemIds: body.problemIds,
        parentFixId: body.parentFixId,
      });

      // Start async processing (don't wait for it)
      // processFix handles its own error catching and status updates
      FixService.processFix(fixJob.fixId).catch(() => {
        // Error already logged and status updated in processFix
      });

      const shouldIncludeList = includeFixesList !== false;
      const fixes = shouldIncludeList
        ? await FixService.listFixes(user.uid, imageId)
        : undefined;

      this.setStatus(202);
      return {
        message: "Fix request accepted. Processing will begin shortly.",
        fix: {
          fixId: fixJob.fixId,
          status: fixJob.status,
          version: fixJob.version,
          createdAt: fixJob.createdAt,
        },
        ...(fixes ? {fixes} : {}),
      };
    } catch (error: unknown) {
      const err = error as {error?: string; message?: string};
      if (err.error === "Not Found") {
        this.setStatus(404);
      } else if (err.error === "Forbidden") {
        this.setStatus(403);
      } else if (err.error === "Beta Limit Reached") {
        this.setStatus(403);
      } else if (err.error === "Too Many Requests") {
        this.setStatus(429);
      } else if (err.error === "Bad Request") {
        this.setStatus(400);
      } else {
        this.setStatus(500);
      }
      throw error;
    }
  }

  /**
   * Get the status and result of a fix request.
   * Poll this endpoint until status is "completed" or "failed".
   * @summary Get fix status/result
   * @param imageId Original image ID
   * @param fixId Fix ID to check
   */
  @Get("{imageId}/fixes/{fixId}")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(403, "Forbidden - not the owner")
  @Response<ErrorResponse>(404, "Fix not found")
  @Response<ErrorResponse>(500, "Internal server error")
  public async getFixStatus(
    @Request() request: ExpressRequest,
    @Path() imageId: string,
    @Path() fixId: string
  ): Promise<FixStatusResponse> {
    const user = request.user as AuthUser;

    try {
      const {fix, result} = await FixService.getFixResult(
        user.uid,
        imageId,
        fixId
      );

      if (fix.status === "pending") {
        return {
          status: "pending",
          fixId: fix.fixId,
          message: "Fix request is queued and will begin processing shortly.",
        };
      }

      if (fix.status === "processing") {
        return {
          status: "processing",
          fixId: fix.fixId,
          message: "Fix is being processed. Please check back in a moment.",
        };
      }

      if (fix.status === "failed") {
        return {
          status: "failed",
          fixId: fix.fixId,
          error: fix.error || "Fix generation failed",
        };
      }

      // Status is completed
      return {
        status: "completed",
        fix,
        result: result!,
      };
    } catch (error: unknown) {
      const err = error as {error?: string};
      if (err.error === "Not Found") {
        this.setStatus(404);
      } else if (err.error === "Forbidden") {
        this.setStatus(403);
      } else if (err.error === "Bad Request") {
        this.setStatus(400);
      } else {
        this.setStatus(500);
      }
      throw error;
    }
  }

  /**
   * List all fixes created for an image.
   * Returns fixes in version order (newest to oldest).
   * @summary List fixes for image
   * @param imageId Image ID
   */
  @Get("{imageId}/fixes")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(403, "Forbidden - not the owner")
  @Response<ErrorResponse>(404, "Image not found")
  @Response<ErrorResponse>(500, "Internal server error")
  public async listFixes(
    @Request() request: ExpressRequest,
    @Path() imageId: string
  ): Promise<FixListResponse> {
    const user = request.user as AuthUser;

    try {
      const fixes = await FixService.listFixes(user.uid, imageId);
      return {fixes};
    } catch (error: unknown) {
      const err = error as {error?: string};
      if (err.error === "Not Found") {
        this.setStatus(404);
      } else if (err.error === "Forbidden") {
        this.setStatus(403);
      } else {
        this.setStatus(500);
      }
      throw error;
    }
  }

  /**
   * Delete a fix and its generated image.
   * @summary Delete a fix
   * @param imageId Original image ID
   * @param fixId Fix ID to delete
   */
  @Delete("{imageId}/fixes/{fixId}")
  @SuccessResponse(200, "Fix deleted")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(403, "Forbidden - not the owner")
  @Response<ErrorResponse>(404, "Fix not found")
  @Response<ErrorResponse>(500, "Internal server error")
  public async deleteFix(
    @Request() request: ExpressRequest,
    @Path() imageId: string,
    @Path() fixId: string
  ): Promise<DeleteFixResponse> {
    const user = request.user as AuthUser;

    try {
      await FixService.deleteFix(user.uid, imageId, fixId);
      return {message: "Fix deleted successfully"};
    } catch (error: unknown) {
      const err = error as {error?: string};
      if (err.error === "Not Found") {
        this.setStatus(404);
      } else if (err.error === "Forbidden") {
        this.setStatus(403);
      } else if (err.error === "Bad Request") {
        this.setStatus(400);
      } else {
        this.setStatus(500);
      }
      throw error;
    }
  }
}
