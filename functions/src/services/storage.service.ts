import {storage, isEmulator} from "../config/firebase.config";
import type {File} from "@google-cloud/storage";
import {getEmulatorStorageUrl} from "../config/emulator.config";
import sharp from "sharp";
import {AIService} from "./ai.service";

interface UploadImageOptions {
  userId: string;
  imageBuffer: Buffer;
  originalName: string;
  mimeType: string;
}

interface ImageMetadata {
  imageId: string;
  userId: string;
  storagePath: string;
  originalName: string;
  mimeType: string;
  size: number;
  width: number;
  height: number;
  uploadedAt: string;
}

export class StorageService {
  /**
   * Upload image to Cloud Storage
   * - Optimizes image (resize if too large)
   * - Stores in user-specific folder
   * - Returns metadata
   */
  static async uploadImage(
    options: UploadImageOptions
  ): Promise<ImageMetadata> {
    const {userId, imageBuffer, originalName, mimeType} = options;

    // Generate unique image ID and optional emulator download token
    const {v4: uuidv4} = await import("uuid");
    const imageId = `img_${uuidv4()}`;
    const downloadToken = await this.createDownloadToken();

    // Optimize image with Sharp
    const optimizedBuffer = await this.optimizeImage(imageBuffer);

    // Content moderation check - reject inappropriate images
    await AIService.validateImageContent(optimizedBuffer);

    // Get image dimensions
    const metadata = await sharp(optimizedBuffer).metadata();

    // Define storage path: users/{userId}/images/{imageId}.jpg
    const fileName = `users/${userId}/images/${imageId}.jpg`;
    const bucket = storage.bucket();
    const file = bucket.file(fileName);

    // Upload to Cloud Storage
    await file.save(optimizedBuffer, {
      metadata: {
        contentType: mimeType,
        metadata: {
          userId,
          imageId,
          originalName,
          uploadedAt: new Date().toISOString(),
          ...(downloadToken
            ? {firebaseStorageDownloadTokens: downloadToken}
            : {}),
        },
      },
      public: false, // IMPORTANT: Keep images private
    });

    // Store only the storage path, not expired signed URLs
    // Frontend/API can generate fresh signed URLs on-demand using getSignedUrl()
    return {
      imageId,
      userId,
      storagePath: fileName,
      originalName,
      mimeType,
      size: optimizedBuffer.length,
      width: metadata.width || 0,
      height: metadata.height || 0,
      uploadedAt: new Date().toISOString(),
    };
  }

  /**
   * Optimize image:
   * - Resize if larger than 1920x1080
   * - Convert to JPEG
   * - Compress to 85% quality
   */
  private static async optimizeImage(buffer: Buffer): Promise<Buffer> {
    return sharp(buffer)
      .resize(1920, 1080, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({
        quality: 85,
        progressive: true,
      })
      .toBuffer();
  }

  /**
   * Generate new signed URL for existing image
   */
  static async getSignedUrl(userId: string, imageId: string): Promise<string> {
    const fileName = `users/${userId}/images/${imageId}.jpg`;
    const bucket = storage.bucket();
    const file = bucket.file(fileName);

    if (isEmulator) {
      return this.getEmulatorDownloadUrl(bucket.name, fileName, file);
    }

    const [signedUrl] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    return signedUrl;
  }

  /**
   * Generate signed URLs for video and thumbnail
   * Used to generate fresh URLs on-the-fly for API responses
   */
  static async getVideoSignedUrls(
    userId: string,
    videoId: string
  ): Promise<{videoUrl: string; thumbnailUrl: string}> {
    const bucket = storage.bucket();
    const videoPath = `users/${userId}/videos/${videoId}/video.mp4`;
    const thumbnailPath = `users/${userId}/videos/${videoId}/thumbnail.jpg`;
    const videoFile = bucket.file(videoPath);
    const thumbnailFile = bucket.file(thumbnailPath);

    if (isEmulator) {
      const [videoUrl, thumbnailUrl] = await Promise.all([
        this.getEmulatorDownloadUrl(bucket.name, videoPath, videoFile),
        this.getEmulatorDownloadUrl(bucket.name, thumbnailPath, thumbnailFile),
      ]);
      return {videoUrl, thumbnailUrl};
    }

    const [[videoSignedUrl], [thumbSignedUrl]] = await Promise.all([
      videoFile.getSignedUrl({
        action: "read",
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
      }),
      thumbnailFile.getSignedUrl({
        action: "read",
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
      }),
    ]);

    return {videoUrl: videoSignedUrl, thumbnailUrl: thumbSignedUrl};
  }

  /**
   * Delete image from storage
   */
  static async deleteImage(userId: string, imageId: string): Promise<void> {
    const fileName = `users/${userId}/images/${imageId}.jpg`;
    const bucket = storage.bucket();
    const file = bucket.file(fileName);

    await file.delete();
  }

  /**
   * Download image buffer (for AI analysis)
   */
  static async downloadImage(userId: string, imageId: string): Promise<Buffer> {
    const fileName = `users/${userId}/images/${imageId}.jpg`;
    const bucket = storage.bucket();
    const file = bucket.file(fileName);

    const [buffer] = await file.download();
    return buffer;
  }

  /**
   * Download video thumbnail buffer
   */
  static async downloadVideoThumbnail(
    userId: string,
    videoId: string
  ): Promise<Buffer> {
    const fileName = `users/${userId}/videos/${videoId}/thumbnail.jpg`;
    const bucket = storage.bucket();
    const file = bucket.file(fileName);

    const [buffer] = await file.download();
    return buffer;
  }

  /**
   * Upload a fixed image to Cloud Storage
   */
  static async uploadFixedImage(options: {
    userId: string;
    fixId: string;
    imageBuffer: Buffer;
  }): Promise<{storagePath: string}> {
    const {userId, fixId, imageBuffer} = options;

    // Optimize the generated image
    const optimizedBuffer = await this.optimizeImage(imageBuffer);

    // Define storage path: users/{userId}/fixes/{fixId}.jpg
    const fileName = `users/${userId}/fixes/${fixId}.jpg`;
    const bucket = storage.bucket();
    const file = bucket.file(fileName);

    const downloadToken = await this.createDownloadToken();

    // Upload to Cloud Storage
    await file.save(optimizedBuffer, {
      metadata: {
        contentType: "image/jpeg",
        metadata: {
          userId,
          fixId,
          generatedAt: new Date().toISOString(),
          ...(downloadToken
            ? {firebaseStorageDownloadTokens: downloadToken}
            : {}),
        },
      },
      public: false,
    });

    // Return only storage path, not expired signed URLs
    return {
      storagePath: fileName,
    };
  }

  /**
   * Delete a fixed image from storage
   */
  static async deleteFixedImage(userId: string, fixId: string): Promise<void> {
    const fileName = `users/${userId}/fixes/${fixId}.jpg`;
    const bucket = storage.bucket();
    const file = bucket.file(fileName);

    await file.delete();
  }

  /**
   * Generate new signed URL for a fixed image
   */
  static async getFixedImageSignedUrl(
    userId: string,
    fixId: string
  ): Promise<string> {
    const fileName = `users/${userId}/fixes/${fixId}.jpg`;
    const bucket = storage.bucket();
    const file = bucket.file(fileName);

    if (isEmulator) {
      return this.getEmulatorDownloadUrl(bucket.name, fileName, file);
    }

    const [signedUrl] = await file.getSignedUrl({
      action: "read",
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    return signedUrl;
  }

  /**
   * Create a download token for emulator-only flows
   */
  private static async createDownloadToken(): Promise<string | undefined> {
    if (!isEmulator) return undefined;
    const {v4: uuidv4} = await import("uuid");
    return uuidv4();
  }

  /**
   * Build emulator download URL using stored firebaseStorageDownloadTokens
   */
  private static async getEmulatorDownloadUrl(
    bucketName: string,
    filePath: string,
    file: File
  ): Promise<string> {
    const [meta] = await file.getMetadata();
    const rawToken = meta.metadata?.firebaseStorageDownloadTokens;
    const token = typeof rawToken === "string" ? rawToken : undefined;
    return getEmulatorStorageUrl(bucketName, filePath, token);
  }

  // ============================================================================
  // Video Fix Storage Methods
  // ============================================================================

  /**
   * Download a video file from storage
   */
  static async downloadVideo(userId: string, videoId: string): Promise<Buffer> {
    const fileName = `users/${userId}/videos/${videoId}/video.mp4`;
    const bucket = storage.bucket();
    const file = bucket.file(fileName);

    const [buffer] = await file.download();
    return buffer;
  }

  /**
   * Download a specific video frame from Cloud Storage
   */
  static async downloadVideoFrame(
    userId: string,
    videoId: string,
    frameIndex: number
  ): Promise<Buffer> {
    const paddedIndex = frameIndex.toString().padStart(3, "0");
    const fileName = `users/${userId}/videos/${videoId}/frames/frame_${paddedIndex}.jpg`;
    const bucket = storage.bucket();
    const file = bucket.file(fileName);

    const [buffer] = await file.download();
    return buffer;
  }

  /**
   * Upload a fixed video to Cloud Storage
   */
  static async uploadFixedVideo(options: {
    userId: string;
    fixId: string;
    videoBuffer: Buffer;
    thumbnailBuffer: Buffer;
  }): Promise<{
    videoUrl: string;
    videoStorageUrl: string;
    thumbnailUrl: string;
  }> {
    const {userId, fixId, videoBuffer, thumbnailBuffer} = options;
    const bucket = storage.bucket();

    // Upload video
    const videoFileName = `users/${userId}/video-fixes/${fixId}/video.mp4`;
    const videoFile = bucket.file(videoFileName);
    const videoDownloadToken = await this.createDownloadToken();

    await videoFile.save(videoBuffer, {
      metadata: {
        contentType: "video/mp4",
        metadata: {
          userId,
          fixId,
          generatedAt: new Date().toISOString(),
          ...(videoDownloadToken
            ? {firebaseStorageDownloadTokens: videoDownloadToken}
            : {}),
        },
      },
      public: false,
    });

    // Upload thumbnail
    const thumbnailFileName = `users/${userId}/video-fixes/${fixId}/thumbnail.jpg`;
    const thumbnailFile = bucket.file(thumbnailFileName);
    const thumbnailDownloadToken = await this.createDownloadToken();

    // Optimize thumbnail
    const optimizedThumbnail = await this.optimizeImage(thumbnailBuffer);

    await thumbnailFile.save(optimizedThumbnail, {
      metadata: {
        contentType: "image/jpeg",
        metadata: {
          userId,
          fixId,
          generatedAt: new Date().toISOString(),
          ...(thumbnailDownloadToken
            ? {firebaseStorageDownloadTokens: thumbnailDownloadToken}
            : {}),
        },
      },
      public: false,
    });

    // Generate URLs
    let videoUrl: string;
    let thumbnailUrl: string;

    if (isEmulator) {
      videoUrl = getEmulatorStorageUrl(
        bucket.name,
        videoFileName,
        videoDownloadToken
      );
      thumbnailUrl = getEmulatorStorageUrl(
        bucket.name,
        thumbnailFileName,
        thumbnailDownloadToken
      );
    } else {
      const [signedVideoUrl] = await videoFile.getSignedUrl({
        action: "read",
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });
      const [signedThumbnailUrl] = await thumbnailFile.getSignedUrl({
        action: "read",
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });
      videoUrl = signedVideoUrl;
      thumbnailUrl = signedThumbnailUrl;
    }

    return {
      videoUrl,
      videoStorageUrl: `gs://${bucket.name}/${videoFileName}`,
      thumbnailUrl,
    };
  }

  /**
   * Delete a fixed video and its thumbnail from storage
   */
  static async deleteFixedVideo(userId: string, fixId: string): Promise<void> {
    const bucket = storage.bucket();

    const videoFile = bucket.file(
      `users/${userId}/video-fixes/${fixId}/video.mp4`
    );
    const thumbnailFile = bucket.file(
      `users/${userId}/video-fixes/${fixId}/thumbnail.jpg`
    );

    await Promise.all([
      videoFile.delete().catch(() => {}),
      thumbnailFile.delete().catch(() => {}),
    ]);
  }

  /**
   * Generate new signed URLs for a fixed video and thumbnail
   */
  static async getFixedVideoSignedUrls(
    userId: string,
    fixId: string
  ): Promise<{videoUrl: string; thumbnailUrl: string}> {
    const bucket = storage.bucket();
    const videoFileName = `users/${userId}/video-fixes/${fixId}/video.mp4`;
    const thumbnailFileName = `users/${userId}/video-fixes/${fixId}/thumbnail.jpg`;
    const videoFile = bucket.file(videoFileName);
    const thumbnailFile = bucket.file(thumbnailFileName);

    if (isEmulator) {
      const [videoUrl, thumbnailUrl] = await Promise.all([
        this.getEmulatorDownloadUrl(bucket.name, videoFileName, videoFile),
        this.getEmulatorDownloadUrl(
          bucket.name,
          thumbnailFileName,
          thumbnailFile
        ),
      ]);
      return {videoUrl, thumbnailUrl};
    }

    const [[signedVideoUrl], [signedThumbnailUrl]] = await Promise.all([
      videoFile.getSignedUrl({
        action: "read",
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
      }),
      thumbnailFile.getSignedUrl({
        action: "read",
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
      }),
    ]);

    return {videoUrl: signedVideoUrl, thumbnailUrl: signedThumbnailUrl};
  }
}
