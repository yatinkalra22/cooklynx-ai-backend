import {
  geminiModel,
  geminiImageModel,
  geminiModerationModel,
} from "../config/firebase.config";
import {StorageService} from "./storage.service";
import {Problem, Solution, DimensionAnalysis} from "../types/api.types";
import {VIDEO_MODERATION_BATCH_SIZE} from "../config/constants";
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

/**
 * Complete room analysis result
 */
export interface RoomAnalysis {
  overall: {
    score: number;
    grade: "A" | "B" | "C" | "D" | "F";
    summary: string;
  };
  dimensions: {
    lighting: DimensionAnalysis;
    spatial: DimensionAnalysis;
    color: DimensionAnalysis;
    clutter: DimensionAnalysis;
    biophilic: DimensionAnalysis;
    fengShui: DimensionAnalysis;
  };
  analyzedAt: string;
  version: string;
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

IMPORTANT: This is an interior design app. We expect images of rooms, spaces, and interiors.
If the image is NOT a room/space/interior, it may still be acceptable if it's appropriate content.

Respond with ONLY this JSON format:
{
  "safe": true/false,
  "category": "none" | "csam" | "adult" | "violence" | "inappropriate",
  "reason": "Brief explanation if not safe, or 'Content is appropriate' if safe",
  "isRoom": true/false
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
      console.error("Content moderation failed:", error);
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
   * Analyze room image with Gemini AI
   */
  static async analyzeRoom(
    userId: string,
    imageId: string
  ): Promise<RoomAnalysis> {
    // Download image from storage
    const imageBuffer = await StorageService.downloadImage(userId, imageId);
    return this.analyzeImageBuffer(imageBuffer);
  }

  /**
   * Analyze a provided image buffer (used for fixed images)
   */
  static async analyzeImageBuffer(imageBuffer: Buffer): Promise<RoomAnalysis> {
    // Convert to base64 for Gemini
    const base64Image = imageBuffer.toString("base64");

    // Build analysis prompt
    const prompt = this.buildAnalysisPrompt();

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
    const analysis = this.parseAIResponse(text);

    return analysis;
  }

  /**
   * Build comprehensive analysis prompt
   */
  private static buildAnalysisPrompt(): string {
    return `
You are an expert interior designer and environmental psychologist analyzing a room image.

Analyze this room across 6 dimensions and return ONLY a valid JSON object (no markdown, no explanations).

For each dimension, provide:
1. A score (0-100)
2. Status: "excellent" (80-100), "good" (60-79), "needs_improvement" (40-59), or "poor" (0-39)
3. 1-3 specific problems found
4. 2-3 concrete solutions for each problem

**Dimensions to analyze:**

1. **Lighting Quality** (0-100)
   - Natural light presence and distribution
   - Circadian rhythm alignment
   - Glare, shadows, and harsh lighting
   - Color temperature appropriateness

2. **Spatial Balance** (0-100)
   - Symmetry and visual proportions
   - Furniture placement and scale
   - Traffic flow and walkways
   - Room layout efficiency

3. **Color Psychology** (0-100)
   - Color harmony and contrast
   - Emotional impact of colors
   - Color balance (warm vs cool)
   - Cultural color appropriateness

4. **Clutter Index** (0-100, lower clutter = higher score)
   - Visual noise and chaos
   - Organization and tidiness
   - Surface coverage
   - Cognitive load reduction

5. **Biophilic Elements** (0-100)
   - Plants and natural elements
   - Natural materials (wood, stone)
   - Organic shapes and patterns
   - Connection to nature

6. **Feng Shui Principles** (0-100)
   - Energy flow (Chi)
   - Five elements balance
   - Commanding position
   - Clutter-free pathways

**Response format (JSON only):**

{
  "overall": {
    "score": 75,
    "grade": "B",
    "summary": "Brief 1-2 sentence overall assessment"
  },
  "dimensions": {
    "lighting": {
      "score": 65,
      "status": "good",
      "problems": [
        {
          "problemId": "light_1",
          "title": "Harsh overhead lighting",
          "description": "Single ceiling fixture creates harsh shadows",
          "impact": "Disrupts circadian rhythm and causes eye strain",
          "research": "Harvard study shows harsh lighting reduces productivity by 23%",
          "severity": "high"
        }
      ],
      "solutions": [
        {
          "solutionId": "sol_light_1",
          "problemId": "light_1",
          "title": "Add layered ambient lighting",
          "description": "Install warm LED floor lamps in corners",
          "steps": [
            "Add 2-3 floor lamps with warm bulbs (2700K)",
            "Position in room corners",
            "Use dimmer switches for control"
          ],
          "costEstimate": "$80-200",
          "difficulty": "easy",
          "timeEstimate": "30 minutes",
          "priority": 1
        }
      ]
    },
    "spatial": { ... },
    "color": { ... },
    "clutter": { ... },
    "biophilic": { ... },
    "fengShui": { ... }
  }
}

Be specific, actionable, and research-backed. Return ONLY valid JSON.
`;
  }

  /**
   * Parse AI response to structured analysis
   */
  private static parseAIResponse(responseText: string): RoomAnalysis {
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
      return this.getFallbackAnalysis();
    }
  }

  /**
   * Fallback analysis if AI parsing fails
   */
  private static getFallbackAnalysis(): RoomAnalysis {
    return {
      overall: {
        score: 50,
        grade: "C",
        summary: "Analysis could not be completed. Please try again.",
      },
      dimensions: {
        lighting: this.getEmptyDimension(),
        spatial: this.getEmptyDimension(),
        color: this.getEmptyDimension(),
        clutter: this.getEmptyDimension(),
        biophilic: this.getEmptyDimension(),
        fengShui: this.getEmptyDimension(),
      },
      analyzedAt: new Date().toISOString(),
      version: "1.0",
    };
  }

  private static getEmptyDimension(): DimensionAnalysis {
    return {
      score: 50,
      status: "needs_improvement",
      problems: [],
      solutions: [],
    };
  }

  /**
   * Generate a fixed room image using Gemini's image generation
   * OPTIMIZED: Runs metadata generation in parallel with image generation
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
    // Download original image if not provided
    const imageBuffer =
      sourceImageBuffer ||
      (await StorageService.downloadImage(userId, imageId));

    // Log frame info for debugging video frame issues
    if (sourceImageBuffer) {
      logger.info("ai:processing-frame", {
        bufferSize: imageBuffer.length,
        isVideoFrame: !userId, // Empty userId indicates video frame
      });
    }

    const base64Image = imageBuffer.toString("base64");

    // Build the fix prompt
    const prompt = this.buildFixPrompt(problemsToFix);

    // Call Gemini with image generation enabled (retry is opt-in via GEMINI_ENABLE_RETRY)
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

    // OPTIMIZATION: Start metadata generation in parallel with image generation
    const metadataPromise = this.generateFixMetadata(problemsToFix);

    const result =
      process.env.GEMINI_ENABLE_RETRY === "true"
        ? await this.withGeminiRetry(requestGeminiFix)
        : await requestGeminiFix();

    const response = await result.response;

    // Parse response - extract image and text
    const generatedImageBuffer = this.extractGeneratedImage(response);
    const changesApplied = this.extractChangesApplied(response, problemsToFix);

    if (!generatedImageBuffer) {
      // Enhanced error with diagnostics
      const candidates = response?.candidates;
      const finishReason = candidates?.[0]?.finishReason;
      const errorDetails = {
        hasCandidates: !!candidates,
        candidateCount: candidates?.length || 0,
        finishReason,
        responseKeys: Object.keys(response || {}),
      };

      logger.error("video:fix:no-image-generated", {
        errorDetails,
        responsePreview: JSON.stringify(response).slice(0, 500),
      });

      throw new Error(
        `Failed to generate fixed image - Gemini did not return image data (finishReason: ${finishReason || "unknown"})`
      );
    }

    // Validate the AI-generated image for inappropriate content
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

  /**
   * Build prompt for image fix generation
   */
  private static buildFixPrompt(
    problemsToFix: Array<{
      problem: Problem;
      solution: Solution;
      dimension: string;
    }>
  ): string {
    const fixes = problemsToFix
      .map((p, i) => {
        return `${i + 1}. **${p.dimension.toUpperCase()} - ${p.problem.title}**
   Problem: ${p.problem.description}
   Solution to apply: ${p.solution.title}
   Steps: ${p.solution.steps.join("; ")}`;
      })
      .join("\n\n");

    return (
      "You are an expert interior designer. Edit this room image to fix the " +
      `following problems by applying the specified solutions.

**PROBLEMS TO FIX:**

${fixes}

**INSTRUCTIONS:**
1. Generate a new version of this room image with ALL the above solutions visually applied
2. Keep the same camera angle, room layout, and overall style
3. Make realistic, subtle improvements that address each problem
4. Maintain photorealistic quality - the result should look like a real photograph
5. The changes should be noticeable but natural-looking

Generate the improved room image now.`
    );
  }

  /**
   * Extract generated image from Gemini response
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static extractGeneratedImage(response: any): Buffer | null {
    try {
      // Gemini returns parts array with text and inline_data
      const candidates = response.candidates;
      if (!candidates || candidates.length === 0) {
        logger.error("gemini:no-candidates", {
          responseKeys: Object.keys(response || {}),
        });
        return null;
      }

      // Log finish reason for debugging
      const finishReason = candidates[0].finishReason;
      if (finishReason && finishReason !== "STOP") {
        logger.error("gemini:unexpected-finish", {finishReason});
      }

      const parts = candidates[0].content?.parts;
      if (!parts) {
        logger.error("gemini:no-parts", {
          contentKeys: Object.keys(candidates[0].content || {}),
        });
        return null;
      }

      // Log what parts we received
      const partTypes = parts.map(
        (p: {text?: string; inlineData?: {mimeType?: string}}) =>
          p.text ? "text" : p.inlineData?.mimeType || "unknown"
      );
      logger.info("gemini:response-parts", {partTypes});

      for (const part of parts) {
        if (part.inlineData?.data) {
          // Convert base64 to Buffer
          return Buffer.from(part.inlineData.data, "base64");
        }
      }

      // Log text response if no image found
      const textParts = parts
        .filter((p: {text?: string}) => p.text)
        .map((p: {text: string}) => p.text);
      if (textParts.length > 0) {
        logger.error("gemini:text-only-response", {
          textPreview: textParts.join("\n").slice(0, 500),
        });
      }

      return null;
    } catch (error) {
      logger.error("gemini:extraction-error", {error: String(error)});
      return null;
    }
  }

  /**
   * Extract list of changes applied from response
   */
  private static extractChangesApplied(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response: any,
    problemsToFix: Array<{
      problem: Problem;
      solution: Solution;
      dimension: string;
    }>
  ): string[] {
    try {
      // Try to extract text description of changes from response
      const candidates = response.candidates;
      if (candidates && candidates.length > 0) {
        const parts = candidates[0].content?.parts;
        if (parts) {
          for (const part of parts) {
            if (part.text) {
              // Parse any change descriptions from the text
              const lines = part.text
                .split("\n")
                .filter((l: string) => l.trim());
              if (lines.length > 0) {
                return lines.slice(0, 10); // Return up to 10 change descriptions
              }
            }
          }
        }
      }
    } catch (error) {
      console.error("Error extracting changes:", error);
    }

    // Fallback: return solution titles as changes applied
    return problemsToFix.map((p) => p.solution.title);
  }

  /**
   * Generate fix metadata (name + summary) using a separate text-only AI call.
   * This is more reliable than extracting from image generation response.
   */
  static async generateFixMetadata(
    problemsToFix: Array<{
      problem: Problem;
      solution: Solution;
      dimension: string;
    }>
  ): Promise<{fixName: string; summary: string}> {
    const fixDescriptions = problemsToFix
      .map(
        (p) =>
          `- ${p.dimension}: Fixed "${p.problem.title}" by applying "${p.solution.title}"`
      )
      .join("\n");

    const prompt = `Based on these room improvements, generate a short name and summary.

Improvements:
${fixDescriptions}

Reply with JSON only:
{"name":"Short Name","summary":"One sentence summary"}

Name examples: "Brighter Space", "Decluttered", "Natural Touch", "Warm Tones"`;

    try {
      const result = await geminiModerationModel.generateContent([
        {text: prompt},
      ]);

      const text = result.response.text();

      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = text.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) {
        return {
          fixName: this.getFallbackFixName(problemsToFix),
          summary: this.getFallbackSummary(problemsToFix),
        };
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Handle various field name formats the AI might use
      const fixName =
        parsed.name || parsed.fixName || parsed.fix_name || parsed.title || "";
      const summary = parsed.summary || parsed.description || parsed.text || "";

      if (!fixName) {
        return {
          fixName: this.getFallbackFixName(problemsToFix),
          summary: summary || this.getFallbackSummary(problemsToFix),
        };
      }

      return {
        fixName,
        summary: summary || this.getFallbackSummary(problemsToFix),
      };
    } catch (error) {
      console.error("Error generating fix metadata:", error);
      return {
        fixName: this.getFallbackFixName(problemsToFix),
        summary: this.getFallbackSummary(problemsToFix),
      };
    }
  }

  /**
   * Generate fallback fix name from dimensions
   */
  private static getFallbackFixName(
    problemsToFix: Array<{
      problem: Problem;
      solution: Solution;
      dimension: string;
    }>
  ): string {
    const dimensions = [...new Set(problemsToFix.map((p) => p.dimension))];
    if (dimensions.length === 1) {
      // Capitalize first letter
      return dimensions[0].charAt(0).toUpperCase() + dimensions[0].slice(1);
    }
    return "Fix";
  }

  /**
   * Generate fallback summary from solutions applied
   */
  private static getFallbackSummary(
    problemsToFix: Array<{
      problem: Problem;
      solution: Solution;
      dimension: string;
    }>
  ): string {
    const solutionTitles = problemsToFix
      .slice(0, 2)
      .map((p) => p.solution.title);
    return `Applied: ${solutionTitles.join(", ")}${
      problemsToFix.length > 2 ? ` and ${problemsToFix.length - 2} more` : ""
    }.`;
  }
  // Gemini retry logic (opt-in via GEMINI_ENABLE_RETRY to control costs)
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

    const retryDelayMatch = message.match(/"retryDelay":"(\d+)s"/i);
    if (retryDelayMatch?.[1]) {
      const seconds = parseInt(retryDelayMatch[1], 10);
      if (!Number.isNaN(seconds)) {
        return Math.max(0, seconds * 1000);
      }
    }

    const backoff = baseDelayMs * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * 300);

    return Math.min(maxDelayMs, backoff + jitter);
  }

  // ============================================================================

  // Video Fix Methods

  // ============================================================================

  /**

     * Generate a design plan/description for fixing a specific room frame.

     * This provides professional design intervention advice based on detected issues.

     *

     * @param frameBuffer - The image buffer of the frame to analyze

     * @param problemsToFix - List of problems and their corresponding solutions

     * @returns A professional textual description of the proposed transformation

     */

  static async generateFixPlan(
    frameBuffer: Buffer,

    problemsToFix: Array<{
      problem: Problem;

      solution: Solution;

      dimension: string;
    }>
  ): Promise<string> {
    const base64Image = frameBuffer.toString("base64");

    const fixes = problemsToFix

      .map((p, i) => {
        return `${i + 1}. **${p.dimension.toUpperCase()} - ${p.problem.title}**

     Problem: ${p.problem.description}

     Proposed Solution: ${p.solution.title}

     Steps to take: ${p.solution.steps.join("; ")}`;
      })

      .join("\n\n");

    const prompt = `You are an expert interior designer. Analyze this room frame and provide a concise, 

  professional "Design Intervention Plan" to address the following problems.

  

  **PROBLEMS TO ADDRESS:**

  

  ${fixes}

  

  **INSTRUCTIONS:**

  1. Describe exactly HOW the room will look after these changes are applied.

  2. Use professional design terminology.

  3. Be concise (max 3-4 sentences).

  4. Focus on visual impact and spatial feel.

  

  Format your response as a single cohesive paragraph describing the transformation.`;

    const requestPlan = async () => {
      const result = await geminiModerationModel.generateContent([
        {
          inlineData: {
            data: base64Image,

            mimeType: "image/jpeg",
          },
        },

        {text: prompt},
      ]);

      return result.response.text().trim();
    };

    try {
      return process.env.GEMINI_ENABLE_RETRY === "true"
        ? await this.withGeminiRetry(requestPlan)
        : await requestPlan();
    } catch (error) {
      logger.error("ai:generate-fix-plan:failed", {
        error: error instanceof Error ? error.message : String(error),
      });

      // Fallback: simple summary of solutions if AI fails completely

      const solutionSummary = problemsToFix

        .map((p) => p.solution.title.toLowerCase())

        .join(" and ");

      return `Transforming the space by ${solutionSummary}. 
      This intervention focuses on improving the room's ${problemsToFix[0].dimension} and overall aesthetic balance.`;
    }
  }

  /**

     * Generate fix data (descriptions) for multiple video frames.

     * Processes frames in batches to respect rate limits and maximize throughput.

     *

     * @param frames - Array of frame buffers

     * @param problemsToFix - The set of design problems to address

     * @returns Metadata and an array of textual fix descriptions for each frame

     */

  static async generateFixedVideoData(
    frames: Buffer[],

    problemsToFix: Array<{
      problem: Problem;

      solution: Solution;

      dimension: string;
    }>
  ): Promise<{
    fixDescriptions: string[];

    changesApplied: string[];

    fixName: string;

    summary: string;
  }> {
    const fixDescriptions: string[] = [];

    // Use the established moderation batch size for consistency

    const BATCH_SIZE = VIDEO_MODERATION_BATCH_SIZE;

    // Start metadata generation in parallel with frame processing

    const metadataPromise = this.generateFixMetadata(problemsToFix);

    // Process frames in batches to balance speed and rate-limit safety

    for (let i = 0; i < frames.length; i += BATCH_SIZE) {
      const batch = frames.slice(i, i + BATCH_SIZE);

      const batchPromises = batch.map((frame) =>
        this.generateFixPlan(frame, problemsToFix)
      );

      try {
        const batchResults = await Promise.all(batchPromises);

        fixDescriptions.push(...batchResults);
      } catch (error) {
        logger.error("ai:fix-plans:batch-failed", {
          batchIndex: i,
          error: String(error),
        });

        // Fill remaining batch slots with fallbacks if a batch fails

        batch.forEach(() =>
          fixDescriptions.push(
            "Design plan currently unavailable for this frame."
          )
        );
      }

      if (i + BATCH_SIZE < frames.length) {
        logger.info("ai:fix-plans:batch-progress", {
          processed: Math.min(i + BATCH_SIZE, frames.length),

          total: frames.length,
        });
      }
    }

    const changesApplied = problemsToFix.map((p) => p.solution.title);

    const metadata = await metadataPromise;

    return {
      fixDescriptions,

      changesApplied,

      fixName: metadata.fixName,

      summary: metadata.summary,
    };
  }
}
