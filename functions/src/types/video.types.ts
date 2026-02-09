/**
 * Video Types - TypeScript interfaces for video processing feature
 */

import {DimensionAnalysis} from "./api.types";

// ============================================================================
// Video Status Types
// ============================================================================

export type VideoAnalysisStatus =
  | "pending"
  | "queued"
  | "extracting"
  | "moderating"
  | "analyzing"
  | "aggregating"
  | "completed"
  | "failed";

// ============================================================================
// Video Metadata Types
// ============================================================================

/**
 * Video metadata stored in database
 */
export interface VideoMetadata {
  videoId: string;
  userId: string;
  videoStoragePath: string;
  thumbnailStoragePath: string;
  originalName: string;
  mimeType: string;
  size: number;
  duration: number;
  width: number;
  height: number;
  frameCount: number;
  analysisStatus: VideoAnalysisStatus;
  overallScore: number;
  uploadedAt: string;
  analyzedAt?: string;
  error?: string;
  contentHash?: string;
  analysisSourceId?: string;
  /** Number of completed fix versions for this video */
  fixCount: number;
}

/**
 * Video upload response
 */
export interface VideoUploadResponse {
  message: string;
  video: {
    videoId: string;
    videoStoragePath: string;
    thumbnailStoragePath: string;
    duration: number;
    uploadedAt: string;
  };
  status: "queued";
  creditsUsed: number;
}

/**
 * Video list response
 */
export interface VideoListResponse {
  videos: VideoMetadata[];
}

// ============================================================================
// Frame Types
// ============================================================================

/**
 * Extracted frame metadata
 */
export interface FrameMetadata {
  frameIndex: number;
  timestamp: number;
  /** Storage path for Firebase SDK download (e.g., users/{uid}/videos/{vid}/frames/frame_000.jpg) */
  storagePath: string;
}

/**
 * Frame analysis result
 */
export interface FrameAnalysis {
  frameIndex: number;
  timestamp: number;
  /** Storage path for Firebase SDK download */
  storagePath: string;
  analysis: {
    score: number;
    issues: FrameIssue[];
  };
  isKeyFrame: boolean;
  problemIds?: string[];
  isExactTimestamp?: boolean;
}

/**
 * Issue detected in a frame
 */
export interface FrameIssue {
  dimension: string;
  issue: string;
  severity: "low" | "medium" | "high";
  location?: string;
}

// ============================================================================
// Timeline Types
// ============================================================================

/**
 * Timeline marker showing when/where an issue occurs
 */
export interface TimelineMarker {
  markerId: string;
  timestamp: number;
  frameIndex: number;
  dimension: string;
  issue: string;
  severity: "low" | "medium" | "high";
  suggestion: string;
}

// ============================================================================
// Categorized Problem Types (v3.0 - Frame-Centric Architecture)
// ============================================================================

/**
 * The 6 analysis dimensions
 */
export type DimensionType =
  | "lighting"
  | "spatial"
  | "color"
  | "clutter"
  | "biophilic"
  | "fengShui";

export interface ProblemSolution {
  solutionId: string;
  title: string;
  description: string;
  steps: string[];
  costEstimate: string;
  difficulty: "easy" | "medium" | "hard";
  timeEstimate: string;
  priority: number;
}

/**
 * General problem that applies throughout the room (not tied to a specific frame)
 */
export interface GeneralProblem {
  problemId: string;
  dimension: DimensionType;
  title: string;
  description: string;
  impact: string;
  research: string;
  severity: "low" | "medium" | "high";
  solution: ProblemSolution;
}

/**
 * A problem detected at a specific frame (1-6 problems per frame from different dimensions)
 */
export interface FrameProblem {
  problemId: string;
  dimension: DimensionType;
  title: string;
  description: string;
  impact: string;
  research: string;
  severity: "low" | "medium" | "high";
  solution: ProblemSolution;
}

/**
 * A frame containing multiple problems (frame-centric structure)
 * Each frame can have 1-6 problems from different dimensions
 */
export interface ProblemFrame {
  frameId: string;
  frameIndex: number;
  timestamp: number;
  /** Storage path for Firebase SDK download */
  frameStoragePath: string;
  /** Problems detected at this frame (1-6 from different dimensions) */
  problems: FrameProblem[];
}

/**
 * Cost analysis summary aggregated from all problems
 */
export interface CostAnalysisSummary {
  minTotalCost: number;
  maxTotalCost: number;
  currency: string;
  byDifficulty: {
    easy: {count: number; minCost: number; maxCost: number};
    medium: {count: number; minCost: number; maxCost: number};
    hard: {count: number; minCost: number; maxCost: number};
  };
  byDimension: Record<
    DimensionType,
    {count: number; minCost: number; maxCost: number}
  >;
}

/**
 * Categorized problems with frame-centric architecture
 */
export interface CategorizedProblems {
  /** General problems that apply throughout the room */
  general: GeneralProblem[];
  /** Problem frames - each frame contains multiple problems (max 6 frames) */
  problemFrames: ProblemFrame[];
  /** Aggregated cost analysis across all problems */
  costAnalysis: CostAnalysisSummary;
}

export interface FrameFixSelection {
  /** The frame ID from ProblemFrame */
  frameId: string;
  /** Problem IDs to fix within this frame */
  problemIds: string[];
}

// ============================================================================
// Video Analysis Types
// ============================================================================

/**
 * Complete video analysis result
 */
export interface VideoAnalysis {
  videoId: string;
  userId: string;
  overall: {
    score: number;
    grade: "A" | "B" | "C" | "D" | "F";
    summary: string;
    consistencyScore: number;
  };
  dimensions: {
    lighting: DimensionAnalysis;
    spatial: DimensionAnalysis;
    color: DimensionAnalysis;
    clutter: DimensionAnalysis;
    biophilic: DimensionAnalysis;
    fengShui: DimensionAnalysis;
  };
  timeline: TimelineMarker[];
  frames: FrameAnalysis[];
  categorizedProblems: CategorizedProblems;
  analyzedAt: string;
}

/**
 * Video analysis progress
 */
export interface VideoAnalysisProgress {
  currentFrame: number;
  totalFrames: number;
  percentComplete: number;
  currentStep: VideoAnalysisStatus;
}

// ============================================================================
// Analysis Response Types
// ============================================================================

/**
 * Response when video analysis is pending
 */
export interface VideoAnalysisPendingResponse {
  status: "pending";
  message: string;
}

/**
 * Response when video is queued for processing
 */
export interface VideoAnalysisQueuedResponse {
  status: "queued";
  message: string;
}

/**
 * Response when video is being processed
 */
export interface VideoAnalysisProcessingResponse {
  status: "extracting" | "moderating" | "analyzing" | "aggregating";
  message: string;
  progress?: VideoAnalysisProgress;
}

/**
 * Response when video analysis is completed
 */
export interface VideoAnalysisCompletedResponse {
  status: "completed";
  video: {
    videoId: string;
    videoStoragePath: string;
    thumbnailStoragePath: string;
    duration: number;
    uploadedAt: string;
  };
  analysis: VideoAnalysis;
}

/**
 * Response when video analysis failed
 */
export interface VideoAnalysisFailedResponse {
  status: "failed";
  error: string;
}

/**
 * Combined video analysis response type
 */
export type VideoAnalysisResponse =
  | VideoAnalysisPendingResponse
  | VideoAnalysisQueuedResponse
  | VideoAnalysisProcessingResponse
  | VideoAnalysisCompletedResponse
  | VideoAnalysisFailedResponse;

// ============================================================================
// Pub/Sub Message Types
// ============================================================================

/**
 * Pub/Sub message for video analysis queue
 */
export interface VideoAnalysisMessage {
  videoId: string;
  userId: string;
}

// ============================================================================
// Video Validation Types
// ============================================================================

/**
 * Video validation result
 */
export interface VideoValidationResult {
  valid: boolean;
  duration?: number;
  width?: number;
  height?: number;
  error?: string;
}
