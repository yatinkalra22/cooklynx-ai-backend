import {ImageMetadata} from "./api.types";
import {VideoMetadata} from "./video.types";

/**
 * Common asset type for both images and videos
 */
export type AssetType = "image" | "video";

/**
 * Base properties shared by all assets
 * Frontend uses storagePath with Firebase Storage SDK + auth token
 */
export interface AssetBase {
  id: string;
  type: AssetType;
  storagePath: string;
  thumbnailPath?: string;
  uploadedAt: string;
  analysisStatus: string;
  overallScore: number;
  originalName: string;
  mimeType: string;
  size: number;
  fixCount?: number;
}

/**
 * Image asset wrapper
 */
export interface ImageAsset extends AssetBase {
  type: "image";
  width: number;
  height: number;
  originalData: ImageMetadata;
}

/**
 * Video asset wrapper
 */
export interface VideoAsset extends AssetBase {
  type: "video";
  width: number;
  height: number;
  duration: number;
  thumbnailPath: string;
  originalData: VideoMetadata;
}

/**
 * Unified asset type
 */
export type Asset = ImageAsset | VideoAsset;

/**
 * Response for asset list endpoint
 */
export interface AssetListResponse {
  assets: Asset[];
}
