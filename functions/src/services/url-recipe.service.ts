/**
 * URL Recipe Extraction Service
 *
 * Extracts recipes from video URLs using Gemini AI.
 * - YouTube: Native Gemini fileData (watches the actual video, no download)
 * - Any other URL: Gemini URL Context tool (reads the webpage content via REST API)
 *
 * No downloads, no storage, no yt-dlp. Original URL kept for frontend preview/embed.
 */

import axios from "axios";
import * as crypto from "crypto";
import {database, geminiModel} from "../config/firebase.config";
import {CacheService} from "./cache.service";
import {CACHE_KEYS, CACHE_TTL, REDIS_ENABLED} from "../config/redis.config";
import {URL_MAX_LENGTH, YOUTUBE_URL_PATTERNS} from "../config/constants";
import {GEMINI_MODELS} from "../types/gemini.types";
import {
  UrlExtractionMetadata,
  UrlRecipeResult,
  ExtractedRecipe,
  VideoPlatform,
  RecipeUrlAnalysisStatus,
  UrlExtractionMessage,
  SharedUrlRecipe,
} from "../types/recipe-url.types";
import * as logger from "firebase-functions/logger";

export class UrlRecipeService {
  // ──────────────────────────────────────────
  // URL Validation & Platform Detection
  // ──────────────────────────────────────────

  /**
   * Validate URL and detect platform.
   * Supports any URL: YouTube uses native video analysis, others use URL context.
   */
  static validateUrl(url: string): {
    valid: boolean;
    platform: VideoPlatform;
    normalizedUrl: string;
    error?: string;
  } {
    if (!url || typeof url !== "string") {
      return {
        valid: false,
        platform: "unknown",
        normalizedUrl: "",
        error: "URL is required",
      };
    }

    const trimmedUrl = url.trim();

    if (trimmedUrl.length > URL_MAX_LENGTH) {
      return {
        valid: false,
        platform: "unknown",
        normalizedUrl: trimmedUrl,
        error: "URL is too long",
      };
    }

    let parsed: URL;
    try {
      parsed = new URL(trimmedUrl);
    } catch {
      return {
        valid: false,
        platform: "unknown",
        normalizedUrl: trimmedUrl,
        error: "Invalid URL format",
      };
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return {
        valid: false,
        platform: "unknown",
        normalizedUrl: trimmedUrl,
        error: "URL must use HTTP or HTTPS",
      };
    }

    const platform = this.detectPlatform(trimmedUrl);

    // Normalize YouTube URLs to canonical form
    const normalizedUrl =
      platform === "youtube"
        ? this.normalizeYouTubeUrl(trimmedUrl)
        : trimmedUrl;

    return {valid: true, platform, normalizedUrl};
  }

  /**
   * Detect video platform from URL
   */
  static detectPlatform(url: string): VideoPlatform {
    const lower = url.toLowerCase();
    if (YOUTUBE_URL_PATTERNS.some((p) => p.test(lower))) return "youtube";
    if (lower.includes("instagram.com") || lower.includes("instagr.am")) {
      return "instagram";
    }
    if (lower.includes("tiktok.com") || lower.includes("vm.tiktok.com")) {
      return "tiktok";
    }
    if (lower.includes("facebook.com") || lower.includes("fb.watch")) {
      return "facebook";
    }
    return "unknown";
  }

  /**
   * Normalize YouTube URL to canonical form
   */
  static normalizeYouTubeUrl(url: string): string {
    let videoId: string | null = null;

    // youtu.be/VIDEO_ID
    const shortMatch = url.match(/youtu\.be\/([\w-]+)/);
    if (shortMatch) videoId = shortMatch[1];

    // youtube.com/watch?v=VIDEO_ID
    if (!videoId) {
      const watchMatch = url.match(/[?&]v=([\w-]+)/);
      if (watchMatch) videoId = watchMatch[1];
    }

    // youtube.com/shorts/VIDEO_ID
    if (!videoId) {
      const shortsMatch = url.match(/shorts\/([\w-]+)/);
      if (shortsMatch) videoId = shortsMatch[1];
    }

    if (videoId) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
    return url;
  }

  // ──────────────────────────────────────────
  // Submission
  // ──────────────────────────────────────────

  /**
   * Generate SHA-256 hash of normalized URL for deduplication
   */
  private static generateUrlHash(normalizedUrl: string): string {
    return crypto.createHash("sha256").update(normalizedUrl).digest("hex");
  }

  /**
   * Check if this URL has been processed before (across all users).
   * Returns shared recipe data if found.
   */
  private static async checkSharedRecipe(
    normalizedUrl: string
  ): Promise<SharedUrlRecipe | null> {
    const urlHash = this.generateUrlHash(normalizedUrl);
    const shortHash = urlHash.slice(0, 16);

    // Step 1: Check Redis cache (if available)
    if (REDIS_ENABLED) {
      const cachedRecipe = await CacheService.get<SharedUrlRecipe>(
        CACHE_KEYS.urlHash(urlHash)
      );
      if (cachedRecipe) {
        logger.info("url-recipe:dedup:cache-hit", {shortHash});
        return cachedRecipe;
      }
    }

    // Step 2: Check database
    try {
      const sharedRef = database.ref(`sharedUrlRecipes/${urlHash}`);
      const snapshot = await sharedRef.get();

      if (snapshot.exists()) {
        const sharedRecipe = snapshot.val() as SharedUrlRecipe;

        // Cache for future lookups
        if (REDIS_ENABLED) {
          CacheService.set(
            CACHE_KEYS.urlHash(urlHash),
            sharedRecipe,
            CACHE_TTL.IMAGE_HASH // 30 days
          ).catch(() => {});
        }

        logger.info("url-recipe:dedup:db-hit", {shortHash});
        return sharedRecipe;
      }
    } catch (error) {
      logger.error("url-recipe:dedup:check-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info("url-recipe:dedup:miss", {shortHash});
    return null;
  }

  /**
   * Save recipe to shared storage for future deduplication
   */
  private static async saveSharedRecipe(
    normalizedUrl: string,
    platform: VideoPlatform,
    recipe: ExtractedRecipe,
    confidence: number,
    isRecipeVideo: boolean,
    modelUsed: string,
    userId: string
  ): Promise<void> {
    const urlHash = this.generateUrlHash(normalizedUrl);

    try {
      const sharedRef = database.ref(`sharedUrlRecipes/${urlHash}`);
      const snapshot = await sharedRef.get();

      if (snapshot.exists()) {
        // Recipe already exists, increment counter
        await sharedRef.update({
          extractionCount: (snapshot.val().extractionCount || 1) + 1,
        });
      } else {
        // First time this URL is processed
        const sharedRecipe: SharedUrlRecipe = {
          urlHash,
          normalizedUrl,
          platform,
          recipe,
          confidence,
          isRecipeVideo,
          modelUsed,
          firstExtractedAt: new Date().toISOString(),
          firstExtractedBy: userId,
          extractionCount: 1,
          version: "1.0",
        };

        await sharedRef.set(sharedRecipe);

        // Cache it
        if (REDIS_ENABLED) {
          CacheService.set(
            CACHE_KEYS.urlHash(urlHash),
            sharedRecipe,
            CACHE_TTL.IMAGE_HASH // 30 days
          ).catch(() => {});
        }
      }

      logger.info("url-recipe:shared-recipe:saved", {
        urlHash: urlHash.slice(0, 16),
      });
    } catch (error) {
      logger.error("url-recipe:shared-recipe:save-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - this is not critical
    }
  }

  /**
   * Extract recipe from a URL synchronously.
   * Checks dedup cache first, otherwise calls Gemini directly,
   * saves all results to the database, and returns the full recipe.
   */
  static async extractRecipeSync(
    userId: string,
    sourceUrl: string,
    platform: VideoPlatform,
    normalizedUrl: string
  ): Promise<{
    urlId: string;
    recipe: ExtractedRecipe;
    confidence: number;
    isRecipeVideo: boolean;
    fromCache: boolean;
  }> {
    const {v4: uuidv4} = await import("uuid");
    const urlId = `url_${uuidv4()}`;
    const submittedAt = new Date().toISOString();
    const startTime = Date.now();

    // Check if this URL has been processed before (deduplication)
    const sharedRecipe = await this.checkSharedRecipe(normalizedUrl);

    if (sharedRecipe && sharedRecipe.isRecipeVideo) {
      logger.info("url-recipe:dedup:reusing", {
        urlId,
        userId,
        platform,
        urlHash: sharedRecipe.urlHash.slice(0, 16),
      });

      // Create metadata pointing to shared recipe (instant completion)
      const metadata: UrlExtractionMetadata = {
        urlId,
        userId,
        sourceUrl,
        normalizedUrl,
        platform,
        analysisStatus: "completed",
        videoTitle: sharedRecipe.recipe.title,
        submittedAt,
        completedAt: submittedAt,
      };

      const recipeResult: UrlRecipeResult = {
        urlId,
        userId,
        sourceUrl,
        platform,
        recipe: sharedRecipe.recipe,
        confidence: sharedRecipe.confidence,
        isRecipeVideo: sharedRecipe.isRecipeVideo,
        modelUsed: sharedRecipe.modelUsed,
        processingDurationMs: 0,
        analyzedAt: submittedAt,
        version: sharedRecipe.version,
      };

      // Save both records
      await Promise.all([
        database.ref(`urlExtractions/${urlId}`).set(metadata),
        database.ref(`urlRecipes/${urlId}`).set(recipeResult),
        CacheService.delete(CACHE_KEYS.urlExtractionList(userId)),
      ]);

      return {
        urlId,
        recipe: sharedRecipe.recipe,
        confidence: sharedRecipe.confidence,
        isRecipeVideo: true,
        fromCache: true,
      };
    }

    // No cached recipe - process directly via Gemini
    logger.info("url-recipe:sync-processing:start", {
      urlId,
      userId,
      platform,
    });

    const result = await this.analyzeVideoUrl(sourceUrl, platform);
    const processingDurationMs = Date.now() - startTime;

    // Build full result
    const metadata: UrlExtractionMetadata = {
      urlId,
      userId,
      sourceUrl,
      normalizedUrl,
      platform,
      analysisStatus: "completed",
      videoTitle: result.recipe.title,
      submittedAt,
      completedAt: new Date().toISOString(),
    };

    const recipeResult: UrlRecipeResult = {
      urlId,
      userId,
      sourceUrl,
      platform,
      recipe: result.recipe,
      confidence: result.confidence,
      isRecipeVideo: result.isRecipeVideo,
      modelUsed: GEMINI_MODELS.GEMINI_3_FLASH_PREVIEW,
      processingDurationMs,
      analyzedAt: new Date().toISOString(),
      version: "1.0",
    };

    // Save results and invalidate caches
    await Promise.all([
      database.ref(`urlExtractions/${urlId}`).set(metadata),
      database.ref(`urlRecipes/${urlId}`).set(recipeResult),
      CacheService.delete(CACHE_KEYS.urlExtractionList(userId)),
    ]);

    // Save to shared storage for future deduplication (non-blocking)
    if (result.isRecipeVideo && result.confidence >= 0.5) {
      this.saveSharedRecipe(
        normalizedUrl,
        platform,
        result.recipe,
        result.confidence,
        result.isRecipeVideo,
        GEMINI_MODELS.GEMINI_3_FLASH_PREVIEW,
        userId
      ).catch((err) => {
        logger.error("url-recipe:shared-save:failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    logger.info("url-recipe:sync-processing:completed", {
      urlId,
      userId,
      processingDurationMs,
      isRecipeVideo: result.isRecipeVideo,
      ingredientCount: result.recipe.ingredients.length,
      stepCount: result.recipe.steps.length,
    });

    return {
      urlId,
      recipe: result.recipe,
      confidence: result.confidence,
      isRecipeVideo: result.isRecipeVideo,
      fromCache: false,
    };
  }

  // ──────────────────────────────────────────
  // Processing (called by Pub/Sub worker)
  // ──────────────────────────────────────────

  /**
   * Process a URL extraction job.
   * Called by the Pub/Sub worker function.
   */
  static async processExtraction(message: UrlExtractionMessage): Promise<void> {
    const {urlId, userId, sourceUrl, platform} = message;
    const startTime = Date.now();

    logger.info("url-recipe:processing:start", {urlId, userId, platform});

    try {
      // Update status to analyzing
      await this.updateStatus(urlId, "analyzing");

      // Get metadata to retrieve normalized URL
      const metadataSnapshot = await database
        .ref(`urlExtractions/${urlId}`)
        .get();
      const metadata = metadataSnapshot.val() as UrlExtractionMetadata;
      const normalizedUrl = metadata.normalizedUrl || sourceUrl;

      // Call Gemini with video URL
      const result = await this.analyzeVideoUrl(sourceUrl, platform);
      const processingDurationMs = Date.now() - startTime;

      // Build result
      const recipeResult: UrlRecipeResult = {
        urlId,
        userId,
        sourceUrl,
        platform,
        recipe: result.recipe,
        confidence: result.confidence,
        isRecipeVideo: result.isRecipeVideo,
        modelUsed: GEMINI_MODELS.GEMINI_3_FLASH_PREVIEW,
        processingDurationMs,
        analyzedAt: new Date().toISOString(),
        version: "1.0",
      };

      // Save results and update status
      await Promise.all([
        database.ref(`urlRecipes/${urlId}`).set(recipeResult),
        database.ref(`urlExtractions/${urlId}`).update({
          analysisStatus: "completed",
          completedAt: new Date().toISOString(),
          videoTitle: result.recipe.title,
        }),
        CacheService.delete(CACHE_KEYS.urlExtractionList(userId)),
      ]);

      // Save to shared storage for future deduplication (if it's a valid recipe)
      if (result.isRecipeVideo && result.confidence >= 0.5) {
        await this.saveSharedRecipe(
          normalizedUrl,
          platform,
          result.recipe,
          result.confidence,
          result.isRecipeVideo,
          GEMINI_MODELS.GEMINI_3_FLASH_PREVIEW,
          userId
        );
      }

      logger.info("url-recipe:processing:completed", {
        urlId,
        userId,
        processingDurationMs,
        isRecipeVideo: result.isRecipeVideo,
        ingredientCount: result.recipe.ingredients.length,
        stepCount: result.recipe.steps.length,
      });
    } catch (error) {
      logger.error("url-recipe:processing:failed", {
        urlId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      await database.ref(`urlExtractions/${urlId}`).update({
        analysisStatus: "failed",
        error:
          error instanceof Error
            ? error.message
            : "Recipe extraction failed. Please try again.",
      });

      // Do NOT re-throw to prevent infinite Pub/Sub retries
    }
  }

  // ──────────────────────────────────────────
  // Gemini AI Analysis
  // ──────────────────────────────────────────

  /**
   * Route to the correct analysis method based on platform.
   * - YouTube: Native Gemini fileData (watches the actual video)
   * - Everything else: Gemini URL Context tool (reads the webpage content)
   */
  static async analyzeVideoUrl(
    url: string,
    platform: VideoPlatform
  ): Promise<{
    recipe: ExtractedRecipe;
    confidence: number;
    isRecipeVideo: boolean;
  }> {
    if (platform === "youtube") {
      return this.analyzeYouTubeVideo(url);
    }
    return this.analyzeUrlWithContext(url, platform);
  }

  /**
   * YouTube: Use Gemini native fileData to watch and analyze the video directly.
   * No download needed - Gemini processes YouTube URLs natively.
   */
  private static async analyzeYouTubeVideo(url: string): Promise<{
    recipe: ExtractedRecipe;
    confidence: number;
    isRecipeVideo: boolean;
  }> {
    const prompt = this.buildVideoRecipePrompt();

    const result = await geminiModel.generateContent([
      {
        fileData: {
          fileUri: url,
          mimeType: "video/*",
        },
      },
      {text: prompt},
    ]);

    const text = result.response.text();
    return this.parseRecipeResponse(text);
  }

  /**
   * Non-YouTube: Use Gemini REST API with URL Context tool.
   * Gemini visits the URL, reads the page content (text, images, captions),
   * and extracts the recipe. Works with any public webpage.
   */
  private static async analyzeUrlWithContext(
    url: string,
    platform: VideoPlatform
  ): Promise<{
    recipe: ExtractedRecipe;
    confidence: number;
    isRecipeVideo: boolean;
  }> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not configured");
    }

    const prompt = this.buildUrlRecipePrompt(url, platform);
    const model = GEMINI_MODELS.GEMINI_3_FLASH_PREVIEW;
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    logger.info("url-recipe:url-context:calling", {url, platform, model});

    const response = await axios.post(
      apiUrl,
      {
        contents: [{parts: [{text: prompt}]}],
        tools: [{url_context: {}}],
      },
      {
        headers: {"Content-Type": "application/json"},
        timeout: 120000, // 2 min timeout for URL fetch + analysis
      }
    );

    const text =
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!text) {
      logger.error("url-recipe:url-context:empty-response", {url, platform});
      throw new Error("Gemini returned an empty response for this URL");
    }

    return this.parseRecipeResponse(text);
  }

  // ──────────────────────────────────────────
  // Prompts
  // ──────────────────────────────────────────

  /**
   * Prompt for YouTube videos (Gemini watches the actual video)
   */
  private static buildVideoRecipePrompt(): string {
    return `You are an expert chef and recipe analyst. Watch this cooking video
carefully and extract the complete recipe.

**YOUR TASK:**
Analyze the entire video and extract a complete, reproducible recipe with precise measurements.

**EXTRACTION RULES:**
1. Watch the ENTIRE video before responding
2. Extract EXACT quantities shown or mentioned (e.g., "2 cups flour" not just "flour")
3. If quantities are not explicitly stated, estimate based on visual observation and note it
4. Capture EVERY ingredient, even small ones (salt, oil, garnishes)
5. Write step-by-step instructions in clear, imperative sentences
6. Note any tips, techniques, or variations mentioned by the creator
7. Estimate timings based on what you observe in the video

${this.getRecipeResponseFormat()}`;
  }

  /**
   * Prompt for non-YouTube URLs (Gemini reads the webpage via URL context)
   */
  private static buildUrlRecipePrompt(
    url: string,
    platform: VideoPlatform
  ): string {
    const platformHint = this.getPlatformHint(platform);

    return `You are an expert chef and recipe analyst. Visit and thoroughly read the content at this URL:

${url}

${platformHint}

**YOUR TASK:**
Extract the complete recipe from this page with precise measurements.

**EXTRACTION RULES:**
1. Read ALL content on the page (text, captions, descriptions, comments)
2. Extract EXACT quantities as written (e.g., "2 cups flour" not just "flour")
3. Capture EVERY ingredient, even small ones (salt, oil, garnishes)
4. Write step-by-step instructions in clear, imperative sentences
5. If the page has a video description with recipe details, use that information
6. Look for recipe cards, ingredient lists, and instruction sections

${this.getRecipeResponseFormat()}`;
  }

  /**
   * Platform-specific hints to help the AI find recipe content
   */
  private static getPlatformHint(platform: VideoPlatform): string {
    switch (platform) {
      case "instagram":
        return (
          "This is an Instagram post. The recipe may be in the caption, " +
          "comments, or the post description. Look for ingredient lists " +
          "and cooking steps in the text."
        );
      case "tiktok":
        return (
          "This is a TikTok post. The recipe may be in the video " +
          "description, pinned comments, or creator bio link. Extract " +
          "whatever recipe information is available on the page."
        );
      case "facebook":
        return (
          "This is a Facebook post. The recipe may be in the post text, " +
          "comments, or linked content."
        );
      default:
        return "Extract the recipe from whatever content is available on this page.";
    }
  }

  /**
   * Shared JSON response format used by both YouTube and URL context prompts
   */
  private static getRecipeResponseFormat(): string {
    return `**INGREDIENT CATEGORIES** (for grocery list grouping):
- Produce (fruits, vegetables, herbs)
- Meat & Seafood
- Dairy & Eggs
- Bakery & Bread
- Pantry (flour, sugar, rice, pasta, canned goods)
- Spices & Seasonings
- Oils & Condiments
- Frozen
- Beverages
- Other

**RESPONSE FORMAT:**
Return ONLY a valid JSON object (no markdown, no explanations):

{
  "isRecipeVideo": true,
  "confidence": 0.95,
  "recipe": {
    "title": "Creamy Garlic Tuscan Chicken",
    "description": "A rich, creamy one-pan chicken dish with sun-dried tomatoes and spinach",
    "ingredients": [
      {
        "name": "chicken breast",
        "quantity": 2,
        "unit": "pieces",
        "category": "Meat & Seafood",
        "preparation": "pounded to even thickness",
        "optional": false
      },
      {
        "name": "heavy cream",
        "quantity": 1,
        "unit": "cup",
        "category": "Dairy & Eggs",
        "optional": false
      },
      {
        "name": "red pepper flakes",
        "quantity": 0.25,
        "unit": "tsp",
        "category": "Spices & Seasonings",
        "optional": true
      }
    ],
    "steps": [
      {
        "stepNumber": 1,
        "instruction": "Season the chicken breasts with salt and pepper on both sides.",
        "durationMinutes": 2,
        "tip": "Pat the chicken dry first for better browning"
      },
      {
        "stepNumber": 2,
        "instruction": "Heat olive oil in a large skillet over medium-high heat. " +
          "Sear chicken 5-6 minutes per side until golden.",
        "durationMinutes": 12
      }
    ],
    "timings": {
      "prepMinutes": 10,
      "cookMinutes": 25,
      "totalMinutes": 35,
      "restMinutes": 5
    },
    "servings": 4,
    "difficulty": "easy",
    "cuisine": "Italian",
    "mealType": "dinner",
    "dietaryTags": ["gluten-free"],
    "nutrition": {
      "calories": 450,
      "proteinGrams": 35,
      "carbsGrams": 8,
      "fatGrams": 30,
      "fiberGrams": 2
    },
    "equipment": ["large skillet", "tongs", "cutting board"]
  }
}

**IMPORTANT EDGE CASES:**
- If this is NOT a cooking/recipe page, set "isRecipeVideo" to false and
  provide a minimal recipe object with empty arrays and the title "Not a recipe"
- If the content shows multiple recipes, extract the PRIMARY/MAIN recipe only
- If quantities are unclear, use your best culinary judgment and set confidence lower
- "quantity" must be a number or null (for "to taste" items).
  Use null for "to taste" or "as needed"
- "unit" should be standardized: "cups", "tbsp", "tsp", "oz", "lbs",
  "pieces", "cloves", "pinch", "to taste"
- Difficulty: "easy" (under 30 min, basic techniques),
  "medium" (30-60 min or moderate skill),
  "hard" (60+ min or advanced techniques)

Be thorough and precise. A home cook should be able to reproduce this recipe from your extraction alone.`;
  }

  /**
   * Parse the AI response into structured recipe data
   */
  private static parseRecipeResponse(responseText: string): {
    recipe: ExtractedRecipe;
    confidence: number;
    isRecipeVideo: boolean;
  } {
    try {
      let cleanText = responseText.trim();
      if (cleanText.startsWith("```json")) {
        cleanText = cleanText.replace(/```json\n?/g, "").replace(/```\n?/g, "");
      } else if (cleanText.startsWith("```")) {
        cleanText = cleanText.replace(/```\n?/g, "");
      }

      const parsed = JSON.parse(cleanText);

      return {
        recipe: parsed.recipe,
        confidence:
          typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
        isRecipeVideo: parsed.isRecipeVideo !== false,
      };
    } catch (error) {
      logger.error("url-recipe:parse:failed", {error});
      return {
        recipe: this.getFallbackRecipe(),
        confidence: 0,
        isRecipeVideo: false,
      };
    }
  }

  /**
   * Fallback recipe if AI parsing fails
   */
  private static getFallbackRecipe(): ExtractedRecipe {
    return {
      title: "Recipe extraction failed",
      description:
        "Could not extract recipe from this video. Please try again.",
      ingredients: [],
      steps: [],
      timings: {prepMinutes: 0, cookMinutes: 0, totalMinutes: 0},
      servings: 0,
      difficulty: "easy",
      cuisine: "Unknown",
    };
  }

  // ──────────────────────────────────────────
  // Query Methods
  // ──────────────────────────────────────────

  /**
   * Get extraction metadata and recipe by ID, with ownership check
   */
  static async getExtraction(
    userId: string,
    urlId: string
  ): Promise<{metadata: UrlExtractionMetadata; recipe?: UrlRecipeResult}> {
    const metadataSnapshot = await database
      .ref(`urlExtractions/${urlId}`)
      .get();
    if (!metadataSnapshot.exists()) {
      throw {error: "Not Found", message: "URL extraction not found"};
    }

    const metadata: UrlExtractionMetadata = metadataSnapshot.val();
    if (metadata.userId !== userId) {
      throw {
        error: "Forbidden",
        message: "You do not have access to this extraction",
      };
    }

    if (metadata.analysisStatus !== "completed") {
      return {metadata};
    }

    // Fetch recipe result (try cache first)
    const cacheKey = CACHE_KEYS.urlRecipe(urlId);
    let recipe = await CacheService.get<UrlRecipeResult>(cacheKey);

    if (!recipe) {
      const recipeSnapshot = await database.ref(`urlRecipes/${urlId}`).get();
      if (recipeSnapshot.exists()) {
        recipe = recipeSnapshot.val() as UrlRecipeResult;
        // Cache for future reads
        CacheService.set(cacheKey, recipe, CACHE_TTL.ANALYSIS_RESULT).catch(
          () => {}
        );
      }
    }

    return {metadata, recipe: recipe ?? undefined};
  }

  /**
   * List user's URL extractions with full recipe data (newest first)
   */
  static async listExtractions(userId: string): Promise<
    Array<{
      metadata: UrlExtractionMetadata;
      recipe?: UrlRecipeResult;
    }>
  > {
    const snapshot = await database
      .ref("urlExtractions")
      .orderByChild("userId")
      .equalTo(userId)
      .get();

    if (!snapshot.exists()) return [];

    const extractions: UrlExtractionMetadata[] = [];
    snapshot.forEach((child) => {
      extractions.push(child.val());
    });

    // Sort newest first
    extractions.sort(
      (a, b) =>
        new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
    );

    // Fetch recipe data for completed extractions
    const result = await Promise.all(
      extractions.map(async (metadata) => {
        if (metadata.analysisStatus !== "completed") {
          return {metadata};
        }

        // Try to get recipe from cache first
        const cacheKey = CACHE_KEYS.urlRecipe(metadata.urlId);
        let recipe = await CacheService.get<UrlRecipeResult>(cacheKey);

        if (!recipe) {
          const recipeSnapshot = await database
            .ref(`urlRecipes/${metadata.urlId}`)
            .get();
          if (recipeSnapshot.exists()) {
            recipe = recipeSnapshot.val() as UrlRecipeResult;
            // Cache for future reads
            CacheService.set(cacheKey, recipe, CACHE_TTL.ANALYSIS_RESULT).catch(
              () => {}
            );
          }
        }

        return {metadata, recipe: recipe ?? undefined};
      })
    );

    return result;
  }

  // ──────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────

  private static async updateStatus(
    urlId: string,
    status: RecipeUrlAnalysisStatus
  ): Promise<void> {
    await database
      .ref(`urlExtractions/${urlId}`)
      .update({analysisStatus: status});
  }
}
