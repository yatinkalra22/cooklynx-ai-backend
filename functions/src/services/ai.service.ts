import {geminiModel, geminiModerationModel} from "../config/firebase.config";
import {StorageService} from "./storage.service";
import {FoodAnalysis, CustomIngredientAnalysis} from "../types/api.types";
import {UserFoodPreferences} from "../types/preference.types";
import * as logger from "firebase-functions/logger";

/**
 * Error thrown when content moderation detects inappropriate content
 */
export class ContentModerationError extends Error {
  constructor(
    message: string,
    public readonly category: string
  ) {
    super(message);
    this.name = "ContentModerationError";
  }
}

/**
 * Result of content moderation check
 */
export interface ModerationResult {
  safe: boolean;
  category?: string;
  reason?: string;
}

export class AIService {
  /**
   * Moderate image content for inappropriate material.
   * Rejects images with sexual content, nudity, violence, or any content involving minors.
   * This is a critical safety check that runs before any image processing.
   */
  static async moderateImageContent(
    imageBuffer: Buffer
  ): Promise<ModerationResult> {
    const base64Image = imageBuffer.toString("base64");

    const moderationPrompt = `You are a content moderation system. Analyze this image for inappropriate content.

Check for the following categories and respond with ONLY a valid JSON object:

1. **CSAM/Minor Safety** - ANY hint of sexual content involving minors,
   suggestive content with minors, or child exploitation material. This is the
   HIGHEST PRIORITY check.
2. **Adult/Sexual Content** - Nudity, sexual acts, pornographic content,
   sexually suggestive poses
3. **Violence/Gore** - Graphic violence, blood, injuries, disturbing imagery
4. **Inappropriate Content** - Drug use, weapons, hate symbols

IMPORTANT: This is a food and grocery app. We expect images of food, ingredients, groceries, or kitchens.
If the image is NOT food-related, it may still be acceptable if it's appropriate content.

Respond with ONLY this JSON format:
{
  "safe": true/false,
  "category": "none" | "csam" | "adult" | "violence" | "inappropriate",
  "reason": "Brief explanation if not safe, or 'Content is appropriate' if safe"
}

Be STRICT about safety. When in doubt, mark as unsafe. CSAM detection must have ZERO tolerance.`;

    try {
      // Use cheaper Gemini 2.0 Flash model for moderation (free tier eligible)
      const result = await geminiModerationModel.generateContent([
        {
          inlineData: {
            data: base64Image,
            mimeType: "image/jpeg",
          },
        },
        {text: moderationPrompt},
      ]);

      const response = await result.response;
      const text = response.text();

      // Parse the moderation response
      let cleanText = text.trim();
      if (cleanText.startsWith("```json")) {
        cleanText = cleanText.replace(/```json\n?/g, "").replace(/```\n?/g, "");
      } else if (cleanText.startsWith("```")) {
        cleanText = cleanText.replace(/```\n?/g, "");
      }

      const parsed = JSON.parse(cleanText);

      return {
        safe: parsed.safe === true,
        category: parsed.category,
        reason: parsed.reason,
      };
    } catch (error) {
      // If moderation fails, reject the image for safety
      logger.error("Content moderation failed:", error);
      return {
        safe: false,
        category: "error",
        reason: "Content moderation check failed. Please try again.",
      };
    }
  }

  /**
   * Validate image content and throw if inappropriate
   */
  static async validateImageContent(imageBuffer: Buffer): Promise<void> {
    const result = await this.moderateImageContent(imageBuffer);

    if (!result.safe) {
      const messages: Record<string, string> = {
        csam: "This content violates our policies and has been rejected.",
        adult: "Adult or sexually explicit content is not allowed.",
        violence: "Violent or graphic content is not allowed.",
        inappropriate: "This content is not appropriate for our platform.",
        error: result.reason || "Content moderation failed.",
      };

      const message =
        messages[result.category || "inappropriate"] ||
        "This content is not allowed on our platform.";

      throw new ContentModerationError(message, result.category || "unknown");
    }
  }

  /**
   * Analyze food image with Gemini AI
   * Automatically generates recipe recommendations based on detected items
   * Optionally personalizes recommendations based on user preferences
   */
  static async analyzeFood(
    userId: string,
    imageId: string,
    userPreferences?: UserFoodPreferences | null
  ): Promise<FoodAnalysis> {
    // Download image from storage
    const imageBuffer = await StorageService.downloadImage(userId, imageId);
    return this.analyzeFoodImageBuffer(imageBuffer, true, userPreferences);
  }

  /**
   * Analyze a provided food image buffer
   * OPTIMIZED: Single AI call analyzes ingredients AND generates recipes together
   * @param imageBuffer - Image to analyze
   * @param includeRecommendations - Whether to generate recipe recommendations (default: true)
   * @param userPreferences - Optional user food preferences for personalization
   */
  static async analyzeFoodImageBuffer(
    imageBuffer: Buffer,
    includeRecommendations = true,
    userPreferences?: UserFoodPreferences | null
  ): Promise<FoodAnalysis> {
    // Convert to base64 for Gemini
    const base64Image = imageBuffer.toString("base64");

    // Build combined analysis + recommendation prompt with optional personalization
    const prompt = this.buildFoodAnalysisPrompt(
      includeRecommendations,
      userPreferences
    );

    // Single AI call for both analysis and recommendations
    const requestGeminiAnalysis = () =>
      geminiModel.generateContent([
        {
          inlineData: {
            data: base64Image,
            mimeType: "image/jpeg",
          },
        },
        {text: prompt},
      ]);

    const result =
      process.env.GEMINI_ENABLE_RETRY === "true"
        ? await this.withGeminiRetry(requestGeminiAnalysis)
        : await requestGeminiAnalysis();

    const response = await result.response;
    const text = response.text();

    // Parse AI response (includes both analysis and recommendations if requested)
    const analysis = this.parseFoodAIResponse(text, includeRecommendations);

    return analysis;
  }

  /**
   * Analyze custom ingredients (text-only, no image)
   * Takes a raw comma-separated ingredient list, cleans it up,
   * and generates structured ingredients + recipe recommendations.
   */
  static async analyzeCustomIngredients(
    rawInput: string,
    userPreferences?: UserFoodPreferences | null
  ): Promise<Omit<CustomIngredientAnalysis, "ingredientId" | "userId" | "createdAt">> {
    const prompt = this.buildCustomIngredientPrompt(rawInput, userPreferences);

    const requestGeminiAnalysis = () =>
      geminiModel.generateContent([{text: prompt}]);

    const result =
      process.env.GEMINI_ENABLE_RETRY === "true"
        ? await this.withGeminiRetry(requestGeminiAnalysis)
        : await requestGeminiAnalysis();

    const response = await result.response;
    const text = response.text();

    const analysis = this.parseFoodAIResponse(text, true);

    return {
      rawInput,
      items: analysis.items,
      summary: analysis.summary,
      recommendations: analysis.recommendations,
      analyzedAt: analysis.analyzedAt,
      version: "1.0",
    };
  }

  /**
   * Build prompt for custom ingredient analysis (text-only)
   */
  private static buildCustomIngredientPrompt(
    rawInput: string,
    userPreferences?: UserFoodPreferences | null
  ): string {
    const hasPreferences = userPreferences?.cuisines?.length;
    const totalRecommendations = hasPreferences ? 5 : 3;
    const personalizedCount = hasPreferences ? 3 : 0;
    const randomCount = hasPreferences ? 2 : 3;

    let personalizationInstructions = "";
    if (hasPreferences) {
      const cuisineList = userPreferences.cuisines.join(", ");
      const dietaryInfo =
        userPreferences.dietary && userPreferences.dietary.length > 0
          ? ` The user follows these dietary preferences: ${userPreferences.dietary.join(", ")}.`
          : "";

      personalizationInstructions = `

**PERSONALIZATION:**
The user prefers ${cuisineList} cuisine(s).${dietaryInfo}

- Generate ${personalizedCount} recipes that match their cuisine preferences
- Generate ${randomCount} additional diverse recipes from other cuisines
- Clearly mark which recipes are personalized vs. random in the "type" field
- Ensure ALL recommendations respect their dietary preferences${dietaryInfo ? " (if specified)" : ""}`;
    }

    return `You are an expert culinary assistant and nutritionist.
The user has listed these ingredients they have on hand: "${rawInput}"

**TASK 1: Clean & Identify Ingredients**
Parse the comma-separated list above into structured ingredient items.
For each item:
1. "name": Cleaned, proper name of the ingredient
2. "category": Category (e.g., Produce, Dairy, Meat, Pantry, Grain, Spice, etc.)
3. "notes": Brief notes (e.g., common uses, storage tips, or preparation suggestions)
4. "confidence": Set to 1.0 since these are user-provided

**TASK 2: Recommend Recipes**
Based on the listed ingredients, recommend ${totalRecommendations} creative and
delicious dishes that can be prepared.${personalizationInstructions}

For each dish, provide:
1. "name": Name of the dish
2. "description": A brief, appetizing description
3. "ingredientsUsed": Which of the listed ingredients are used
4. "additionalIngredientsNeeded": Any common pantry staples or minor ingredients needed
5. "cookingTime": Estimated time to prepare and cook
6. "difficulty": Difficulty level ("easy", "medium", or "hard")
7. "instructions": Step-by-step cooking instructions (array of strings)
8. "type": "personalized" or "random"

Return ONLY a valid JSON object (no markdown, no explanations).

**Response format (JSON only):**
{
  "items": [
    {
      "name": "Chicken Breast",
      "category": "Meat",
      "notes": "Versatile protein, great grilled or baked",
      "confidence": 1.0
    }
  ],
  "summary": "Short 1-2 sentence overview of the ingredients and meal potential",
  "recommendations": {
    "recommendations": [
      {
        "name": "Dish Name",
        "description": "Appetizing description...",
        "ingredientsUsed": ["Chicken Breast"],
        "additionalIngredientsNeeded": ["salt", "oil"],
        "cookingTime": "25 mins",
        "difficulty": "easy",
        "instructions": ["Step 1...", "Step 2..."],
        "type": "random"
      }
    ],
    "summary": "Quick overview of the recommended meals"
  }
}

Be precise and helpful. Return ONLY valid JSON.`;
  }

  /**
   * Build food analysis prompt
   * OPTIMIZED: Combines ingredient detection + recipe recommendations in one prompt
   * Supports personalized recommendations based on user preferences
   */
  private static buildFoodAnalysisPrompt(
    includeRecommendations = true,
    userPreferences?: UserFoodPreferences | null
  ): string {
    const basePrompt =
      "You are an expert culinary assistant and nutritionist. " +
      "Analyze this image to identify food items, ingredients, and products.";

    const analysisInstructions = `
For each item identified, provide:
1. "name": Common name of the ingredient or food item
2. "category": Category (e.g., Produce, Dairy, Meat, Pantry, Bakery, etc.)
3. "notes": Brief notes about the item (e.g., ripeness, quantity, brand if visible, or suggestions for use)
4. "confidence": A score from 0 to 1 for identification accuracy`;

    if (!includeRecommendations) {
      return `${basePrompt}

Analyze the image and return ONLY a valid JSON object (no markdown, no explanations).
${analysisInstructions}

**Response format (JSON only):**
{
  "items": [
    {
      "name": "Organic Whole Milk",
      "category": "Dairy",
      "notes": "Half-full carton, Horizon brand",
      "confidence": 0.95
    }
  ],
  "summary": "Short 1-2 sentence overview of the items found in the image"
}

Be precise and helpful. Return ONLY valid JSON.`;
    }

    // Determine number of recommendations and personalization
    const hasPreferences = userPreferences?.cuisines?.length;
    const totalRecommendations = hasPreferences ? 5 : 3;
    const personalizedCount = hasPreferences ? 3 : 0;
    const randomCount = hasPreferences ? 2 : 3;

    // Build personalization instructions
    let personalizationInstructions = "";
    if (hasPreferences) {
      const cuisineList = userPreferences.cuisines.join(", ");
      const dietaryInfo =
        userPreferences.dietary && userPreferences.dietary.length > 0
          ? ` The user follows these dietary preferences: ${userPreferences.dietary.join(", ")}.`
          : "";

      personalizationInstructions = `

**PERSONALIZATION:**
The user prefers ${cuisineList} cuisine(s).${dietaryInfo}

- Generate ${personalizedCount} recipes that match their cuisine preferences
- Generate ${randomCount} additional diverse recipes from other cuisines
- Clearly mark which recipes are personalized vs. random in the "type" field
- Ensure ALL recommendations respect their dietary preferences${dietaryInfo ? " (if specified)" : ""}`;
    }

    // Combined prompt: Analysis + Recommendations in ONE AI call
    return `${basePrompt}

**TASK 1: Identify Ingredients**
${analysisInstructions}

**TASK 2: Recommend Recipes**
Based on the identified ingredients, recommend ${totalRecommendations} creative and
delicious dishes that can be prepared.${personalizationInstructions}

For each dish, provide:
1. "name": Name of the dish
2. "description": A brief, appetizing description
3. "ingredientsUsed": Which of the detected ingredients are used
4. "additionalIngredientsNeeded": Any common pantry staples or minor ingredients needed
5. "cookingTime": Estimated time to prepare and cook
6. "difficulty": Difficulty level ("easy", "medium", or "hard")
7. "instructions": Step-by-step cooking instructions (array of strings)
8. "type": "personalized" or "random" (indicates if this matches user preferences)

Analyze the image and return ONLY a valid JSON object (no markdown, no explanations).

**Response format (JSON only):**
{
  "items": [
    {
      "name": "Chicken Breast",
      "category": "Meat",
      "notes": "Fresh, about 2 pieces",
      "confidence": 0.95
    },
    {
      "name": "Rice",
      "category": "Grain",
      "notes": "White rice, appears to be jasmine",
      "confidence": 0.9
    }
  ],
  "summary": "Short 1-2 sentence overview of the items found",
  "recommendations": {
    "recommendations": [
      {
        "name": "Chicken Fried Rice",
        "description": "Classic Asian-inspired dish...",
        "ingredientsUsed": ["Chicken Breast", "Rice"],
        "additionalIngredientsNeeded": ["soy sauce", "oil", "eggs"],
        "cookingTime": "25 mins",
        "difficulty": "easy",
        "instructions": ["Step 1...", "Step 2..."],
        "type": "personalized"
      }
    ],
    "summary": "Quick and easy meals using your ingredients"
  }
}

Be precise and helpful. Return ONLY valid JSON.`;
  }

  /**
   * Parse AI response to structured food analysis
   * Handles both analysis-only and analysis+recommendations responses
   */
  private static parseFoodAIResponse(
    responseText: string,
    includeRecommendations = true
  ): FoodAnalysis {
    try {
      // Remove markdown code blocks if present
      let cleanText = responseText.trim();

      if (cleanText.startsWith("```json")) {
        cleanText = cleanText.replace(/```json\n?/g, "").replace(/```\n?/g, "");
      } else if (cleanText.startsWith("```")) {
        cleanText = cleanText.replace(/```\n?/g, "");
      }

      const parsed = JSON.parse(cleanText);

      // AI returns recommendations with timestamp, add it if not present
      if (includeRecommendations && parsed.recommendations) {
        if (!parsed.recommendations.analyzedAt) {
          parsed.recommendations.analyzedAt = new Date().toISOString();
        }
        logger.info("Successfully parsed recommendations from AI response", {
          recommendationCount:
            parsed.recommendations.recommendations?.length || 0,
        });
      }

      // Add metadata
      return {
        ...parsed,
        analyzedAt: new Date().toISOString(),
        version: "1.0",
      };
    } catch (error) {
      logger.error("Failed to parse AI response", {error});
      // Return fallback analysis
      return this.getFallbackFoodAnalysis();
    }
  }

  /**
   * Fallback food analysis if AI parsing fails
   */
  private static getFallbackFoodAnalysis(): FoodAnalysis {
    return {
      items: [],
      summary: "Food analysis could not be completed. Please try again.",
      analyzedAt: new Date().toISOString(),
      version: "1.0",
    };
  }

  /**
   * Gemini retry logic
   */
  private static async withGeminiRetry<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    const maxRetries = Math.max(
      0,
      parseInt(process.env.GEMINI_MAX_RETRIES || "2", 10)
    );
    const baseDelayMs = Math.max(
      200,
      parseInt(process.env.GEMINI_RETRY_BASE_MS || "1000", 10)
    );
    const maxDelayMs = Math.max(
      baseDelayMs,
      parseInt(process.env.GEMINI_RETRY_MAX_MS || "30000", 10)
    );

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await operation();
      } catch (error) {
        attempt += 1;
        if (!this.isRetryableGeminiError(error) || attempt > maxRetries) {
          throw error;
        }
        const delayMs = this.getRetryDelayMs(
          error,
          attempt,
          baseDelayMs,
          maxDelayMs
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private static isRetryableGeminiError(error: unknown): boolean {
    const message =
      error instanceof Error ? error.message : String(error || "");
    const lower = message.toLowerCase();
    return (
      lower.includes("429") ||
      lower.includes("503") ||
      lower.includes("too many requests") ||
      lower.includes("service unavailable") ||
      lower.includes("rate limit") ||
      lower.includes("quota exceeded") ||
      lower.includes("model is overloaded")
    );
  }

  private static getRetryDelayMs(
    error: unknown,
    attempt: number,
    baseDelayMs: number,
    maxDelayMs: number
  ): number {
    const message =
      error instanceof Error ? error.message : String(error || "");
    const retryInMatch = message.match(/retry in\s*([0-9.]+)s/i);
    if (retryInMatch?.[1]) {
      const seconds = parseFloat(retryInMatch[1]);
      if (!Number.isNaN(seconds)) {
        return Math.max(0, Math.floor(seconds * 1000));
      }
    }
    const backoff = baseDelayMs * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * 300);
    return Math.min(maxDelayMs, backoff + jitter);
  }
}
