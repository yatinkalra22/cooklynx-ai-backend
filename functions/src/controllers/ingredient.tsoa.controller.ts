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
import {AIService} from "../services/ai.service";
import {UserService} from "../services/user.service";
import {PreferenceService} from "../services/preference.service";
import {CacheService} from "../services/cache.service";
import {CACHE_KEYS, CACHE_TTL} from "../config/redis.config";
import {INGREDIENT_CREDIT_COST} from "../config/constants";
import {
  ParseIngredientsRequest,
  ParseIngredientsResponse,
  CustomIngredientAnalysis,
  GetIngredientAnalysisResponse,
  ErrorResponse,
} from "../types/api.types";
import {AuthUser} from "../middleware/tsoa-auth.middleware";
import * as logger from "firebase-functions/logger";
import {database} from "../config/firebase.config";

interface AuthenticatedRequest extends ExpressRequest {
  user: AuthUser;
}

@Route("v1/ingredients")
@Tags("Ingredients")
export class IngredientController extends Controller {
  /**
   * Parse a comma-separated list of ingredients using AI.
   * Cleans up names, categorizes items, and generates recipe recommendations.
   * Costs 1 credit per submission.
   * @summary Parse custom ingredients
   */
  @Post("parse")
  @Security("BearerAuth")
  @SuccessResponse(201, "Ingredients parsed successfully")
  @Response<ErrorResponse>(400, "Invalid input")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(403, "Not enough credits")
  @Response<ErrorResponse>(500, "Internal server error")
  public async parseIngredients(
    @Request() request: AuthenticatedRequest,
    @Body() body: ParseIngredientsRequest
  ): Promise<ParseIngredientsResponse> {
    const user = request.user;

    // Validate input
    const trimmed = body.ingredients?.trim();
    if (!trimmed || trimmed.length === 0) {
      this.setStatus(400);
      throw {error: "Bad Request", message: "Ingredients text is required"};
    }
    if (trimmed.length > 2000) {
      this.setStatus(400);
      throw {
        error: "Bad Request",
        message: "Ingredients text must be under 2000 characters",
      };
    }

    // Reserve credits atomically
    let creditsRemaining = 0;
    try {
      creditsRemaining = await UserService.reserveCredits(
        user.uid,
        INGREDIENT_CREDIT_COST,
        "ingredient_parsing",
        `ing_${Date.now()}`
      );
    } catch (error: unknown) {
      const err = error as {error?: string};
      if (err.error === "Credit Limit Reached") {
        this.setStatus(403);
      }
      throw error;
    }

    try {
      const {v4: uuidv4} = await import("uuid");
      const ingredientId = `ing_${uuidv4()}`;
      const now = new Date().toISOString();

      // Fetch user preferences for personalized recommendations
      const userPreferences =
        await PreferenceService.getUserPreferences(user.uid);

      // Analyze ingredients with AI (synchronous — text-only is fast)
      const analysis = await AIService.analyzeCustomIngredients(
        trimmed,
        userPreferences
      );

      // Store result in RTDB
      const record: CustomIngredientAnalysis = {
        ingredientId,
        userId: user.uid,
        rawInput: trimmed,
        items: analysis.items,
        summary: analysis.summary,
        recommendations: analysis.recommendations,
        analyzedAt: analysis.analyzedAt,
        version: analysis.version,
        createdAt: now,
      };

      await database.ref(`customIngredients/${ingredientId}`).set(record);

      // Invalidate asset list cache
      CacheService.delete(CACHE_KEYS.assetList(user.uid)).catch(() => {});

      logger.info("ingredient:parse:completed", {
        userId: user.uid,
        ingredientId,
        itemCount: analysis.items.length,
      });

      this.setStatus(201);
      return {
        message: "Ingredients parsed successfully",
        ingredientId,
        status: "completed",
        creditsUsed: INGREDIENT_CREDIT_COST,
        creditsRemaining,
      };
    } catch (error) {
      if ((error as {error?: string}).error) throw error;

      logger.error("ingredient:parse:failed", {
        userId: user.uid,
        error: error instanceof Error ? error.message : String(error),
      });
      this.setStatus(500);
      throw {
        error: "Internal Server Error",
        message: "Failed to parse ingredients",
      };
    }
  }

  /**
   * Get a saved custom ingredient analysis by ID.
   * @summary Get ingredient analysis
   * @param ingredientId Unique ingredient analysis identifier
   */
  @Get("{ingredientId}")
  @Security("BearerAuth")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(403, "Not the owner")
  @Response<ErrorResponse>(404, "Not found")
  @Response<ErrorResponse>(500, "Internal server error")
  public async getIngredientAnalysis(
    @Request() request: AuthenticatedRequest,
    @Path() ingredientId: string
  ): Promise<GetIngredientAnalysisResponse> {
    const user = request.user;

    try {
      // Check cache first
      const cacheKey = CACHE_KEYS.customIngredient(ingredientId);
      const cached =
        await CacheService.get<CustomIngredientAnalysis>(cacheKey);

      if (cached) {
        if (cached.userId !== user.uid) {
          this.setStatus(403);
          throw {error: "Forbidden", message: "Not the owner of this analysis"};
        }
        return {status: "completed", analysis: cached};
      }

      // Fetch from RTDB
      const snapshot = await database
        .ref(`customIngredients/${ingredientId}`)
        .get();

      if (!snapshot.exists()) {
        this.setStatus(404);
        throw {error: "Not Found", message: "Ingredient analysis not found"};
      }

      const analysis = snapshot.val() as CustomIngredientAnalysis;

      if (analysis.userId !== user.uid) {
        this.setStatus(403);
        throw {error: "Forbidden", message: "Not the owner of this analysis"};
      }

      // Cache for future requests
      CacheService.set(cacheKey, analysis, CACHE_TTL.API_RESPONSE_LONG).catch(
        () => {}
      );

      return {status: "completed", analysis};
    } catch (error: unknown) {
      if ((error as {error?: string}).error) {
        const knownError = error as {error: string};
        if (knownError.error === "Not Found") this.setStatus(404);
        if (knownError.error === "Forbidden") this.setStatus(403);
        throw error;
      }
      logger.error("ingredient:get:failed", {
        userId: user.uid,
        ingredientId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.setStatus(500);
      throw {
        error: "Internal Server Error",
        message: "Failed to get ingredient analysis",
      };
    }
  }
}
