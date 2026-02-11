import {
  Controller,
  Get,
  Post,
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
import {UrlRecipeService} from "../services/url-recipe.service";
import {UserService} from "../services/user.service";
import {CacheService} from "../services/cache.service";
import {StorageService} from "../services/storage.service";
import {CACHE_KEYS, CACHE_TTL} from "../config/redis.config";
import {URL_EXTRACTION_CREDIT_COST} from "../config/constants";
import {
  ExtractRecipeFromUrlRequest,
  ExtractRecipeFromUrlResponse,
  UrlExtractionStatusResponse,
  UrlExtractionListResponse,
  CombinedAssetsResponse,
} from "../types/recipe-url.types";
import {ErrorResponse} from "../types/api.types";
import {AuthUser} from "../middleware/tsoa-auth.middleware";
import * as logger from "firebase-functions/logger";
import {database} from "../config/firebase.config";

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthUser;
}

@Route("v1/recipes")
@Tags("Recipes")
export class RecipeUrlController extends Controller {
  /**
   * Submit a video URL for AI-powered recipe extraction.
   * Supports any URL: YouTube (full video analysis), Instagram, TikTok,
   * recipe blogs, and any other public webpage with recipe content.
   * The analysis runs asynchronously - poll the status endpoint for results.
   * Costs 1 credit per submission.
   * @summary Extract recipe from video URL
   */
  @Post("extract-from-url")
  @Security("BearerAuth")
  @SuccessResponse(201, "URL submitted for recipe extraction")
  @Response<ErrorResponse>(400, "Invalid URL or unsupported platform")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(403, "Not enough credits")
  @Response<ErrorResponse>(500, "Internal server error")
  public async extractFromUrl(
    @Request() request: AuthenticatedRequest,
    @Body() body: ExtractRecipeFromUrlRequest
  ): Promise<ExtractRecipeFromUrlResponse> {
    const user = request.user;

    // Validate URL and detect platform
    const validation = UrlRecipeService.validateUrl(body.url);
    if (!validation.valid) {
      this.setStatus(400);
      throw {error: "Bad Request", message: validation.error};
    }

    // Reserve credits atomically
    try {
      await UserService.reserveBetaCredits(
        user.uid,
        URL_EXTRACTION_CREDIT_COST,
        "url_recipe_extraction",
        `url_${validation.normalizedUrl}`
      );
    } catch (error: unknown) {
      const err = error as {error?: string};
      if (err.error === "Beta Limit Reached") {
        this.setStatus(403);
      }
      throw error;
    }

    try {
      // Process synchronously - calls Gemini, saves to DB, returns full recipe
      const result = await UrlRecipeService.extractRecipeSync(
        user.uid,
        body.url,
        validation.platform,
        validation.normalizedUrl
      );

      logger.info("recipe-url:extract:success", {
        userId: user.uid,
        urlId: result.urlId,
        platform: validation.platform,
        fromCache: result.fromCache,
        isRecipeVideo: result.isRecipeVideo,
        ingredientCount: result.recipe.ingredients.length,
      });

      this.setStatus(201);
      return {
        message: result.fromCache
          ? "Recipe found in cache. Instant results."
          : "Recipe extracted successfully.",
        urlId: result.urlId,
        sourceUrl: body.url,
        platform: validation.platform,
        status: "completed",
        creditsUsed: URL_EXTRACTION_CREDIT_COST,
        fromCache: result.fromCache,
        isRecipeVideo: result.isRecipeVideo,
        confidence: result.confidence,
        recipe: result.recipe,
      };
    } catch (error) {
      if ((error as {error?: string}).error) throw error;

      logger.error("recipe-url:extract:failed", {
        userId: user.uid,
        error: error instanceof Error ? error.message : String(error),
      });
      this.setStatus(500);
      throw {
        error: "Internal Server Error",
        message: "Failed to extract recipe from URL",
      };
    }
  }

  /**
   * Get recipe extraction status and results.
   * Poll this endpoint until status is "completed" or "failed".
   * @summary Get URL extraction status/results
   * @param urlId Unique extraction identifier
   */
  @Get("url/{urlId}")
  @Security("BearerAuth")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(403, "Not the owner")
  @Response<ErrorResponse>(404, "Extraction not found")
  @Response<ErrorResponse>(500, "Internal server error")
  public async getExtractionStatus(
    @Request() request: AuthenticatedRequest,
    @Path() urlId: string
  ): Promise<UrlExtractionStatusResponse> {
    const user = request.user;

    try {
      const {metadata, recipe} = await UrlRecipeService.getExtraction(
        user.uid,
        urlId
      );

      switch (metadata.analysisStatus) {
        case "pending":
        case "queued":
        case "validating":
          return {
            status: metadata.analysisStatus,
            message: "Recipe extraction is queued for processing.",
          };
        case "analyzing":
          return {
            status: "analyzing",
            message: "Analyzing video for recipe content...",
          };
        case "failed":
          return {
            status: "failed",
            error:
              metadata.error || "Recipe extraction failed. Please try again.",
          };
        case "completed":
          if (!recipe) {
            this.setStatus(404);
            throw {error: "Not Found", message: "Recipe results not found"};
          }
          return {
            status: "completed",
            extraction: {
              urlId: metadata.urlId,
              sourceUrl: metadata.sourceUrl,
              platform: metadata.platform,
              submittedAt: metadata.submittedAt,
            },
            recipe,
          };
        default:
          return {status: "pending", message: "Processing..."};
      }
    } catch (error: unknown) {
      if ((error as {error?: string}).error) {
        const knownError = error as {error: string};
        if (knownError.error === "Not Found") this.setStatus(404);
        if (knownError.error === "Forbidden") this.setStatus(403);
        throw error;
      }
      logger.error("recipe-url:status:failed", {
        userId: user.uid,
        urlId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.setStatus(500);
      throw {
        error: "Internal Server Error",
        message: "Failed to get extraction status",
      };
    }
  }

  /**
   * List all URL extractions by the authenticated user.
   * Returns results with full recipe data in reverse chronological order (newest first).
   * @summary List user's URL extractions
   */
  @Get("urls")
  @Security("BearerAuth")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(500, "Internal server error")
  public async listExtractions(
    @Request() request: AuthenticatedRequest
  ): Promise<UrlExtractionListResponse> {
    const user = request.user;

    try {
      const cacheKey = CACHE_KEYS.urlExtractionList(user.uid);
      const cached =
        await CacheService.get<UrlExtractionListResponse>(cacheKey);
      if (cached) return cached;

      const extractions = await UrlRecipeService.listExtractions(user.uid);
      const result: UrlExtractionListResponse = {extractions};

      CacheService.set(cacheKey, result, CACHE_TTL.API_RESPONSE_SHORT).catch(
        () => {}
      );
      return result;
    } catch (error) {
      logger.error("recipe-url:list:failed", {
        userId: user.uid,
        error: error instanceof Error ? error.message : String(error),
      });
      this.setStatus(500);
      throw {
        error: "Internal Server Error",
        message: "Failed to list extractions",
      };
    }
  }

  /**
   * Get a combined list of user's images and URL recipe extractions.
   * Returns both image uploads and URL extractions in a single response.
   * Useful for displaying all recipe content in one view.
   * @summary Get combined images and URL recipes
   */
  @Get("combined")
  @Security("BearerAuth")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(500, "Internal server error")
  public async getCombinedAssets(
    @Request() request: AuthenticatedRequest
  ): Promise<CombinedAssetsResponse> {
    const user = request.user;

    try {
      // Fetch both images and URL extractions in parallel
      const [imagesSnapshot, urlExtractions] = await Promise.all([
        database.ref("images").orderByChild("userId").equalTo(user.uid).get(),
        UrlRecipeService.listExtractions(user.uid),
      ]);

      // Collect raw image data
      const rawImages: Array<{
        imageId: string;
        uploadedAt: string;
        originalName: string;
        storagePath: string;
        analysisStatus: string;
      }> = [];
      if (imagesSnapshot.exists()) {
        imagesSnapshot.forEach((child) => {
          const value = child.val();
          if (!value || typeof value !== "object") return;

          const img = value as {
            imageId: string;
            uploadedAt: string;
            originalName: string;
            analysisStatus: string;
            storagePath: string;
          };

          rawImages.push({
            imageId: img.imageId || child.key!,
            uploadedAt: img.uploadedAt,
            originalName: img.originalName,
            storagePath: img.storagePath,
            analysisStatus: img.analysisStatus,
          });
        });
      }

      // Sort images newest first
      rawImages.sort(
        (a, b) =>
          new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
      );

      // Generate signed URLs for all images in parallel
      const images = await Promise.all(
        rawImages.map(async (img) => {
          let thumbnailUrl = "";
          try {
            thumbnailUrl = await StorageService.getSignedUrl(
              user.uid,
              img.imageId
            );
          } catch {
            logger.warn("combined:image-url-failed", {
              imageId: img.imageId,
            });
          }
          return {
            imageId: img.imageId,
            uploadedAt: img.uploadedAt,
            fileName: img.originalName,
            storagePath: img.storagePath,
            thumbnailUrl,
            analysisStatus: img.analysisStatus,
          };
        })
      );

      const result: CombinedAssetsResponse = {
        images,
        urlExtractions,
      };

      return result;
    } catch (error) {
      logger.error("recipe-url:combined:failed", {
        userId: user.uid,
        error: error instanceof Error ? error.message : String(error),
      });
      this.setStatus(500);
      throw {
        error: "Internal Server Error",
        message: "Failed to get combined assets",
      };
    }
  }
}
