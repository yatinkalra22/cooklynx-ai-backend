/**
 * Recipe URL Extraction Types
 * Types for extracting recipes from video URLs (YouTube, Instagram, TikTok, etc.)
 */

// ============================================================================
// Status & Platform Types
// ============================================================================

export type RecipeUrlAnalysisStatus =
  | "pending"
  | "queued"
  | "validating"
  | "analyzing"
  | "completed"
  | "failed";

export type VideoPlatform =
  | "youtube"
  | "instagram"
  | "tiktok"
  | "facebook"
  | "other"
  | "unknown";

// ============================================================================
// Ingredient Types (Grocery-List Ready)
// ============================================================================

/**
 * A single ingredient with quantity info, ready for grocery list generation
 */
export interface RecipeIngredient {
  /** Ingredient name (e.g., "chicken breast") */
  name: string;
  /** Quantity amount (e.g., 2, 0.5, 1). Null for "to taste" or "as needed" */
  quantity: number | null;
  /** Unit of measurement (e.g., "cups", "tbsp", "lbs", "pieces", "to taste") */
  unit: string;
  /** Grocery category for list grouping (e.g., "Produce", "Dairy & Eggs", "Meat & Seafood") */
  category: string;
  /** Preparation note (e.g., "diced", "room temperature") */
  preparation?: string;
  /** Whether this ingredient is optional */
  optional?: boolean;
}

// ============================================================================
// Recipe Types
// ============================================================================

/**
 * A single instruction step with optional timing
 */
export interface RecipeStep {
  /** Step number (1-based) */
  stepNumber: number;
  /** Instruction text */
  instruction: string;
  /** Optional duration for this step in minutes */
  durationMinutes?: number;
  /** Optional tip for this step */
  tip?: string;
}

/**
 * Time breakdown for the recipe
 */
export interface RecipeTimings {
  /** Prep time in minutes */
  prepMinutes: number;
  /** Active cooking time in minutes */
  cookMinutes: number;
  /** Total time in minutes (prep + cook + any resting) */
  totalMinutes: number;
  /** Optional resting/waiting time in minutes */
  restMinutes?: number;
}

/**
 * Optional nutritional information per serving
 */
export interface NutritionalInfo {
  calories?: number;
  proteinGrams?: number;
  carbsGrams?: number;
  fatGrams?: number;
  fiberGrams?: number;
}

/**
 * Complete extracted recipe from a video URL
 */
export interface ExtractedRecipe {
  /** Recipe title */
  title: string;
  /** Brief description */
  description: string;
  /** Ingredients with quantities (grocery-list ready) */
  ingredients: RecipeIngredient[];
  /** Step-by-step instructions */
  steps: RecipeStep[];
  /** Time breakdown */
  timings: RecipeTimings;
  /** Number of servings */
  servings: number;
  /** Difficulty level */
  difficulty: "easy" | "medium" | "hard";
  /** Cuisine type (e.g., "Italian", "Japanese", "Mexican") */
  cuisine: string;
  /** Meal type (e.g., "dinner", "dessert", "snack", "breakfast") */
  mealType?: string;
  /** Dietary tags (e.g., "vegetarian", "gluten-free", "keto") */
  dietaryTags?: string[];
  /** Nutritional info per serving (best-effort estimate) */
  nutrition?: NutritionalInfo;
  /** Key equipment needed (e.g., "oven", "blender") */
  equipment?: string[];
}

// ============================================================================
// Database Record Types
// ============================================================================

/**
 * URL extraction metadata stored in RTDB at `urlExtractions/{urlId}`
 */
export interface UrlExtractionMetadata {
  urlId: string;
  userId: string;
  /** The submitted video URL (original) */
  sourceUrl: string;
  /** Normalized/canonical URL */
  normalizedUrl?: string;
  /** Detected platform */
  platform: VideoPlatform;
  /** Current processing status */
  analysisStatus: RecipeUrlAnalysisStatus;
  /** Video title (populated after analysis) */
  videoTitle?: string;
  /** Timestamp of submission */
  submittedAt: string;
  /** Timestamp of completion */
  completedAt?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Full extraction result stored in RTDB at `urlRecipes/{urlId}`
 */
export interface UrlRecipeResult {
  urlId: string;
  userId: string;
  sourceUrl: string;
  platform: VideoPlatform;
  recipe: ExtractedRecipe;
  /** Confidence score 0-1 for the overall extraction quality */
  confidence: number;
  /** Whether the video appeared to be a cooking/recipe video */
  isRecipeVideo: boolean;
  /** AI model used */
  modelUsed: string;
  /** Processing duration in ms */
  processingDurationMs: number;
  analyzedAt: string;
  version: string;
}

/**
 * Shared recipe data stored in RTDB at `sharedUrlRecipes/{urlHash}`
 * Used for deduplication across all users
 */
export interface SharedUrlRecipe {
  urlHash: string;
  normalizedUrl: string;
  platform: VideoPlatform;
  recipe: ExtractedRecipe;
  confidence: number;
  isRecipeVideo: boolean;
  modelUsed: string;
  firstExtractedAt: string;
  firstExtractedBy: string;
  extractionCount: number;
  version: string;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

/**
 * Request body for URL extraction submission
 */
export interface ExtractRecipeFromUrlRequest {
  /** The video URL to extract recipe from */
  url: string;
}

/**
 * Response after submitting a URL for extraction.
 * Returns the full extracted recipe data (processed synchronously).
 */
export interface ExtractRecipeFromUrlResponse {
  message: string;
  urlId: string;
  sourceUrl: string;
  platform: VideoPlatform;
  status: "completed";
  creditsUsed: number;
  /** Whether this URL was previously processed (dedup cache hit) */
  fromCache: boolean;
  /** Whether the content was identified as a recipe */
  isRecipeVideo: boolean;
  /** Confidence score 0-1 for the extraction quality */
  confidence: number;
  /** The fully extracted recipe with ingredients, steps, timings, etc. */
  recipe: ExtractedRecipe;
}

/**
 * List response for user's URL extractions with full recipe data
 */
export interface UrlExtractionListResponse {
  extractions: Array<{
    metadata: UrlExtractionMetadata;
    recipe?: UrlRecipeResult;
  }>;
}

/**
 * Combined response for user's images and URL extractions
 */
export interface CombinedAssetsResponse {
  images: Array<{
    imageId: string;
    uploadedAt: string;
    fileName: string;
    /** Cloud Storage path (e.g., users/{uid}/images/{imageId}.jpg) */
    storagePath: string;
    /** Signed URL for image display (valid for 7 days) */
    thumbnailUrl: string;
    analysisStatus: string;
  }>;
  urlExtractions: Array<{
    metadata: UrlExtractionMetadata;
    recipe?: UrlRecipeResult;
  }>;
}

// ============================================================================
// Status Poll Response Types
// ============================================================================

export interface UrlExtractionPendingResponse {
  status: "pending" | "queued" | "validating";
  message: string;
}

export interface UrlExtractionAnalyzingResponse {
  status: "analyzing";
  message: string;
}

export interface UrlExtractionCompletedResponse {
  status: "completed";
  extraction: {
    urlId: string;
    sourceUrl: string;
    platform: VideoPlatform;
    submittedAt: string;
  };
  recipe: UrlRecipeResult;
}

export interface UrlExtractionFailedResponse {
  status: "failed";
  error: string;
}

export type UrlExtractionStatusResponse =
  | UrlExtractionPendingResponse
  | UrlExtractionAnalyzingResponse
  | UrlExtractionCompletedResponse
  | UrlExtractionFailedResponse;

// ============================================================================
// Pub/Sub Message Types
// ============================================================================

export interface UrlExtractionMessage {
  urlId: string;
  userId: string;
  sourceUrl: string;
  platform: VideoPlatform;
}
