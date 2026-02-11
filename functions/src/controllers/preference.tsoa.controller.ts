import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Request,
  Response,
  Route,
  Security,
  SuccessResponse,
  Tags,
} from "tsoa";
import {Request as ExpressRequest} from "express";
import {
  SavePreferencesRequest,
  SavePreferencesResponse,
  FoodTypesResponse,
  UserFoodPreferences,
  CuisineType,
  DietaryPreference,
} from "../types/preference.types";
import {ErrorResponse} from "../types/api.types";
import {AuthUser} from "../middleware/tsoa-auth.middleware";
import {PreferenceService} from "../services/preference.service";
import {
  CUISINE_DESCRIPTIONS,
  DIETARY_DESCRIPTIONS,
  HTTP_STATUS,
} from "../config/constants";
import * as logger from "firebase-functions/logger";

@Route("v1")
@Tags("Preferences")
export class PreferenceController extends Controller {
  /**
   * Get list of available food types/cuisines and dietary preferences.
   * This endpoint is public and can be called during onboarding.
   * @summary Get available food preference options
   */
  @Get("food-preferences/types")
  @SuccessResponse(200, "Successfully retrieved food types")
  @Response<ErrorResponse>(500, "Internal server error")
  public async getFoodTypes(): Promise<FoodTypesResponse> {
    try {
      // Build cuisines list from constants
      const cuisines = Object.entries(CUISINE_DESCRIPTIONS).map(
        ([type, info]) => ({
          type: type as CuisineType,
          description: info.description,
          emoji: info.emoji,
        })
      );

      // Build dietary list from constants
      const dietary = Object.entries(DIETARY_DESCRIPTIONS).map(
        ([type, info]) => ({
          type: type as DietaryPreference,
          description: info.description,
          emoji: info.emoji,
        })
      );

      return {cuisines, dietary};
    } catch (error) {
      logger.error("Error fetching food types:", error);
      this.setStatus(HTTP_STATUS.INTERNAL_SERVER_ERROR);
      throw {
        error: "Internal Server Error",
        message: "Failed to fetch food types",
      };
    }
  }

  /**
   * Get current user's food preferences.
   * Returns null if user hasn't set preferences yet (not onboarded).
   * @summary Get user's food preferences
   */
  @Security("BearerAuth")
  @Get("user/preferences")
  @SuccessResponse(200, "Successfully retrieved preferences")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(404, "Preferences not found")
  @Response<ErrorResponse>(500, "Internal server error")
  public async getUserPreferences(
    @Request() request: ExpressRequest
  ): Promise<UserFoodPreferences | null> {
    try {
      const authUser = (request as ExpressRequest & {user?: AuthUser}).user;
      if (!authUser) {
        this.setStatus(HTTP_STATUS.UNAUTHORIZED);
        throw {
          error: "Unauthorized",
          message: "Authentication required",
        };
      }

      const preferences = await PreferenceService.getUserPreferences(
        authUser.uid
      );

      // Return null if no preferences - frontend can handle onboarding
      return preferences;
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "error" in error &&
        error.error === "Unauthorized"
      ) {
        throw error;
      }

      logger.error("Error fetching user preferences:", error);
      this.setStatus(HTTP_STATUS.INTERNAL_SERVER_ERROR);
      throw {
        error: "Internal Server Error",
        message: "Failed to fetch preferences",
      };
    }
  }

  /**
   * Save or update user's food preferences.
   * Called during onboarding (first time) or when updating from profile.
   * Cuisine selection is optional - can save with empty preferences.
   * @summary Save/update user food preferences
   */
  @Security("BearerAuth")
  @Post("user/preferences")
  @SuccessResponse(200, "Preferences saved successfully")
  @Response<ErrorResponse>(400, "Bad Request - validation error")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(500, "Internal server error")
  public async saveUserPreferences(
    @Request() request: ExpressRequest,
    @Body() requestBody: SavePreferencesRequest
  ): Promise<SavePreferencesResponse> {
    try {
      const authUser = (request as ExpressRequest & {user?: AuthUser}).user;
      if (!authUser) {
        this.setStatus(HTTP_STATUS.UNAUTHORIZED);
        throw {
          error: "Unauthorized",
          message: "Authentication required",
        };
      }

      const {cuisines, dietary} = requestBody;

      // Validate cuisines array is provided
      if (!cuisines || !Array.isArray(cuisines)) {
        this.setStatus(HTTP_STATUS.BAD_REQUEST);
        throw {
          error: "Bad Request",
          message: "Cuisines must be an array",
        };
      }

      // Validate cuisines are valid types (if any provided)
      if (cuisines.length > 0) {
        const validCuisines = Object.keys(CUISINE_DESCRIPTIONS);
        const invalidCuisines = cuisines.filter(
          (c) => !validCuisines.includes(c)
        );
        if (invalidCuisines.length > 0) {
          this.setStatus(HTTP_STATUS.BAD_REQUEST);
          throw {
            error: "Bad Request",
            message: `Invalid cuisine types: ${invalidCuisines.join(", ")}`,
          };
        }
      }

      // Validate dietary preferences if provided
      if (dietary && Array.isArray(dietary)) {
        const validDietary = Object.keys(DIETARY_DESCRIPTIONS);
        const invalidDietary = dietary.filter((d) => !validDietary.includes(d));
        if (invalidDietary.length > 0) {
          this.setStatus(HTTP_STATUS.BAD_REQUEST);
          throw {
            error: "Bad Request",
            message: `Invalid dietary preferences: ${invalidDietary.join(", ")}`,
          };
        }
      }

      // Save preferences
      const preferences = await PreferenceService.saveUserPreferences(
        authUser.uid,
        cuisines,
        dietary
      );

      const wasFirstTime =
        !preferences.createdAt ||
        preferences.createdAt === preferences.updatedAt;

      return {
        message: wasFirstTime
          ? "Food preferences saved successfully! Your recommendations will now be personalized."
          : "Food preferences updated successfully!",
        preferences,
      };
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "error" in error &&
        (error.error === "Unauthorized" || error.error === "Bad Request")
      ) {
        throw error;
      }

      logger.error("Error saving user preferences:", error);
      this.setStatus(HTTP_STATUS.INTERNAL_SERVER_ERROR);
      throw {
        error: "Internal Server Error",
        message: "Failed to save preferences",
      };
    }
  }

  /**
   * Delete user's food preferences.
   * This will reset the onboarding status.
   * @summary Delete user food preferences
   */
  @Security("BearerAuth")
  @Delete("user/preferences")
  @SuccessResponse(200, "Preferences deleted successfully")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(500, "Internal server error")
  public async deleteUserPreferences(
    @Request() request: ExpressRequest
  ): Promise<{message: string}> {
    try {
      const authUser = (request as ExpressRequest & {user?: AuthUser}).user;
      if (!authUser) {
        this.setStatus(HTTP_STATUS.UNAUTHORIZED);
        throw {
          error: "Unauthorized",
          message: "Authentication required",
        };
      }

      await PreferenceService.deleteUserPreferences(authUser.uid);

      return {
        message: "Food preferences deleted successfully",
      };
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "error" in error &&
        error.error === "Unauthorized"
      ) {
        throw error;
      }

      logger.error("Error deleting user preferences:", error);
      this.setStatus(HTTP_STATUS.INTERNAL_SERVER_ERROR);
      throw {
        error: "Internal Server Error",
        message: "Failed to delete preferences",
      };
    }
  }
}
