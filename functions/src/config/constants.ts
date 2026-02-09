/**
 * Application-wide constants
 */

// ============================================================================
// Email & Authentication
// ============================================================================

// RFC 5322 compliant email validation regex
export const EMAIL_REGEX =
  // eslint-disable-next-line max-len
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

// Password validation
export const MIN_PASSWORD_LENGTH = 12;

// Gmail-like providers that support email aliasing
export const ALIASING_PROVIDERS = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
];

// Email verification rate limiting
export const MAX_VERIFICATION_ATTEMPTS = 3;
export const COOLDOWN_HOURS = 2;
export const COOLDOWN_MS = COOLDOWN_HOURS * 60 * 60 * 1000;

// Content moderation - max violations before account is blocked
export const MAX_CONTENT_VIOLATIONS = 3;

// Beta limits - max uploads + fixes per account during hackathon
export const BETA_USAGE_LIMIT = 20;

// ============================================================================
// Image Processing
// ============================================================================

// Credits consumed per image analysis
export const IMAGE_CREDIT_COST = 1;

// Credits consumed per image fix
export const IMAGE_FIX_CREDIT_COST = 1;

// ============================================================================
// Video Processing
// ============================================================================

// Maximum video file size (50MB)
export const VIDEO_MAX_SIZE = 50 * 1024 * 1024;

// Maximum video duration in seconds (60s)
export const VIDEO_MAX_DURATION = 60;

// Credits consumed per video analysis
export const VIDEO_CREDIT_COST = 2;

// Credits consumed per video fix
export const VIDEO_FIX_CREDIT_COST = 2;

// Allowed video mime types
export const VIDEO_ALLOWED_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
];

// Extract a frame every N seconds (used for fallback thumbnail extraction only)
export const VIDEO_FRAME_INTERVAL = 5;

// Maximum frames to extract and analyze (legacy - for backward compatibility)
export const VIDEO_MAX_FRAMES = 12;

// Maximum problem frames to extract (frames only at problem timestamps)
export const VIDEO_MAX_PROBLEM_FRAMES = 6;

// Batch size for parallel frame moderation
export const VIDEO_MODERATION_BATCH_SIZE = 4;

// Maximum additional frames to extract at exact problem timestamps
export const VIDEO_MAX_EXACT_FRAMES = 6;

// Threshold in seconds for deduplicating frames (skip if within this of existing frame)
export const VIDEO_FRAME_DEDUP_THRESHOLD = 1;

// Representative frame positions (percentage of video duration) for general fixes
export const VIDEO_REPRESENTATIVE_FRAMES = [0.1, 0.5, 0.9];

// ============================================================================
// Firebase
// ============================================================================

// Firebase error codes
export const FIREBASE_ERROR_CODES = {
  EMAIL_ALREADY_EXISTS: "auth/email-already-exists",
  USER_NOT_FOUND: "auth/user-not-found",
  INVALID_EMAIL: "auth/invalid-email",
} as const;

// Firebase REST API endpoints
export const FIREBASE_IDENTITY_TOOLKIT_URL =
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";

// ============================================================================
// HTTP Status Codes
// ============================================================================

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501,
} as const;
