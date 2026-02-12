import {ImageMetadata} from "./api.types";

/**
 * Common asset type (images only)
 */
export type AssetType = "image";

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
 * Unified asset type (images only)
 */
export type Asset = ImageAsset;

/**
 * Response for asset list endpoint
 */
export interface AssetListResponse {
  assets: Asset[];
}
