/**
 * Pub/Sub Configuration
 * Topic and subscription configuration for async video processing
 */

import {PubSub} from "@google-cloud/pubsub";

// Pub/Sub topic names
export const PUBSUB_TOPICS = {
  VIDEO_ANALYSIS_QUEUE: "video-analysis-queue",
} as const;

// Singleton Pub/Sub client
let pubsubClient: PubSub | null = null;

/**
 * Get the Pub/Sub client singleton
 */
export function getPubSubClient(): PubSub {
  if (!pubsubClient) {
    pubsubClient = new PubSub();
  }
  return pubsubClient;
}

/**
 * Publish a message to a topic
 */
export async function publishMessage<T extends object>(
  topicName: string,
  data: T
): Promise<string> {
  const client = getPubSubClient();
  const topic = client.topic(topicName);

  const messageBuffer = Buffer.from(JSON.stringify(data));
  const messageId = await topic.publishMessage({data: messageBuffer});

  return messageId;
}

/**
 * Publish a video analysis job to the queue
 */
export async function publishVideoAnalysisJob(
  videoId: string,
  userId: string
): Promise<string> {
  return publishMessage(PUBSUB_TOPICS.VIDEO_ANALYSIS_QUEUE, {
    videoId,
    userId,
  });
}
