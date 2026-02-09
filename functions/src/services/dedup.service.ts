/**
 * Image Deduplication Service
 *
 * Strategy:
 * - Always create new image record (consistent UX)
 * - Reuse existing ANALYSIS if same image was uploaded before
 * - Save AI cost, not storage cost
 *
 * Hash is stored in:
 * - images/{imageId}/contentHash (on each image)
 * - imageHashes/{userId}/{hash} → imageId (index for fast lookup)
 */

import * as crypto from "crypto";
import {database} from "../config/firebase.config";
import {CacheService} from "./cache.service";
import {CACHE_KEYS, CACHE_TTL, REDIS_ENABLED} from "../config/redis.config";
import * as logger from "firebase-functions/logger";

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  hash: string;
  sourceImageId?: string; // The original image to copy analysis from
}

export class DedupService {
  /**
   * Generate SHA-256 hash of image content
   */
  static generateImageHash(imageBuffer: Buffer): string {
    return crypto.createHash("sha256").update(imageBuffer).digest("hex");
  }

  /**
   * Check if user has uploaded this image before
   * Returns sourceImageId if found (to copy analysis from)
   */
  static async checkDuplicate(
    userId: string,
    imageBuffer: Buffer
  ): Promise<DuplicateCheckResult> {
    const hash = this.generateImageHash(imageBuffer);
    const shortHash = hash.slice(0, 16);

    // Step 1: Check Redis cache (if available)
    if (REDIS_ENABLED) {
      const cachedImageId = await CacheService.get<string>(
        CACHE_KEYS.imageHash(userId, hash)
      );
      if (cachedImageId) {
        const hasAnalysis = await this.hasCompletedAnalysis(cachedImageId);
        if (hasAnalysis) {
          logger.info("dedup:cache_hit", {userId, shortHash, sourceImageId: cachedImageId});
          return {isDuplicate: true, hash, sourceImageId: cachedImageId};
        }
      }
    }

    // Step 2: Check database index
    try {
      const indexRef = database.ref(`imageHashes/${userId}/${hash}`);
      const snapshot = await indexRef.get();

      if (snapshot.exists()) {
        const sourceImageId = snapshot.val();
        const hasAnalysis = await this.hasCompletedAnalysis(sourceImageId);

        if (hasAnalysis) {
          // Cache for future lookups
          if (REDIS_ENABLED) {
            CacheService.set(
              CACHE_KEYS.imageHash(userId, hash),
              sourceImageId,
              CACHE_TTL.IMAGE_HASH
            ).catch(() => {});
          }

          logger.info("dedup:db_hit", {userId, shortHash, sourceImageId});
          return {isDuplicate: true, hash, sourceImageId};
        }
      }
    } catch (error) {
      logger.warn("dedup:check_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {isDuplicate: false, hash};
  }

  /**
   * Check if image has completed analysis
   */
  private static async hasCompletedAnalysis(imageId: string): Promise<boolean> {
    try {
      const snapshot = await database.ref(`images/${imageId}/analysisStatus`).get();
      return snapshot.exists() && snapshot.val() === "completed";
    } catch {
      return false;
    }
  }

  /**
   * Record image hash after upload (creates index for future lookups)
   * Only records if this is the first image with this hash
   */
  static async recordImageHash(
    userId: string,
    imageId: string,
    hash: string
  ): Promise<void> {
    try {
      const indexRef = database.ref(`imageHashes/${userId}/${hash}`);

      // Only set if doesn't exist (first image wins)
      const snapshot = await indexRef.get();
      if (!snapshot.exists()) {
        await indexRef.set(imageId);
        logger.debug("dedup:hash_indexed", {userId, imageId, hash: hash.slice(0, 16)});
      }

      // Cache in Redis
      if (REDIS_ENABLED) {
        CacheService.set(
          CACHE_KEYS.imageHash(userId, hash),
          imageId,
          CACHE_TTL.IMAGE_HASH
        ).catch(() => {});
      }
    } catch (error) {
      logger.warn("dedup:index_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Copy analysis from source image to new image
   */
  static async copyAnalysis(
    sourceImageId: string,
    targetImageId: string,
    userId: string
  ): Promise<boolean> {
    try {
      // Get source analysis
      const analysisSnapshot = await database.ref(`analysis/${sourceImageId}`).get();
      if (!analysisSnapshot.exists()) {
        return false;
      }

      const sourceAnalysis = analysisSnapshot.val();

      // Get source image for score
      const sourceImageSnapshot = await database.ref(`images/${sourceImageId}`).get();
      const sourceImage = sourceImageSnapshot.val();

      // Copy analysis with new IDs
      const targetAnalysis = {
        ...sourceAnalysis,
        imageId: targetImageId,
        userId,
        copiedFrom: sourceImageId,
        copiedAt: new Date().toISOString(),
      };

      // Save and update in parallel
      await Promise.all([
        database.ref(`analysis/${targetImageId}`).set(targetAnalysis),
        database.ref(`images/${targetImageId}`).update({
          analysisStatus: "completed",
          analyzedAt: new Date().toISOString(),
          overallScore: sourceImage?.overallScore || sourceAnalysis.overall?.score || 0,
          analysisSourceId: sourceImageId,
        }),
      ]);

      // Cache the copied analysis
      if (REDIS_ENABLED) {
        CacheService.cacheAnalysis(targetImageId, targetAnalysis);
      }

      logger.info("dedup:analysis_copied", {sourceImageId, targetImageId});
      return true;
    } catch (error) {
      logger.error("dedup:copy_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
