/**
 * API Response Caching Middleware
 *
 * Provides Express middleware for caching GET endpoint responses:
 * - Automatic cache key generation from URL + query params
 * - User-scoped caching for authenticated endpoints
 * - Configurable TTL per endpoint
 * - Cache-Control headers for client-side caching
 * - Bypass cache via query param or header
 */

import {Request, Response, NextFunction} from "express";
import {CacheService} from "../services/cache.service";
import {CACHE_KEYS, CACHE_TTL} from "../config/redis.config";
import * as logger from "firebase-functions/logger";

export interface CacheMiddlewareOptions {
  ttl?: number; // TTL in seconds
  keyPrefix?: string; // Custom key prefix
  userScoped?: boolean; // Include userId in cache key
  varyByQuery?: boolean; // Include query params in cache key
  varyByHeaders?: string[]; // Include specific headers in cache key
}

interface CacheAuthUser {
  uid: string;
}

/**
 * Generate cache key from request
 */
function generateCacheKey(
  req: Request,
  options: CacheMiddlewareOptions
): string {
  const {keyPrefix = "api", userScoped = true, varyByQuery = true} = options;

  const parts: string[] = [keyPrefix];

  // Add user ID if user-scoped
  if (userScoped && req.user) {
    const user = req.user as CacheAuthUser;
    parts.push(`u:${user.uid}`);
  }

  // Add endpoint path
  parts.push(req.path.replace(/\//g, ":"));

  // Add sorted query params
  if (varyByQuery && Object.keys(req.query).length > 0) {
    const sortedParams = Object.keys(req.query)
      .filter((k) => k !== "skipCache" && k !== "nocache")
      .sort()
      .map((k) => `${k}=${req.query[k]}`)
      .join("&");
    if (sortedParams) {
      parts.push(`q:${sortedParams}`);
    }
  }

  return parts.join(":");
}

/**
 * Check if request should bypass cache
 */
function shouldBypassCache(req: Request): boolean {
  // Query param bypass
  if (req.query.skipCache === "true" || req.query.nocache === "true") {
    return true;
  }

  // Header bypass
  if (
    req.headers["cache-control"] === "no-cache" ||
    req.headers["x-skip-cache"] === "true"
  ) {
    return true;
  }

  return false;
}

/**
 * Create cache middleware with options
 *
 * Usage:
 * ```
 * app.get('/api/data', withCache({ ttl: 300 }), handler);
 * ```
 */
export function withCache(options: CacheMiddlewareOptions = {}) {
  const {ttl = CACHE_TTL.API_RESPONSE_MEDIUM} = options;

  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    // Only cache GET requests
    if (req.method !== "GET") {
      return next();
    }

    // Check bypass conditions
    if (shouldBypassCache(req)) {
      logger.debug("cache:bypassed", {path: req.path});
      return next();
    }

    const cacheKey = generateCacheKey(req, options);

    try {
      // Try to get cached response
      const cached = await CacheService.get<{
        statusCode: number;
        body: unknown;
        headers?: Record<string, string>;
      }>(cacheKey);

      if (cached) {
        logger.debug("cache:hit", {path: req.path, key: cacheKey});

        // Set cache headers
        res.setHeader("X-Cache", "HIT");
        res.setHeader("X-Cache-Key", cacheKey);

        // Restore original headers if saved
        if (cached.headers) {
          Object.entries(cached.headers).forEach(([key, value]) => {
            res.setHeader(key, value);
          });
        }

        res.status(cached.statusCode).json(cached.body);
        return;
      }

      logger.debug("cache:miss", {path: req.path, key: cacheKey});

      // Cache miss - capture response for caching
      const originalJson = res.json.bind(res);

      res.json = function(body: unknown) {
        // Only cache successful responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const cacheData = {
            statusCode: res.statusCode,
            body,
            headers: {
              "Content-Type": res.getHeader("Content-Type") as string,
            },
          };

          // Don't await - fire and forget
          CacheService.set(cacheKey, cacheData, ttl).catch((err) => {
            logger.warn("cache:set_failed", {
              key: cacheKey,
              error: err.message,
            });
          });
        }

        // Set cache headers
        res.setHeader("X-Cache", "MISS");
        res.setHeader("X-Cache-Key", cacheKey);
        res.setHeader("Cache-Control", `private, max-age=${ttl}`);

        return originalJson(body);
      };

      next();
    } catch (error) {
      // On cache error, continue without caching
      logger.warn("cache:middleware_error", {
        path: req.path,
        error: error instanceof Error ? error.message : String(error),
      });
      next();
    }
  };
}

/**
 * Pre-configured cache middleware for common TTLs
 */
export const cacheShort = withCache({ttl: CACHE_TTL.API_RESPONSE_SHORT}); // 5 min
export const cacheMedium = withCache({ttl: CACHE_TTL.API_RESPONSE_MEDIUM}); // 15 min
export const cacheLong = withCache({ttl: CACHE_TTL.API_RESPONSE_LONG}); // 1 hour

/**
 * Cache invalidation helper for controllers
 * Call this after mutations to clear related caches
 */
export async function invalidateCache(patterns: string[]): Promise<void> {
  await Promise.all(
    patterns.map((pattern) => CacheService.deletePattern(pattern))
  );
}

/**
 * Wrapper function for handlers with caching
 *
 * Usage:
 * ```
 * const handler = withCacheHandler(
 *   async (req) => ({ data: 'value' }),
 *   { ttl: 300, userScoped: true }
 * );
 * ```
 */
export function withCacheHandler<T>(
  handler: (req: Request) => Promise<T>,
  options: CacheMiddlewareOptions = {}
) {
  const {ttl = CACHE_TTL.API_RESPONSE_MEDIUM} = options;

  return async (req: Request, res: Response): Promise<void> => {
    // Only cache GET requests
    if (req.method !== "GET" || shouldBypassCache(req)) {
      const result = await handler(req);
      res.json(result);
      return;
    }

    const cacheKey = generateCacheKey(req, options);

    try {
      // Use read-through cache pattern
      const result = await CacheService.getOrSet(cacheKey, () => handler(req), {
        ttl,
      });

      // Set cache headers
      res.setHeader("Cache-Control", `private, max-age=${ttl}`);
      res.json(result);
    } catch (error) {
      // On error, try without cache
      const result = await handler(req);
      res.json(result);
    }
  };
}

/**
 * Generate cache key for API responses (exported for manual use)
 */
export function getApiCacheKey(
  endpoint: string,
  userId?: string,
  params?: Record<string, string>
): string {
  const paramStr = params
    ? Object.entries(params)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("&")
    : "";

  const parts = ["api", endpoint];
  if (userId) parts.push(`u:${userId}`);
  if (paramStr) parts.push(`q:${paramStr}`);

  return CACHE_KEYS.apiResponse(parts.join(":"), paramStr);
}
