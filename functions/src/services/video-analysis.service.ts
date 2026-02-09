/**
 * Video Analysis Service
 * Handles frame extraction, moderation, and Gemini 1.5 Pro analysis
 */

import {storage, geminiModel} from "../config/firebase.config";
import {AIService} from "./ai.service";
import {
  VIDEO_FRAME_INTERVAL,
  VIDEO_MAX_FRAMES,
  VIDEO_MODERATION_BATCH_SIZE,
  VIDEO_MAX_PROBLEM_FRAMES,
  VIDEO_FRAME_DEDUP_THRESHOLD,
} from "../config/constants";
import {
  FrameMetadata,
  FrameAnalysis,
  TimelineMarker,
  VideoAnalysis,
  VideoValidationResult,
  FrameIssue,
  CategorizedProblems,
  GeneralProblem,
  ProblemFrame,
  FrameProblem,
  CostAnalysisSummary,
  DimensionType,
} from "../types/video.types";
import {DimensionAnalysis} from "../types/api.types";
import * as logger from "firebase-functions/logger";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

interface ThumbnailResult extends VideoValidationResult {
  thumbnailBuffer?: Buffer;
}

export class VideoAnalysisService {
  /**
   * Validate video and extract thumbnail (first frame)
   */
  static async validateAndExtractThumbnail(
    videoBuffer: Buffer,
    mimeType: string
  ): Promise<ThumbnailResult> {
    const tempDir = os.tmpdir();
    const videoPath = path.join(
      tempDir,
      `video_${Date.now()}.${this.getExtension(mimeType)}`
    );
    const thumbnailPath = path.join(tempDir, `thumb_${Date.now()}.jpg`);

    try {
      // Write video to temp file
      await fs.promises.writeFile(videoPath, videoBuffer);

      // Get video metadata and extract thumbnail
      const metadata = await this.getVideoMetadata(videoPath);

      // Extract first frame as thumbnail
      await this.extractSingleFrame(videoPath, thumbnailPath, 0);

      // Read thumbnail
      const thumbnailBuffer = await fs.promises.readFile(thumbnailPath);

      return {
        valid: true,
        duration: metadata.duration,
        width: metadata.width,
        height: metadata.height,
        thumbnailBuffer,
      };
    } catch (error) {
      logger.error("video:validation:failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        valid: false,
        error: `Failed to process video file: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      // Cleanup temp files
      await this.cleanupFile(videoPath);
      await this.cleanupFile(thumbnailPath);
    }
  }

  /**
   * Extract frames from video at regular intervals
   */
  static async extractFrames(
    videoBuffer: Buffer,
    mimeType: string,
    videoId: string,
    userId: string
  ): Promise<FrameMetadata[]> {
    const tempDir = os.tmpdir();
    const videoPath = path.join(
      tempDir,
      `video_${videoId}.${this.getExtension(mimeType)}`
    );
    const framesDir = path.join(tempDir, `frames_${videoId}`);

    try {
      // Write video to temp file
      await fs.promises.writeFile(videoPath, videoBuffer);
      await fs.promises.mkdir(framesDir, {recursive: true});

      // Get video duration
      const metadata = await this.getVideoMetadata(videoPath);
      const duration = metadata.duration || 0;

      // Calculate frame timestamps
      const timestamps: number[] = [];
      for (
        let t = 0;
        t < duration && timestamps.length < VIDEO_MAX_FRAMES;
        t += VIDEO_FRAME_INTERVAL
      ) {
        timestamps.push(t);
      }

      // Ensure we have at least one frame
      if (timestamps.length === 0) {
        timestamps.push(0);
      }

      // Extract frames
      const frames: FrameMetadata[] = [];
      const bucket = storage.bucket();

      for (let i = 0; i < timestamps.length; i++) {
        const timestamp = timestamps[i];
        const framePath = path.join(
          framesDir,
          `frame_${i.toString().padStart(3, "0")}.jpg`
        );

        await this.extractSingleFrame(videoPath, framePath, timestamp);

        // Read frame buffer
        const frameBuffer = await fs.promises.readFile(framePath);

        // Upload frame to storage
        const frameNum = i.toString().padStart(3, "0");
        const storagePath = `users/${userId}/videos/${videoId}/frames/frame_${frameNum}.jpg`;
        const file = bucket.file(storagePath);

        await file.save(frameBuffer, {
          metadata: {
            contentType: "image/jpeg",
            metadata: {
              videoId,
              frameIndex: i.toString(),
              timestamp: timestamp.toString(),
            },
          },
          public: false,
        });

        frames.push({
          frameIndex: i,
          timestamp,
          storagePath,
        });

        logger.info("video:frame:extracted", {
          videoId,
          frameIndex: i,
          timestamp,
        });
      }

      return frames;
    } finally {
      // Cleanup temp files
      await this.cleanupFile(videoPath);
      await this.cleanupDir(framesDir);
    }
  }

  /**
   * Moderate all extracted frames in batches
   */
  static async moderateFrames(frames: FrameMetadata[]): Promise<void> {
    const bucket = storage.bucket();

    for (let i = 0; i < frames.length; i += VIDEO_MODERATION_BATCH_SIZE) {
      const batch = frames.slice(i, i + VIDEO_MODERATION_BATCH_SIZE);

      // Process batch in parallel
      await Promise.all(
        batch.map(async (frame) => {
          const [frameBuffer] = await bucket.file(frame.storagePath).download();

          // This will throw ContentModerationError if content is inappropriate
          await AIService.validateImageContent(frameBuffer);
        })
      );

      logger.info("video:moderation:batch_complete", {
        batchStart: i,
        batchEnd: Math.min(i + VIDEO_MODERATION_BATCH_SIZE, frames.length),
        totalFrames: frames.length,
      });
    }
  }

  /**
   * Analyze video using Gemini 3 Flash with native video support
   * NEW FLOW: Extract frames ONLY at problem timestamps (max 6 frames)
   */
  static async analyzeVideo(
    videoBuffer: Buffer,
    mimeType: string,
    frames: FrameMetadata[],
    videoId: string,
    userId: string
  ): Promise<VideoAnalysis> {
    // Use Gemini 3 Flash for native video analysis (multimodal)
    const base64Video = videoBuffer.toString("base64");

    const prompt = this.buildVideoAnalysisPrompt();

    try {
      const result = await geminiModel.generateContent([
        {
          inlineData: {
            data: base64Video,
            mimeType: mimeType,
          },
        },
        {text: prompt},
      ]);

      const response = await result.response;
      const text = response.text();

      // Parse the AI response (includes frame-grouped problems)
      const parsedAnalysis = this.parseVideoAnalysisResponse(text);

      // NEW FLOW: Extract frames ONLY at problem timestamps
      // Get unique timestamps from problemFrames (max VIDEO_MAX_PROBLEM_FRAMES)
      const problemTimestamps = parsedAnalysis.categorizedProblems.problemFrames
        .slice(0, VIDEO_MAX_PROBLEM_FRAMES)
        .map((pf) => pf.timestamp);

      let problemFrameMetadata: FrameMetadata[] = [];

      if (problemTimestamps.length > 0) {
        problemFrameMetadata = await this.extractProblemFrames(
          videoBuffer,
          mimeType,
          videoId,
          userId,
          problemTimestamps
        );

        logger.info("video:analysis:problem-frames-extracted", {
          videoId,
          requestedTimestamps: problemTimestamps.length,
          extractedFrames: problemFrameMetadata.length,
        });
      }

      // Update problemFrames with actual storage paths
      const updatedProblemFrames =
        parsedAnalysis.categorizedProblems.problemFrames
          .slice(0, VIDEO_MAX_PROBLEM_FRAMES)
          .map((pf, index) => {
            const matchingFrame = problemFrameMetadata.find(
              (f) =>
                Math.abs(f.timestamp - pf.timestamp) <
                VIDEO_FRAME_DEDUP_THRESHOLD
            );
            return {
              ...pf,
              frameId: `pf_${index + 1}`,
              frameIndex: matchingFrame?.frameIndex ?? index,
              frameStoragePath: matchingFrame?.storagePath ?? "",
            };
          });

      // Build frame analyses from problem frames
      const frameAnalyses = this.buildFrameAnalysesFromProblemFrames(
        updatedProblemFrames,
        problemFrameMetadata
      );

      // Calculate cost analysis
      const costAnalysis = this.calculateCostAnalysis(
        parsedAnalysis.categorizedProblems.general,
        updatedProblemFrames
      );

      // Build complete video analysis
      const analysis: VideoAnalysis = {
        videoId,
        userId,
        overall: parsedAnalysis.overall,
        dimensions: parsedAnalysis.dimensions,
        timeline: parsedAnalysis.timeline,
        frames: frameAnalyses,
        categorizedProblems: {
          general: parsedAnalysis.categorizedProblems.general,
          problemFrames: updatedProblemFrames,
          costAnalysis,
        },
        analyzedAt: new Date().toISOString(),
      };

      return analysis;
    } catch (error) {
      logger.error("video:analysis:failed", {
        videoId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Return fallback analysis
      return this.getFallbackAnalysis(videoId, userId, frames);
    }
  }

  /**
   * Extract frames ONLY at problem timestamps (new efficient flow)
   * Max VIDEO_MAX_PROBLEM_FRAMES frames
   */
  static async extractProblemFrames(
    videoBuffer: Buffer,
    mimeType: string,
    videoId: string,
    userId: string,
    problemTimestamps: number[]
  ): Promise<FrameMetadata[]> {
    const tempDir = os.tmpdir();
    const videoPath = path.join(
      tempDir,
      `video_problem_${videoId}.${this.getExtension(mimeType)}`
    );
    const framesDir = path.join(tempDir, `frames_problem_${videoId}`);

    try {
      await fs.promises.writeFile(videoPath, videoBuffer);
      await fs.promises.mkdir(framesDir, {recursive: true});

      // Deduplicate timestamps that are too close together
      const uniqueTimestamps: number[] = [];
      for (const timestamp of problemTimestamps) {
        const isDuplicate = uniqueTimestamps.some(
          (existing) =>
            Math.abs(existing - timestamp) < VIDEO_FRAME_DEDUP_THRESHOLD
        );
        if (!isDuplicate) {
          uniqueTimestamps.push(timestamp);
        }
      }

      // Limit to max problem frames
      const timestampsToExtract = uniqueTimestamps.slice(
        0,
        VIDEO_MAX_PROBLEM_FRAMES
      );

      if (timestampsToExtract.length === 0) {
        logger.info("video:problem-frames:none-needed", {videoId});
        return [];
      }

      const bucket = storage.bucket();
      const extractedFrames: FrameMetadata[] = [];

      for (let i = 0; i < timestampsToExtract.length; i++) {
        const timestamp = timestampsToExtract[i];
        const framePath = path.join(
          framesDir,
          `frame_${i.toString().padStart(3, "0")}.jpg`
        );

        await this.extractSingleFrame(videoPath, framePath, timestamp);

        const frameBuffer = await fs.promises.readFile(framePath);

        // Moderate the frame before including
        try {
          await AIService.validateImageContent(frameBuffer);
        } catch (moderationError) {
          logger.warn("video:problem-frame:moderation-failed", {
            videoId,
            frameIndex: i,
            timestamp,
            error: String(moderationError),
          });
          continue; // Skip this frame if it fails moderation
        }

        // Upload frame to storage
        const frameNum = i.toString().padStart(3, "0");
        const storagePath = `users/${userId}/videos/${videoId}/frames/frame_${frameNum}.jpg`;
        const file = bucket.file(storagePath);

        await file.save(frameBuffer, {
          metadata: {
            contentType: "image/jpeg",
            metadata: {
              videoId,
              frameIndex: i.toString(),
              timestamp: timestamp.toString(),
              isProblemFrame: "true",
            },
          },
          public: false,
        });

        extractedFrames.push({
          frameIndex: i,
          timestamp,
          storagePath,
        });

        logger.info("video:problem-frame:extracted", {
          videoId,
          frameIndex: i,
          timestamp,
        });
      }

      return extractedFrames;
    } finally {
      await this.cleanupFile(videoPath);
      await this.cleanupDir(framesDir);
    }
  }

  /**
   * Build the video analysis prompt for Gemini 3 Flash
   * Requests FRAME-CENTRIC problems (each frame can have
   * multiple problems from different dimensions)
   */
  private static buildVideoAnalysisPrompt(): string {
    return `You are an expert interior designer analyzing a video walkthrough of a room.

Analyze this video across 6 dimensions. Structure problems as:
- **General problems**: Issues that apply throughout the room (e.g., overall color scheme)
- **Problem frames**: Specific timestamps where issues are visible.
-Each frame can have MULTIPLE problems from different dimensions (up to 6).

**IMPORTANT**:
- Group problems by TIMESTAMP, not by dimension
- Identify MAX 6 problem frames (timestamps where issues exist)
- Each frame can contain 1-6 problems from different dimensions visible at that moment

Analyze these dimensions:
1. **lighting** (0-100) - Natural/artificial light distribution, shadows, glare
2. **spatial** (0-100) - Furniture arrangement, traffic flow, proportions
3. **color** (0-100) - Color harmony, emotional impact, balance
4. **clutter** (0-100) - Organization, visual noise, tidiness (higher = less clutter)
5. **biophilic** (0-100) - Plants, natural materials, nature connection
6. **fengShui** (0-100) - Energy flow, element balance, positioning

Return ONLY a valid JSON object (no markdown, no explanations):

{
  "overall": {
    "score": 72,
    "grade": "B",
    "summary": "Brief 1-2 sentence assessment of the space based on the walkthrough",
    "consistencyScore": 85
  },
  "dimensions": {
    "lighting": {
      "score": 65,
      "status": "good",
      "problems": [
        {
          "problemId": "light_1",
          "title": "Dark corner near window",
          "description": "The corner lacks adequate lighting",
          "impact": "Creates uneven lighting across the room",
          "research": "Proper lighting distribution improves mood",
          "severity": "medium"
        }
      ],
      "solutions": [
        {
          "solutionId": "sol_light_1",
          "problemId": "light_1",
          "title": "Add floor lamp",
          "description": "Place a floor lamp in the dark corner",
          "steps": ["Purchase warm LED floor lamp", "Position in corner"],
          "costEstimate": "$50-100",
          "difficulty": "easy",
          "timeEstimate": "15 minutes",
          "priority": 1
        }
      ]
    },
    "spatial": { "score": 70, "status": "good", "problems": [], "solutions": [] },
    "color": { "score": 75, "status": "good", "problems": [], "solutions": [] },
    "clutter": { "score": 60, "status": "needs_improvement", "problems": [], "solutions": [] },
    "biophilic": { "score": 45, "status": "needs_improvement", "problems": [], "solutions": [] },
    "fengShui": { "score": 70, "status": "good", "problems": [], "solutions": [] }
  },
  "categorizedProblems": {
    "general": [
      {
        "problemId": "gen_color_1",
        "dimension": "color",
        "title": "Mismatched color temperature",
        "description": "The overall color palette lacks cohesion throughout the room",
        "impact": "Creates visual disharmony and affects mood",
        "research": "Consistent color temperature improves perceived spaciousness",
        "severity": "medium",
        "solution": {
          "solutionId": "sol_gen_color_1",
          "title": "Unify color palette",
          "description": "Introduce coordinating accent colors",
          "steps": ["Choose 2-3 complementary colors", "Add throw pillows", "Update small decor items"],
          "costEstimate": "$100-200",
          "difficulty": "easy",
          "timeEstimate": "1-2 hours",
          "priority": 2
        }
      }
    ],
    "problemFrames": [
      {
        "frameId": "pf_1",
        "frameIndex": 0,
        "timestamp": 8,
        "frameStoragePath": "",
        "problems": [
          {
            "problemId": "pf1_light",
            "dimension": "lighting",
            "title": "Dark corner near window",
            "description": "This corner lacks adequate lighting",
            "impact": "Creates uneven lighting across the room",
            "research": "Proper lighting distribution improves mood",
            "severity": "medium",
            "solution": {
              "solutionId": "sol_pf1_light",
              "title": "Add floor lamp",
              "description": "Place a floor lamp in the dark corner",
              "steps": ["Purchase warm LED floor lamp", "Position in corner"],
              "costEstimate": "$50-100",
              "difficulty": "easy",
              "timeEstimate": "15 minutes",
              "priority": 1
            }
          },
          {
            "problemId": "pf1_clutter",
            "dimension": "clutter",
            "title": "Cluttered shelf",
            "description": "The bookshelf has too many items",
            "impact": "Creates visual noise and distraction",
            "research": "Decluttering improves focus and reduces stress",
            "severity": "low",
            "solution": {
              "solutionId": "sol_pf1_clutter",
              "title": "Organize bookshelf",
              "description": "Remove excess items and organize",
              "steps": ["Remove 50% of items", "Group by category"],
              "costEstimate": "$20-50",
              "difficulty": "easy",
              "timeEstimate": "30 minutes",
              "priority": 3
            }
          }
        ]
      },
      {
        "frameId": "pf_2",
        "frameIndex": 0,
        "timestamp": 22,
        "frameStoragePath": "",
        "problems": [
          {
            "problemId": "pf2_spatial",
            "dimension": "spatial",
            "title": "Blocked walkway",
            "description": "Furniture placement blocks natural traffic flow",
            "impact": "Makes navigation difficult and space feel cramped",
            "research": "Clear pathways improve room functionality by 40%",
            "severity": "high",
            "solution": {
              "solutionId": "sol_pf2_spatial",
              "title": "Rearrange furniture",
              "description": "Move furniture to create clear 36-inch walkways",
              "steps": ["Identify main traffic paths", "Move blocking furniture", "Test flow"],
              "costEstimate": "$0",
              "difficulty": "medium",
              "timeEstimate": "1-2 hours",
              "priority": 1
            }
          }
        ]
      }
    ]
  },
  "timeline": [
    {
      "markerId": "marker_1",
      "timestamp": 8,
      "frameIndex": 0,
      "dimension": "lighting",
      "issue": "Dark corner detected",
      "severity": "medium",
      "suggestion": "Add supplemental lighting in this area"
    },
    {
      "markerId": "marker_2",
      "timestamp": 22,
      "frameIndex": 1,
      "dimension": "spatial",
      "issue": "Blocked walkway",
      "severity": "high",
      "suggestion": "Rearrange furniture for better flow"
    }
  ]
}

**Important guidelines:**
- Group problems by TIMESTAMP into problemFrames (max 6 frames)
- Each problemFrame can have 1-6 problems from DIFFERENT dimensions visible at that timestamp
- Use dimension values exactly: "lighting", "spatial", "color", "clutter", "biophilic", "fengShui"
- General problems should NOT have timestamps - they apply throughout the video
- Set frameIndex to 0 and frameStoragePath to "" as placeholders (populated automatically)
- Ensure each problem has a matching solution object with all required fields
- costEstimate should be in format "$X-Y" (e.g., "$50-100", "$0", "$200-500")

CRITICAL:
- Find at least 1-2 constructive improvements for each dimension
- Populate both "general" and "problemFrames" arrays
- problemFrames should contain 2-6 frames with problems grouped by timestamp`;
  }

  /**
   * Parse video analysis response from AI
   * Now handles frame-centric problemFrames structure
   */
  private static parseVideoAnalysisResponse(text: string): {
    overall: VideoAnalysis["overall"];
    dimensions: VideoAnalysis["dimensions"];
    timeline: TimelineMarker[];
    categorizedProblems: Omit<CategorizedProblems, "costAnalysis">;
  } {
    try {
      // Clean up response
      let cleanText = text.trim();
      if (cleanText.startsWith("```json")) {
        cleanText = cleanText.replace(/```json\n?/g, "").replace(/```\n?/g, "");
      } else if (cleanText.startsWith("```")) {
        cleanText = cleanText.replace(/```\n?/g, "");
      }

      const parsed = JSON.parse(cleanText);
      const dimensions = parsed.dimensions || this.getDefaultDimensions();

      // Parse general problems
      const generalProblems: GeneralProblem[] = (
        parsed.categorizedProblems?.general || []
      ).map((p: GeneralProblem) => ({
        ...p,
        dimension: p.dimension as DimensionType,
        solution: p.solution || this.getDefaultSolution(p.problemId),
      }));

      // Parse problem frames (frame-centric structure)
      const problemFrames: ProblemFrame[] = (
        parsed.categorizedProblems?.problemFrames || []
      ).map((pf: ProblemFrame, index: number) => ({
        frameId: pf.frameId || `pf_${index + 1}`,
        frameIndex: pf.frameIndex || 0,
        timestamp: pf.timestamp || 0,
        frameStoragePath: pf.frameStoragePath || "",
        problems: (pf.problems || []).map((p: FrameProblem) => ({
          ...p,
          dimension: p.dimension as DimensionType,
          solution: p.solution || this.getDefaultSolution(p.problemId),
        })),
      }));

      return {
        overall: parsed.overall || this.getDefaultOverall(),
        dimensions,
        timeline: parsed.timeline || [],
        categorizedProblems: {
          general: generalProblems,
          problemFrames,
        },
      };
    } catch (error) {
      logger.error("video:parse:failed", {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        overall: this.getDefaultOverall(),
        dimensions: this.getDefaultDimensions(),
        timeline: [],
        categorizedProblems: {general: [], problemFrames: []},
      };
    }
  }

  /**
   * Parse cost estimate string like "$50-100" to {min, max}
   */
  private static parseCostEstimate(costEstimate: string): {
    min: number;
    max: number;
  } {
    if (!costEstimate || costEstimate === "$0" || costEstimate === "0") {
      return {min: 0, max: 0};
    }

    // Handle "Varies" or non-numeric
    if (!/\d/.test(costEstimate)) {
      return {min: 0, max: 0};
    }

    // Extract numbers from string like "$50-100", "$200", "50-100"
    const numbers = costEstimate.match(/\d+/g);
    if (!numbers || numbers.length === 0) {
      return {min: 0, max: 0};
    }

    const min = parseInt(numbers[0], 10);
    const max = numbers.length > 1 ? parseInt(numbers[1], 10) : min;

    return {min, max};
  }

  /**
   * Calculate aggregated cost analysis from all problems
   */
  private static calculateCostAnalysis(
    generalProblems: GeneralProblem[],
    problemFrames: ProblemFrame[]
  ): CostAnalysisSummary {
    const byDifficulty = {
      easy: {count: 0, minCost: 0, maxCost: 0},
      medium: {count: 0, minCost: 0, maxCost: 0},
      hard: {count: 0, minCost: 0, maxCost: 0},
    };

    const dimensions: DimensionType[] = [
      "lighting",
      "spatial",
      "color",
      "clutter",
      "biophilic",
      "fengShui",
    ];
    const byDimension: Record<
      DimensionType,
      {count: number; minCost: number; maxCost: number}
    > = {} as Record<
      DimensionType,
      {count: number; minCost: number; maxCost: number}
    >;
    for (const dim of dimensions) {
      byDimension[dim] = {count: 0, minCost: 0, maxCost: 0};
    }

    let minTotalCost = 0;
    let maxTotalCost = 0;

    // Process general problems
    for (const problem of generalProblems) {
      const {min, max} = this.parseCostEstimate(problem.solution.costEstimate);
      const difficulty = problem.solution.difficulty;
      const dimension = problem.dimension as DimensionType;

      byDifficulty[difficulty].count++;
      byDifficulty[difficulty].minCost += min;
      byDifficulty[difficulty].maxCost += max;

      if (byDimension[dimension]) {
        byDimension[dimension].count++;
        byDimension[dimension].minCost += min;
        byDimension[dimension].maxCost += max;
      }

      minTotalCost += min;
      maxTotalCost += max;
    }

    // Process problem frame problems
    for (const frame of problemFrames) {
      for (const problem of frame.problems) {
        const {min, max} = this.parseCostEstimate(
          problem.solution.costEstimate
        );
        const difficulty = problem.solution.difficulty;
        const dimension = problem.dimension as DimensionType;

        byDifficulty[difficulty].count++;
        byDifficulty[difficulty].minCost += min;
        byDifficulty[difficulty].maxCost += max;

        if (byDimension[dimension]) {
          byDimension[dimension].count++;
          byDimension[dimension].minCost += min;
          byDimension[dimension].maxCost += max;
        }

        minTotalCost += min;
        maxTotalCost += max;
      }
    }

    return {
      minTotalCost,
      maxTotalCost,
      currency: "USD",
      byDifficulty,
      byDimension,
    };
  }

  /**
   * Build frame analyses from problem frames
   */
  private static buildFrameAnalysesFromProblemFrames(
    problemFrames: ProblemFrame[],
    frameMetadata: FrameMetadata[]
  ): FrameAnalysis[] {
    return problemFrames.map((pf) => {
      const matchingMeta = frameMetadata.find(
        (f) =>
          Math.abs(f.timestamp - pf.timestamp) < VIDEO_FRAME_DEDUP_THRESHOLD
      );

      const issues: FrameIssue[] = pf.problems.map((p) => ({
        dimension: p.dimension,
        issue: p.title,
        severity: p.severity,
      }));

      const problemIds = pf.problems.map((p) => p.problemId);

      // Calculate frame score based on issues
      const issueDeduction = issues.reduce((sum, issue) => {
        switch (issue.severity) {
          case "high":
            return sum + 15;
          case "medium":
            return sum + 10;
          case "low":
            return sum + 5;
          default:
            return sum;
        }
      }, 0);

      const score = Math.max(0, 100 - issueDeduction);

      return {
        frameIndex: matchingMeta?.frameIndex ?? pf.frameIndex,
        timestamp: pf.timestamp,
        storagePath: matchingMeta?.storagePath ?? pf.frameStoragePath,
        analysis: {
          score,
          issues,
        },
        isKeyFrame: true,
        problemIds,
        isExactTimestamp: true,
      };
    });
  }

  /**
   * Get default solution when AI doesn't provide one
   */
  private static getDefaultSolution(problemId: string) {
    return {
      solutionId: `sol_${problemId}`,
      title: "Address this issue",
      description: "Follow the recommended steps to improve this area",
      steps: ["Assess the current situation", "Apply recommended changes"],
      costEstimate: "Varies",
      difficulty: "medium" as const,
      timeEstimate: "Varies",
      priority: 3,
    };
  }

  /**
   * Get fallback analysis when AI fails
   */
  private static getFallbackAnalysis(
    videoId: string,
    userId: string,
    frames: FrameMetadata[]
  ): VideoAnalysis {
    const emptyDimensions: DimensionType[] = [
      "lighting",
      "spatial",
      "color",
      "clutter",
      "biophilic",
      "fengShui",
    ];
    const byDimension: Record<
      DimensionType,
      {count: number; minCost: number; maxCost: number}
    > = {} as Record<
      DimensionType,
      {count: number; minCost: number; maxCost: number}
    >;
    for (const dim of emptyDimensions) {
      byDimension[dim] = {count: 0, minCost: 0, maxCost: 0};
    }

    return {
      videoId,
      userId,
      overall: this.getDefaultOverall(),
      dimensions: this.getDefaultDimensions(),
      timeline: [],
      frames: frames.map((frame) => ({
        frameIndex: frame.frameIndex,
        timestamp: frame.timestamp,
        storagePath: frame.storagePath,
        analysis: {score: 50, issues: []},
        isKeyFrame: false,
      })),
      categorizedProblems: {
        general: [],
        problemFrames: [],
        costAnalysis: {
          minTotalCost: 0,
          maxTotalCost: 0,
          currency: "USD",
          byDifficulty: {
            easy: {count: 0, minCost: 0, maxCost: 0},
            medium: {count: 0, minCost: 0, maxCost: 0},
            hard: {count: 0, minCost: 0, maxCost: 0},
          },
          byDimension,
        },
      },
      analyzedAt: new Date().toISOString(),
    };
  }

  /**
   * Get default overall scores
   */
  private static getDefaultOverall(): VideoAnalysis["overall"] {
    return {
      score: 50,
      grade: "C",
      summary: "Analysis could not be completed. Please try again.",
      consistencyScore: 50,
    };
  }

  /**
   * Get default dimension scores
   */
  private static getDefaultDimensions(): VideoAnalysis["dimensions"] {
    const emptyDimension: DimensionAnalysis = {
      score: 50,
      status: "needs_improvement",
      problems: [],
      solutions: [],
    };

    return {
      lighting: {...emptyDimension},
      spatial: {...emptyDimension},
      color: {...emptyDimension},
      clutter: {...emptyDimension},
      biophilic: {...emptyDimension},
      fengShui: {...emptyDimension},
    };
  }

  /**
   * Get video metadata using ffmpeg
   */
  private static getVideoMetadata(
    videoPath: string
  ): Promise<{duration: number; width: number; height: number}> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(
        videoPath,
        (err: Error | null, metadata: ffmpeg.FfprobeData) => {
          if (err) {
            reject(err);
            return;
          }

          const videoStream = metadata.streams.find(
            (s: ffmpeg.FfprobeStream) => s.codec_type === "video"
          );
          const duration = metadata.format.duration || 0;
          const width = videoStream?.width || 0;
          const height = videoStream?.height || 0;

          resolve({duration, width, height});
        }
      );
    });
  }

  /**
   * Extract a single frame at a specific timestamp
   */
  private static extractSingleFrame(
    videoPath: string,
    outputPath: string,
    timestamp: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(timestamp)
        .outputOptions(["-frames:v", "1", "-q:v", "2"])
        .output(outputPath)
        .on("end", () => resolve())
        .on("error", (err: Error) => reject(err))
        .run();
    });
  }

  /**
   * Get file extension from mime type
   */
  private static getExtension(mimeType: string): string {
    const extensions: Record<string, string> = {
      "video/mp4": "mp4",
      "video/quicktime": "mov",
      "video/webm": "webm",
    };
    return extensions[mimeType] || "mp4";
  }

  /**
   * Cleanup a temporary file
   */
  private static async cleanupFile(filePath: string): Promise<void> {
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // Ignore errors
    }
  }

  /**
   * Cleanup a temporary directory
   */
  private static async cleanupDir(dirPath: string): Promise<void> {
    try {
      await fs.promises.rm(dirPath, {recursive: true, force: true});
    } catch {
      // Ignore errors
    }
  }
}
