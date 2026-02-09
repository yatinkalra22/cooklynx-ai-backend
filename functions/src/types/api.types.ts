/**
 * API Types - These TypeScript interfaces are automatically converted
 * to OpenAPI schemas by tsoa. No manual documentation needed!
 */

// ============================================================================
// Common Types
// ============================================================================

/**
 * Standard error response
 */
export interface ErrorResponse {
  error: string;
  message: string;
  details?: string;
}

/**
 * Health check response
 */
export interface HealthResponse {
  status: "ok";
  timestamp: string;
}

// ============================================================================
// Auth Types
// ============================================================================

/**
 * User profile information
 */
export interface User {
  uid: string;
  email: string;
  displayName: string | null;
  photoURL?: string | null;
  emailVerified?: boolean;
  createdAt?: string;
  metadata?: UserMetadata;
  /** Current credit usage (how many credits have been consumed) */
  credit?: number;
  /** Maximum credits allowed for this user */
  creditLimit?: number;
}

export interface UserMetadata {
  signupMethod: "email" | "google" | "apple";
  googleId?: string;
  lastLoginAt?: string;
}

/**
 * Request body for user signup
 */
export interface SignupRequest {
  /** User email address */
  email: string;
  /** Password (minimum 6 characters) */
  password: string;
  /** Optional display name */
  displayName?: string;
}

/**
 * Response after successful signup
 */
export interface SignupResponse {
  message: string;
  user: User;
  /** Client should send verification email via Firebase SDK */
  requiresEmailVerification: boolean;
}

/**
 * Request body for login
 */
export interface LoginRequest {
  /** User email address */
  email: string;
  /** User password */
  password: string;
}

/**
 * Response after successful login
 */
export interface LoginSuccessResponse {
  message: string;
  user: User;
  token: string;
}

/**
 * Response when login credentials are correct but email not verified
 */
export interface LoginVerificationPendingResponse {
  message: string;
  /** Indicates email verification is required */
  requiresVerification: true;
  /** Whether verification email was sent (false if rate limited) */
  emailSent: boolean;
  /** Number of attempts remaining before cooldown */
  attemptsRemaining?: number;
  /** When the cooldown resets (ISO timestamp) - only present if rate limited */
  retryAfter?: string;
}

/**
 * Combined login response type
 */
export type LoginResponse =
  | LoginSuccessResponse
  | LoginVerificationPendingResponse;

/**
 * Request body for Google Sign-In
 */
export interface GoogleSignInRequest {
  /** Google ID token from client-side authentication */
  idToken: string;
}

/**
 * Request body for profile update
 */
export interface ProfileUpdateRequest {
  /** New display name */
  displayName?: string;
  /** New profile photo URL */
  photoURL?: string;
}

/**
 * Response after profile update
 */
export interface ProfileUpdateResponse {
  message: string;
  user: {
    uid: string;
    displayName: string | null;
    photoURL: string | null;
  };
}

/**
 * Response with user profile
 */
export interface ProfileResponse {
  user: User;
}

/**
 * Response after account deletion
 */
export interface DeleteAccountResponse {
  message: string;
}

/**
 * Request body for resending verification email
 */
export interface ResendVerificationRequest {
  /** User email address */
  email: string;
}

/**
 * Response for verification status check
 */
export interface ResendVerificationResponse {
  message: string;
  /** Whether email is verified */
  emailVerified?: boolean;
  /** Whether user can request another verification email */
  canResend?: boolean;
  /** Number of attempts remaining before cooldown */
  attemptsRemaining?: number;
  /** When the cooldown resets (ISO timestamp) - only present if rate limited */
  retryAfter?: string;
}

// ============================================================================
// Credit Types
// ============================================================================

export type CreditTransactionType =
  | "image_analysis"
  | "image_fix"
  | "video_analysis"
  | "video_fix";

export interface CreditLedgerEntry {
  type: CreditTransactionType;
  amount: number;
  resourceId: string;
  timestamp: string;
  creditAfter: number;
}

// ============================================================================
// Image Types
// ============================================================================

/**
 * Image metadata
 */
export interface ImageMetadata {
  imageId: string;
  userId: string;
  storagePath: string;
  originalName: string;
  mimeType: string;
  size: number;
  width: number;
  height: number;
  uploadedAt: string;
  analysisStatus: AnalysisStatus;
  analyzedAt?: string;
  error?: string;
  /** Overall score from analysis (0-100) */
  overallScore: number;
  /** Number of completed fix versions for this image */
  fixCount: number;
}

export type AnalysisStatus = "pending" | "processing" | "completed" | "failed";

/**
 * Response after image upload
 */
export interface ImageUploadResponse {
  message: string;
  image: {
    imageId: string;
    storagePath: string;
    width: number;
    height: number;
    uploadedAt: string;
  };
  status: "pending" | "completed";
  /** True if this image was uploaded before and analysis was copied */
  isDuplicate?: boolean;
  /** Overall score (only present if status is "completed") */
  overallScore?: number;
}

/**
 * Response with list of images
 */
export interface ImageListResponse {
  images: ImageMetadata[];
}

// ============================================================================
// Analysis Types
// ============================================================================

/**
 * Problem identified in room analysis
 */
export interface Problem {
  problemId: string;
  title: string;
  description: string;
  impact: string;
  research: string;
  severity: "low" | "medium" | "high";
}

/**
 * Solution for an identified problem
 */
export interface Solution {
  solutionId: string;
  problemId: string;
  title: string;
  description: string;
  steps: string[];
  costEstimate: string;
  difficulty: "easy" | "medium" | "hard";
  timeEstimate: string;
  priority: number;
}

/**
 * Analysis for a single dimension
 */
export interface DimensionAnalysis {
  score: number;
  status: "excellent" | "good" | "needs_improvement" | "poor";
  problems: Problem[];
  solutions: Solution[];
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

/**
 * Response when analysis is pending
 */
export interface AnalysisPendingResponse {
  status: "pending";
  message: string;
}

/**
 * Response when analysis is processing
 */
export interface AnalysisProcessingResponse {
  status: "processing";
  message: string;
}

/**
 * Response when analysis is completed
 */
export interface AnalysisCompletedResponse {
  status: "completed";
  image: {
    imageId: string;
    storagePath: string;
    uploadedAt: string;
  };
  analysis: RoomAnalysis;
}

/**
 * Response when analysis failed
 */
export interface AnalysisFailedResponse {
  status: "failed";
  error: string;
}

/**
 * Combined analysis response type
 */
export type AnalysisResponse =
  | AnalysisPendingResponse
  | AnalysisProcessingResponse
  | AnalysisCompletedResponse
  | AnalysisFailedResponse;

// ============================================================================
// Fix Types
// ============================================================================

export type FixStatus = "pending" | "processing" | "completed" | "failed";
export type FixScope = "single" | "multiple" | "all";

/**
 * Fix job metadata stored in database
 */
export interface FixJob {
  fixId: string;
  originalImageId: string;
  userId: string;
  status: FixStatus;
  fixScope: FixScope;
  problemIds: string[];
  dimensions: string[];
  version: number;
  parentFixId?: string;
  /** Signature hash of imageId + sorted problemIds for deduplication */
  fixSignature?: string;
  /** If this fix reuses a previous result, the source fix ID */
  sourceFixId?: string;
  createdAt: string;
  completedAt?: string;
  error?: string;
}

/**
 * Fix job plus (optional) result payload.
 * `result` is present only when status is "completed" and the result exists.
 */
export interface FixJobWithResult extends FixJob {
  result?: FixResult;
}

/**
 * Detailed fix result with generated image
 */
export interface FixResult {
  fixId: string;
  originalImageId: string;
  fixedImageStoragePath: string;
  problemsFixed: FixedProblem[];
  summary: string;
  fixName: string;
  changesApplied: string[];
  originalScore: number;
  fixedScore: number;
  scoreDelta: number;
  originalDimensionScores: DimensionScores;
  fixedDimensionScores: DimensionScores;
  generatedAt: string;
  /** Description of the fix plan (used as fallback when image generation fails or as primary explanation) */
  fixDescription?: string;
}

/**
 * Per-dimension scores
 */
export interface DimensionScores {
  lighting: number;
  spatial: number;
  color: number;
  clutter: number;
  biophilic: number;
  fengShui: number;
}

/**
 * Information about a fixed problem
 */
export interface FixedProblem {
  problemId: string;
  dimension: string;
  title: string;
  solutionApplied: string;
}

/**
 * Request body for creating a fix
 */
export interface CreateFixRequest {
  /** Scope of the fix: single problem, multiple problems, or all problems */
  fixScope: FixScope;
  /** IDs of specific problems to fix (required for single/multiple scope) */
  problemIds?: string[];
  /** Optional parent fix ID for chained fixes */
  parentFixId?: string;
}

/**
 * Response after fix request creation
 */
export interface CreateFixResponse {
  message: string;
  fix: {
    fixId: string;
    status: FixStatus;
    version: number;
    createdAt: string;
  };
  /** Optional: current list of fixes for this image (includes results for completed fixes) */
  fixes?: FixJobWithResult[];
}

/**
 * Response when fix is pending
 */
export interface FixPendingResponse {
  status: "pending";
  fixId: string;
  message: string;
}

/**
 * Response when fix is processing
 */
export interface FixProcessingResponse {
  status: "processing";
  fixId: string;
  message: string;
}

/**
 * Response when fix is completed
 */
export interface FixCompletedResponse {
  status: "completed";
  fix: FixJob;
  result: FixResult;
}

/**
 * Response when fix failed
 */
export interface FixFailedResponse {
  status: "failed";
  fixId: string;
  error: string;
}

/**
 * Combined fix status response type
 */
export type FixStatusResponse =
  | FixPendingResponse
  | FixProcessingResponse
  | FixCompletedResponse
  | FixFailedResponse;

/**
 * Response with list of fixes for an image
 */
export interface FixListResponse {
  fixes: FixJobWithResult[];
}

/**
 * Response after fix deletion
 */
export interface DeleteFixResponse {
  message: string;
}
