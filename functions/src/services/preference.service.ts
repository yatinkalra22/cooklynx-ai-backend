import {database} from "../config/firebase.config";
import {
  UserFoodPreferences,
  CuisineType,
  DietaryPreference,
} from "../types/preference.types";
import * as logger from "firebase-functions/logger";

export class PreferenceService {
  /**
   * Get user's food preferences from Realtime Database
   */
  static async getUserPreferences(
    userId: string
  ): Promise<UserFoodPreferences | null> {
    try {
      const snapshot = await database
        .ref(`users/${userId}/preferences`)
        .once("value");

      if (!snapshot.exists()) {
        return null;
      }

      return snapshot.val() as UserFoodPreferences;
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
