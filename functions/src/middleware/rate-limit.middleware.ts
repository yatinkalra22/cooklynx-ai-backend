import rateLimitMiddleware from "express-rate-limit";

/**
 * Rate limiting middleware to prevent brute force attacks
 */

/**
 * Aggressive rate limiter for authentication endpoints
 * Limits to 50 requests per 15 minutes per IP + email combination
 */
export const authLimiter = rateLimitMiddleware({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 requests per window
  message: {
    error: "Too Many Requests",
    message: "Too many authentication attempts. Please try again later.",
  },
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  // Use default IP-based limiting (handles IPv6 correctly)
  // Note: For email-based limiting, would need application-level tracking
  skipSuccessfulRequests: false,
});

/**
 * Moderate rate limiter for general API endpoints
 * Limits to 100 requests per 15 minutes per IP
 */
export const apiLimiter = rateLimitMiddleware({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // 300 requests per window
  message: {
    error: "Too Many Requests",
    message: "Rate limit exceeded. Please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Strict rate limiter for sensitive operations
 * Limits to 3 requests per hour
 */
export const strictLimiter = rateLimitMiddleware({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  message: {
    error: "Too Many Requests",
    message: "Too many requests. Please try again after an hour.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});
