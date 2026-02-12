import {database} from "../config/firebase.config";
import {ImageMetadata} from "../types/api.types";
import {Asset, ImageAsset} from "../types/asset.types";

export class AssetService {
  /**
   * List all assets (images only) for a user, sorted by date descending.
   */
  static async listAssets(userId: string): Promise<Asset[]> {
    // Fetch images
    const images = await this.listImages(userId);

    // Map to unified Asset type with storage paths
    const imageAssets: ImageAsset[] = images.map((img: ImageMetadata) => ({
      id: img.imageId,
      type: "image" as const,
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

    // Sort by uploadedAt descending (newest first)
    imageAssets.sort(
      (a, b) =>
        new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
    );

    return imageAssets;
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
