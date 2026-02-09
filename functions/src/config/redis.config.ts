/**
 * Redis Configuration and Client Singleton
 *
 * IMPORTANT: Redis is completely OPTIONAL and NON-BLOCKING.
 * - If REDIS_ENABLED=false or Redis is unavailable, app works normally
 * - All cache operations return null/false gracefully
 * - No blocking or waiting for Redis connection
 */

import {createClient, RedisClientType} from "redis";
import * as logger from "firebase-functions/logger";

// Check if Redis is enabled (disabled by default for safety)
export const REDIS_ENABLED = process.env.REDIS_ENABLED === "true";

// Redis connection configuration
export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  connectTimeout?: number;
  commandTimeout?: number;
}

// Default configuration
const DEFAULT_CONFIG: RedisConfig = {
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
  password: process.env.REDIS_PASSWORD,
  db: parseInt(process.env.REDIS_DB || "0", 10),
  connectTimeout: parseInt(process.env.REDIS_CONNECT_TIMEOUT || "2000", 10),
  commandTimeout: parseInt(process.env.REDIS_COMMAND_TIMEOUT || "1000", 10),
};

// TTL configuration (in seconds)
export const CACHE_TTL = {
  USER_CREDITS: parseInt(process.env.CACHE_TTL_USER_CREDITS || "300", 10),
  USER_PROFILE: parseInt(process.env.CACHE_TTL_USER_PROFILE || "600", 10),
  IMAGE_METADATA: parseInt(process.env.CACHE_TTL_IMAGE_METADATA || "900", 10),
  IMAGE_LIST: parseInt(process.env.CACHE_TTL_IMAGE_LIST || "300", 10),
  ANALYSIS_RESULT: parseInt(process.env.CACHE_TTL_ANALYSIS || "86400", 10),
  FIX_RESULT: parseInt(process.env.CACHE_TTL_FIX_RESULT || "604800", 10),
  FIX_INDEX: parseInt(process.env.CACHE_TTL_FIX_INDEX || "7200", 10),
  IMAGE_HASH: parseInt(process.env.CACHE_TTL_IMAGE_HASH || "2592000", 10),
  API_RESPONSE_SHORT: parseInt(process.env.CACHE_TTL_API_SHORT || "300", 10),
  API_RESPONSE_MEDIUM: parseInt(process.env.CACHE_TTL_API_MEDIUM || "900", 10),
  API_RESPONSE_LONG: parseInt(process.env.CACHE_TTL_API_LONG || "3600", 10),
} as const;

// Cache key prefixes
export const CACHE_KEYS = {
  userCredits: (userId: string) => `user:${userId}:credits`,
  userProfile: (userId: string) => `user:${userId}:profile`,
  userViolations: (userId: string) => `user:${userId}:violations`,
  imageMetadata: (imageId: string) => `image:${imageId}:metadata`,
  imageList: (userId: string) => `user:${userId}:images`,
  imageHash: (userId: string, hash: string) => `ihash:${userId}:${hash}`,
  globalImageHash: (hash: string) => `ihash:global:${hash}`,
  analysis: (imageId: string) => `analysis:${imageId}`,
  fixResult: (fixId: string) => `fix:${fixId}`,
  fixBySignature: (imageId: string, signature: string) =>
    `fixsig:${imageId}:${signature}`,
  fixIndex: (imageId: string) => `fixidx:${imageId}`,
  apiResponse: (endpoint: string, params: string) =>
    `api:${endpoint}:${params}`,
  rateLimit: (userId: string, endpoint: string) => `rl:${userId}:${endpoint}`,
  // Video cache keys
  videoMetadata: (videoId: string) => `video:${videoId}:metadata`,
  videoList: (userId: string) => `user:${userId}:videos`,
  videoAnalysis: (videoId: string) => `videoanalysis:${videoId}`,
  videoProgress: (videoId: string) => `videoprogress:${videoId}`,
  // Video fix cache keys
  videoFixResult: (fixId: string) => `vfix:${fixId}`,
  videoFixBySignature: (videoId: string, signature: string) =>
    `vfixsig:${videoId}:${signature}`,
  videoFixIndex: (videoId: string) => `vfixidx:${videoId}`,
  videoHash: (userId: string, hash: string) => `vhash:${userId}:${hash}`,
  // Asset cache keys
  assetList: (userId: string) => `user:${userId}:assets`,
} as const;

/**
 * Non-blocking Redis Client
 * - Returns null immediately if not connected
 * - Never blocks the main application flow
 */
class RedisClientSingleton {
  private client: RedisClientType | null = null;
  private isConnected = false;
  private connectionAttempted = false;
  private config: RedisConfig;

  constructor(config: RedisConfig = DEFAULT_CONFIG) {
    this.config = config;
  }

  /**
   * Initialize connection in background (non-blocking)
   * Call this once at startup if Redis is enabled
   */
  initializeAsync(): void {
    if (!REDIS_ENABLED) {
      logger.info("Redis disabled (REDIS_ENABLED=false)");
      return;
    }

    if (this.connectionAttempted) {
      return;
    }

    this.connectionAttempted = true;

    // Fire-and-forget connection attempt
    this.connect().catch((error) => {
      logger.warn("Redis connection failed, continuing without cache", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Get client if connected, null otherwise (NON-BLOCKING)
   */
  getClientIfReady(): RedisClientType | null {
    if (!REDIS_ENABLED || !this.isConnected || !this.client) {
      return null;
    }
    return this.client;
  }

  /**
   * Check if Redis is available (NON-BLOCKING)
   */
  isAvailable(): boolean {
    return REDIS_ENABLED && this.isConnected && this.client !== null;
  }

  /**
   * Establish Redis connection
   */
  private async connect(): Promise<void> {
    const url = this.config.password
      ? `redis://:${this.config.password}@${this.config.host}:${this.config.port}/${this.config.db}`
      : `redis://${this.config.host}:${this.config.port}/${this.config.db}`;

    this.client = createClient({
      url,
      socket: {
        connectTimeout: this.config.connectTimeout,
        reconnectStrategy: (retries: number) => {
          // Stop retrying after 3 attempts to avoid blocking
          if (retries > 3) {
            logger.warn("Redis: stopping reconnection attempts");
            return false; // Stop retrying
          }
          return Math.min(retries * 500, 2000);
        },
      },
    });

    this.client.on("ready", () => {
      this.isConnected = true;
      logger.info("Redis connected");
    });

    this.client.on("error", (error: Error) => {
      // Just log, don't throw - Redis errors should never crash the app
      logger.debug("Redis error (non-fatal)", {error: error.message});
    });

    this.client.on("end", () => {
      this.isConnected = false;
    });

    await this.client.connect();
  }

  /**
   * Gracefully close connection
   */
  async disconnect(): Promise<void> {
    if (this.client && this.isConnected) {
      try {
        await this.client.quit();
      } catch {
        // Ignore disconnect errors
      }
      this.client = null;
      this.isConnected = false;
    }
  }
}

// Export singleton instance
export const redisClient = new RedisClientSingleton(DEFAULT_CONFIG);

// Initialize Redis connection on module load (non-blocking)
if (REDIS_ENABLED) {
  redisClient.initializeAsync();
}
