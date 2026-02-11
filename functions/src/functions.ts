import {onRequest} from "firebase-functions/v2/https";
import {onMessagePublished} from "firebase-functions/v2/pubsub";
import {defineSecret} from "firebase-functions/params";
import {app} from "./index";
import {VideoService} from "./services/video.service";
import {UrlRecipeService} from "./services/url-recipe.service";
import {PUBSUB_TOPICS} from "./config/pubsub.config";
import {VideoAnalysisMessage} from "./types/video.types";
import {UrlExtractionMessage} from "./types/recipe-url.types";
import * as logger from "firebase-functions/logger";

// Define secrets (sensitive data only)
const webApiKey = defineSecret("WEB_API_KEY");
const sentryDsn = defineSecret("SENTRY_DSN");
const revenueCatSecretApiKey = defineSecret("REVENUECAT_SECRET_API_KEY");

// Get region from environment variable or default to us-central1
const REGION = (process.env.CUSTOM_FUNCTION_REGION || "us-central1") as
  | "us-central1"
  | "us-east1"
  | "europe-west1";

// Export Cloud Function with configurable region and secrets
export const api = onRequest(
  {
    region: REGION,
    secrets: [webApiKey, sentryDsn, revenueCatSecretApiKey],
  },
  app
);

/**
 * Pub/Sub worker function for video analysis
 * Processes video analysis jobs from the video-analysis-queue topic
 */
export const videoAnalysisWorker = onMessagePublished(
  {
    topic: PUBSUB_TOPICS.VIDEO_ANALYSIS_QUEUE,
    region: REGION,
    memory: "2GiB",
    timeoutSeconds: 540, // 9 minutes for video processing
    maxInstances: 5,
  },
  async (event) => {
    const message = event.data.message;

    try {
      // Parse message data
      const data: VideoAnalysisMessage = message.json;
      const {videoId, userId} = data;

      logger.info("videoAnalysisWorker:received", {videoId, userId});

      // Process the video
      await VideoService.processVideo(videoId, userId);

      logger.info("videoAnalysisWorker:completed", {videoId, userId});
    } catch (error) {
      logger.error("videoAnalysisWorker:failed", {
        error: error instanceof Error ? error.message : String(error),
        messageId: message.messageId,
      });

      // Do not re-throw to prevent infinite Pub/Sub retries
      // We want to stop processing if it fails
    }
  }
);

/**
 * Pub/Sub worker function for URL recipe extraction
 * Processes URL extraction jobs from the url-recipe-extraction-queue topic
 */
export const urlRecipeExtractionWorker = onMessagePublished(
  {
    topic: PUBSUB_TOPICS.URL_RECIPE_EXTRACTION_QUEUE,
    region: REGION,
    memory: "1GiB",
    timeoutSeconds: 300, // 5 minutes for Gemini video analysis
    maxInstances: 10,
  },
  async (event) => {
    const message = event.data.message;

    try {
      const data: UrlExtractionMessage = message.json;

      logger.info("urlRecipeExtractionWorker:received", {
        urlId: data.urlId,
        userId: data.userId,
        platform: data.platform,
      });

      await UrlRecipeService.processExtraction(data);

      logger.info("urlRecipeExtractionWorker:completed", {
        urlId: data.urlId,
        userId: data.userId,
      });
    } catch (error) {
      logger.error("urlRecipeExtractionWorker:failed", {
        error: error instanceof Error ? error.message : String(error),
        messageId: message.messageId,
      });

      // Do not re-throw to prevent infinite Pub/Sub retries
    }
  }
);
