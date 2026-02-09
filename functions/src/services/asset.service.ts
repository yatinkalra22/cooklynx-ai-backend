import {database} from "../config/firebase.config";
import {VideoService} from "./video.service";
import {ImageMetadata} from "../types/api.types";
import {Asset, ImageAsset, VideoAsset} from "../types/asset.types";

export class AssetService {
  /**
   * List all assets (images and videos) for a user, sorted by date descending.
   */
  static async listAssets(userId: string): Promise<Asset[]> {
    // Fetch images and videos in parallel
    const [images, videos] = await Promise.all([
      this.listImages(userId),
      VideoService.listVideos(userId),
    ]);

    // Map to unified Asset type with storage paths
    const imageAssets: ImageAsset[] = images.map((img) => ({
      id: img.imageId,
      type: "image",
      storagePath: img.storagePath,
      uploadedAt: img.uploadedAt,
      analysisStatus: img.analysisStatus,
      overallScore: img.overallScore,
      originalName: img.originalName,
      mimeType: img.mimeType,
      size: img.size,
      width: img.width,
      height: img.height,
      fixCount: img.fixCount || 0,
      originalData: img,
    }));

    const videoAssets: VideoAsset[] = videos.map((vid) => ({
      id: vid.videoId,
      type: "video",
      storagePath: vid.videoStoragePath,
      thumbnailPath: vid.thumbnailStoragePath,
      uploadedAt: vid.uploadedAt,
      analysisStatus: vid.analysisStatus,
      overallScore: vid.overallScore,
      originalName: vid.originalName,
      mimeType: vid.mimeType,
      size: vid.size,
      width: vid.width,
      height: vid.height,
      duration: vid.duration,
      fixCount: vid.fixCount || 0,
      originalData: vid,
    }));

    // Combine and sort
    const allAssets: Asset[] = [...imageAssets, ...videoAssets];

    // Sort by uploadedAt descending (newest first)
    allAssets.sort(
      (a, b) =>
        new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
    );

    return allAssets;
  }

  /**
   * Helper to list images (extracted from ImageController logic)
   */
  private static async listImages(userId: string): Promise<ImageMetadata[]> {
    const snapshot = await database
      .ref("images")
      .orderByChild("userId")
      .equalTo(userId)
      .get();

    if (!snapshot.exists()) {
      return [];
    }

    const images: ImageMetadata[] = [];
    snapshot.forEach((child) => {
      const value = child.val();
      if (value && typeof value === "object") {
        images.push({
          ...(value as ImageMetadata),
          imageId: (value as ImageMetadata).imageId || child.key!,
        });
      }
    });

    return images;
  }
}
