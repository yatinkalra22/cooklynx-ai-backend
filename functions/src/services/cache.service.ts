/**
 * Cache Service
 *
 * NON-BLOCKING cache operations:
 * - If Redis unavailable, returns null/false immediately
 * - Never throws errors - all operations are safe to call
 * - Uses fire-and-forget pattern for writes
 */

import {
  redisClient,
  REDIS_ENABLED,
  CACHE_TTL,
  CACHE_KEYS,
} from "../config/redis.config";

export class CacheService {
  /**
   * Get value from cache (NON-BLOCKING)
   * Returns null if not found or Redis unavailable
   */
  static async get<T>(key: string): Promise<T | null> {
    const client = redisClient.getClientIfReady();
    if (!client) return null;

    try {
      const value = await client.get(key);
      if (value === null) return null;
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  /**
   * Set value in cache (NON-BLOCKING, fire-and-forget safe)
   */
  static async set<T>(
    key: string,
    value: T,
    ttlSeconds: number = CACHE_TTL.API_RESPONSE_MEDIUM
  ): Promise<boolean> {
    const client = redisClient.getClientIfReady();
    if (!client) return false;

    try {
      await client.setEx(key, ttlSeconds, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete value from cache (NON-BLOCKING)
   */
  static async delete(key: string): Promise<boolean> {
    const client = redisClient.getClientIfReady();
    if (!client) return false;

    try {
      await client.del(key);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete multiple keys matching a pattern (NON-BLOCKING)
   */
  static async deletePattern(pattern: string): Promise<number> {
    const client = redisClient.getClientIfReady();
    if (!client) return 0;

    try {
      let deletedCount = 0;
      let cursor = 0;

      do {
        const result = await client.scan(cursor, {MATCH: pattern, COUNT: 100});
        cursor = result.cursor;
        if (result.keys.length > 0) {
          await client.del(result.keys);
          deletedCount += result.keys.length;
        }
      } while (cursor !== 0);

      return deletedCount;
    } catch {
      return 0;
    }
  }

  /**
   * Read-through cache pattern (NON-BLOCKING)
   * If cache unavailable, just calls fetchFn directly
   */
  static async getOrSet<T>(
    key: string,
    fetchFn: () => Promise<T>,
    options: {ttl?: number; skipCache?: boolean} = {}
  ): Promise<T> {
    const {ttl = CACHE_TTL.API_RESPONSE_MEDIUM, skipCache = false} = options;

    if (skipCache || !REDIS_ENABLED) {
      return fetchFn();
    }

    // Try cache first
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }

    // Cache miss - fetch data
    const value = await fetchFn();

    // Cache result (fire-and-forget)
    if (value !== null && value !== undefined) {
      this.set(key, value, ttl).catch(() => {});
    }

    return value;
  }

  /**
   * Check if key exists (NON-BLOCKING)
   */
  static async exists(key: string): Promise<boolean> {
    const client = redisClient.getClientIfReady();
    if (!client) return false;

    try {
      return (await client.exists(key)) === 1;
    } catch {
      return false;
    }
  }

  /**
   * Check if Redis is available
   */
  static isAvailable(): boolean {
    return redisClient.isAvailable();
  }

  // ============================================
  // Domain-specific helpers (all NON-BLOCKING)
  // ============================================

  static async cacheAnalysis(
    imageId: string,
    analysis: unknown
  ): Promise<void> {
    this.set(
      CACHE_KEYS.analysis(imageId),
      analysis,
      CACHE_TTL.ANALYSIS_RESULT
    ).catch(() => {});
  }

  static async getAnalysis<T>(imageId: string): Promise<T | null> {
    return this.get<T>(CACHE_KEYS.analysis(imageId));
  }

  static async cacheUserCredits(
    userId: string,
    credit: number,
    creditLimit: number
  ): Promise<void> {
    this.set(
      CACHE_KEYS.userCredits(userId),
      {credit, creditLimit},
      CACHE_TTL.USER_CREDITS
    ).catch(() => {});
  }

  static async getUserCredits(
    userId: string
  ): Promise<{credit: number; creditLimit: number} | null> {
    return this.get<{credit: number; creditLimit: number}>(
      CACHE_KEYS.userCredits(userId)
    );
  }

  // Invalidation helpers
  static async invalidateUserCache(userId: string): Promise<void> {
    Promise.all([
      this.delete(CACHE_KEYS.userCredits(userId)),
      this.delete(CACHE_KEYS.userProfile(userId)),
      this.delete(CACHE_KEYS.imageList(userId)),
      this.delete(CACHE_KEYS.assetList(userId)),
    ]).catch(() => {});
  }

  static async invalidateImageCache(imageId: string): Promise<void> {
    Promise.all([
      this.delete(CACHE_KEYS.imageMetadata(imageId)),
      this.delete(CACHE_KEYS.analysis(imageId)),
    ]).catch(() => {});
  }

  // ============================================
  // Video Cache Helpers (all NON-BLOCKING)
  // ============================================

  static async cacheVideoHash(
    userId: string,
    hash: string,
    videoId: string
  ): Promise<void> {
    this.set(
      CACHE_KEYS.videoHash(userId, hash),
      videoId,
      CACHE_TTL.IMAGE_HASH
    ).catch(() => {});
  }

  static async getVideoByHash(
    userId: string,
    hash: string
  ): Promise<string | null> {
    return this.get<string>(CACHE_KEYS.videoHash(userId, hash));
  }
}
