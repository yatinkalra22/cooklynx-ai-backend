import {database} from "../config/firebase.config";
import {
  UserFoodPreferences,
  CuisineType,
  DietaryPreference,
} from "../types/preference.types";
import * as logger from "firebase-functions/logger";

export class PreferenceService {
  /**
   * Helper for retry logic with exponential backoff
   */
  private static async retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    baseDelayMs: number = 50
  ): Promise<T> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const isListenTwiceError = errorMsg.includes("listen() called twice");
        const isLastAttempt = attempt === maxRetries - 1;

        if (isListenTwiceError && !isLastAttempt) {
          // Firebase compat layer listener conflict - retry with backoff
          const delayMs = baseDelayMs * Math.pow(2, attempt);
          logger.info(
            `Firebase listen conflict detected, retrying after ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        } else {
          throw error;
        }
      }
    }
    throw new Error("Max retries exceeded for Firebase database operation");
  }

  /**
   * Get user's food preferences from Realtime Database
   * Includes retry logic for Firebase compat SDK listener conflicts
   */
  static async getUserPreferences(
    userId: string
  ): Promise<UserFoodPreferences | null> {
    try {
      const result = await this.retryWithBackoff(() =>
        database
          .ref(`users/${userId}/preferences`)
          .once("value")
          .then((snapshot) => {
            if (!snapshot.exists()) {
              return null;
            }
            return snapshot.val() as UserFoodPreferences;
          })
      );
      return result;
    } catch (error) {
      logger.error("Error fetching user preferences:", error);
      throw error;
    }
  }

  /**
   * Save or update user's food preferences
   */
  static async saveUserPreferences(
    userId: string,
    cuisines: CuisineType[],
    dietary?: DietaryPreference[]
  ): Promise<UserFoodPreferences> {
    try {
      // Check if preferences already exist to determine onboarding status
      const existingPrefs = await this.getUserPreferences(userId);
      const isFirstTime = existingPrefs === null;

      const now = new Date().toISOString();
      const preferences: UserFoodPreferences = {
        cuisines,
        dietary: dietary || [],
        createdAt: isFirstTime ? now : existingPrefs.createdAt,
        updatedAt: now,
        isOnboarded: true,
      };

      await database.ref(`users/${userId}/preferences`).set(preferences);

      logger.info(
        `Preferences ${isFirstTime ? "created" : "updated"} for user ${userId}`
      );

      return preferences;
    } catch (error) {
      logger.error("Error saving user preferences:", error);
      throw error;
    }
  }

  /**
   * Check if user has completed onboarding (set preferences)
   */
  static async hasCompletedOnboarding(userId: string): Promise<boolean> {
    try {
      const preferences = await this.getUserPreferences(userId);
      return preferences !== null && preferences.isOnboarded === true;
    } catch (error) {
      logger.error("Error checking onboarding status:", error);
      return false;
    }
  }

  /**
   * Delete user's preferences
   */
  static async deleteUserPreferences(userId: string): Promise<void> {
    try {
      await database.ref(`users/${userId}/preferences`).remove();
      logger.info(`Preferences deleted for user ${userId}`);
    } catch (error) {
      logger.error("Error deleting user preferences:", error);
      throw error;
    }
  }
}
