import {Controller, Get, Request, Response, Route, Security, Tags} from "tsoa";
import {Request as ExpressRequest} from "express";
import {AssetService} from "../services/asset.service";
import {CacheService} from "../services/cache.service";
import {CACHE_KEYS, CACHE_TTL} from "../config/redis.config";
import {AssetListResponse} from "../types/asset.types";
import {ErrorResponse} from "../types/api.types";
import {AuthUser} from "../middleware/tsoa-auth.middleware";
import * as logger from "firebase-functions/logger";

@Route("v1/assets")
@Tags("Assets")
@Security("BearerAuth")
export class AssetController extends Controller {
  /**
   * Get all assets (images) uploaded by the authenticated user.
   * Assets are returned in reverse chronological order (newest first).
   * @summary List user's assets
   */
  @Get("")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(500, "Internal server error")
  public async listAssets(
    @Request() request: ExpressRequest
  ): Promise<AssetListResponse> {
    const user = request.user as AuthUser;

    if (!user?.uid) {
      this.setStatus(401);
      throw {error: "Unauthorized", message: "Invalid or missing auth token"};
    }

    try {
      // Check cache
      const cacheKey = CACHE_KEYS.assetList(user.uid);
      const cachedList = await CacheService.get<AssetListResponse>(cacheKey);

      if (cachedList) {
        return cachedList;
      }

      // Fetch assets
      const assets = await AssetService.listAssets(user.uid);
      const result = {assets};

      // Cache result
      const ttl =
        assets.length === 0
          ? CACHE_TTL.API_RESPONSE_SHORT
          : CACHE_TTL.API_RESPONSE_MEDIUM;
      CacheService.set(cacheKey, result, ttl).catch(() => {});

      return result;
    } catch (error) {
      logger.error("asset:list:failed", {
        userId: user.uid,
        error: error instanceof Error ? error.message : String(error),
      });

      this.setStatus(500);
      throw {error: "Internal Server Error", message: "Failed to list assets"};
    }
  }
}
