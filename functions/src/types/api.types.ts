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
  | "video_fix"
  | "url_recipe_extraction"
  | "image_analysis_refund"
  | "image_fix_refund"
  | "video_analysis_refund"
  | "video_fix_refund"
  | "url_recipe_extraction_refund";

export interface CreditLedgerEntry {
  type: CreditTransactionType;
  amount: number;
  resourceId: string;
  timestamp: string;
  creditAfter: number;
  /** Optional reason for the transaction (e.g., for refunds) */
  reason?: string;
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
 * Food item / Ingredient identified in image
 */
export interface Ingredient {
  name: string;
  category: string;
  notes: string;
  confidence: number;
}

/**
 * Complete food analysis result
 * Includes optional recipe recommendations generated at analysis time
 */
export interface FoodAnalysis {
  items: Ingredient[];
  summary: string;
  analyzedAt: string;
  version: string;
  /** Recipe recommendations based on detected ingredients (optional for backwards compatibility) */
  recommendations?: RecipeRecommendationResponse;
}

/**
 * Recipe recommendation based on ingredients
 */
export interface RecipeRecommendation {
  name: string;
  description: string;
  ingredientsUsed: string[];
  additionalIngredientsNeeded: string[];
  cookingTime: string;
  difficulty: "easy" | "medium" | "hard";
  instructions: string[];
}

/**
 * Response with recipe recommendations
 */
export interface RecipeRecommendationResponse {
  recommendations: RecipeRecommendation[];
  summary: string;
  analyzedAt: string;
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
  analysis: RoomAnalysis | FoodAnalysis;
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
