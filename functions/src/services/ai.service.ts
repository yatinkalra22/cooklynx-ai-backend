import {
  geminiModel,
  geminiImageModel,
  geminiModerationModel,
} from "../config/firebase.config";
import {StorageService} from "./storage.service";
import {
  Problem,
  Solution,
  FoodAnalysis,
} from "../types/api.types";
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
   */
  static async analyzeFood(
    userId: string,
    imageId: string
  ): Promise<FoodAnalysis> {
    // Download image from storage
    const imageBuffer = await StorageService.downloadImage(userId, imageId);
    return this.analyzeFoodImageBuffer(imageBuffer);
  }

  /**
   * Analyze a provided food image buffer
   */
  static async analyzeFoodImageBuffer(
    imageBuffer: Buffer
  ): Promise<FoodAnalysis> {
    // Convert to base64 for Gemini
    const base64Image = imageBuffer.toString("base64");

    // Build analysis prompt
    const prompt = this.buildFoodAnalysisPrompt();

    // Call Gemini API
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

    // Parse AI response (expecting JSON)
    const analysis = this.parseFoodAIResponse(text);

    return analysis;
  }

  /**
   * Build food analysis prompt
   */
  private static buildFoodAnalysisPrompt(): string {
    return `
You are an expert culinary assistant and nutritionist. Analyze this image to identify food items, ingredients, and products.

Analyze the image and return ONLY a valid JSON object (no markdown, no explanations).

For each item identified, provide:
1. "name": Common name of the ingredient or food item
2. "category": Category (e.g., Produce, Dairy, Meat, Pantry, Bakery, etc.)
3. "notes": Brief notes about the item (e.g., ripeness, quantity, brand if visible, or suggestions for use)
4. "confidence": A score from 0 to 1 for identification accuracy

**Response format (JSON only):**

{
  "items": [
    {
      "name": "Organic Whole Milk",
      "category": "Dairy",
      "notes": "Half-full carton, Horizon brand",
      "confidence": 0.95
    },
    {
      "name": "Avocado",
      "category": "Produce",
      "notes": "Appears ripe and ready to use",
      "confidence": 0.9
    }
  ],
  "summary": "Short 1-2 sentence overview of the items found in the image"
}

Be precise and helpful. Return ONLY valid JSON.
`;
  }

  /**
   * Parse AI response to structured food analysis
   */
  private static parseFoodAIResponse(responseText: string): FoodAnalysis {
    try {
      // Remove markdown code blocks if present
      let cleanText = responseText.trim();

      if (cleanText.startsWith("```json")) {
        cleanText = cleanText.replace(/```json\n?/g, "").replace(/```\n?/g, "");
      } else if (cleanText.startsWith("```")) {
        cleanText = cleanText.replace(/```\n?/g, "");
      }

      const parsed = JSON.parse(cleanText);

      // Add metadata
      return {
        ...parsed,
        analyzedAt: new Date().toISOString(),
        version: "1.0",
      };
    } catch (error) {
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
   * Generate a fixed room image (DEPRECATED)
   */
  static async generateFixedImage(
    userId: string,
    imageId: string,
    problemsToFix: Array<{
      problem: Problem;
      solution: Solution;
      dimension: string;
    }>,
    sourceImageBuffer?: Buffer
  ): Promise<{
    imageBuffer: Buffer;
    changesApplied: string[];
    fixName?: string;
    summary?: string;
  }> {
    const imageBuffer =
      sourceImageBuffer ||
      (await StorageService.downloadImage(userId, imageId));

    if (sourceImageBuffer) {
      logger.info("ai:processing-frame", {
        bufferSize: imageBuffer.length,
        isVideoFrame: !userId,
      });
    }

    const base64Image = imageBuffer.toString("base64");
    const prompt = this.buildFixPrompt(problemsToFix);

    const requestGeminiFix = () =>
      geminiImageModel.generateContent([
        {
          inlineData: {
            data: base64Image,
            mimeType: "image/jpeg",
          },
        },
        {text: prompt},
      ]);

    const metadataPromise = this.generateFixMetadata(problemsToFix);

    const result =
      process.env.GEMINI_ENABLE_RETRY === "true"
        ? await this.withGeminiRetry(requestGeminiFix)
        : await requestGeminiFix();

    const response = await result.response;
    const generatedImageBuffer = this.extractGeneratedImage(response);
    const changesApplied = this.extractChangesApplied(response, problemsToFix);

    if (!generatedImageBuffer) {
      throw new Error("Failed to generate fixed image");
    }

    const [, fixMetadata] = await Promise.all([
      this.validateImageContent(generatedImageBuffer),
      metadataPromise,
    ]);

    return {
      imageBuffer: generatedImageBuffer,
      changesApplied,
      fixName: fixMetadata.fixName,
      summary: fixMetadata.summary,
    };
  }

  private static buildFixPrompt(
    problemsToFix: Array<{
      problem: Problem;
      solution: Solution;
      dimension: string;
    }>
  ): string {
    return `Edit this room image to fix problems.`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static extractGeneratedImage(response: any): Buffer | null {
    try {
      const candidates = response.candidates;
      if (!candidates || candidates.length === 0) return null;
      const parts = candidates[0].content?.parts;
      if (!parts) return null;

      for (const part of parts) {
        if (part.inlineData?.data) {
          return Buffer.from(part.inlineData.data, "base64");
        }
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  private static extractChangesApplied(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response: any,
    problemsToFix: Array<{
      problem: Problem;
      solution: Solution;
      dimension: string;
    }>
  ): string[] {
    return problemsToFix.map((p) => p.solution.title);
  }

  static async generateFixMetadata(
    problemsToFix: Array<{
      problem: Problem;
      solution: Solution;
      dimension: string;
    }>
  ): Promise<{fixName: string; summary: string}> {
    return {fixName: "Fixed", summary: "Summary of changes"};
  }

  /**
   * Generate a design plan (DEPRECATED)
   */
  static async generateFixPlan(
    frameBuffer: Buffer,
    problemsToFix: Array<{
      problem: Problem;
      solution: Solution;
      dimension: string;
    }>
  ): Promise<string> {
    return "Design plan description.";
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
