/**
 * Food Preference Types
 */

/**
 * Supported cuisine types for personalization
 */
export type CuisineType =
  | "Indian"
  | "Italian"
  | "Mexican"
  | "Chinese"
  | "Japanese"
  | "Thai"
  | "Mediterranean"
  | "French"
  | "Korean"
  | "Vietnamese"
  | "Middle Eastern"
  | "American"
  | "Greek"
  | "Spanish"
  | "Caribbean"
  | "African"
  | "Brazilian"
  | "Fusion";

/**
 * Dietary preferences
 */
export type DietaryPreference =
  | "Vegetarian"
  | "Vegan"
  | "Pescatarian"
  | "Gluten-Free"
  | "Dairy-Free"
  | "Keto"
  | "Paleo"
  | "Low-Carb"
  | "Halal"
  | "Kosher"
  | "None";

/**
 * User's food preferences
 */
export interface UserFoodPreferences {
  /** Preferred cuisine types */
  cuisines: CuisineType[];
  /** Dietary restrictions or preferences */
  dietary?: DietaryPreference[];
  /** When preferences were first set */
  createdAt: string;
  /** When preferences were last updated */
  updatedAt: string;
  /** Whether this is the user's first time setting preferences */
  isOnboarded: boolean;
}

/**
 * Request to save/update user food preferences
 */
export interface SavePreferencesRequest {
  /** Selected cuisine types (at least one required) */
  cuisines: CuisineType[];
  /** Optional dietary preferences */
  dietary?: DietaryPreference[];
}

/**
 * Response after saving preferences
 */
export interface SavePreferencesResponse {
  message: string;
  preferences: UserFoodPreferences;
}

/**
 * Response with list of available food types
 */
export interface FoodTypesResponse {
  cuisines: {
    type: CuisineType;
    description: string;
    emoji: string;
  }[];
  dietary: {
    type: DietaryPreference;
    description: string;
    emoji: string;
  }[];
}
