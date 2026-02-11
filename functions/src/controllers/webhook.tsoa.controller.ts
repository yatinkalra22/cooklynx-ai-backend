import {
  Controller,
  Post,
  Body,
  Request,
  Response,
  Route,
  Tags,
  Hidden,
} from "tsoa";
import {Request as ExpressRequest} from "express";
import {SubscriptionService} from "../services/subscription.service";
import {RevenueCatWebhookEvent} from "../types/subscription.types";
import {ErrorResponse} from "../types/api.types";
import * as logger from "firebase-functions/logger";

@Route("v1/webhooks")
@Tags("Webhooks")
export class WebhookController extends Controller {
  /**
   * Receive webhook events from RevenueCat.
   * Validates the authorization header and processes events idempotently.
   * @summary RevenueCat webhook handler
   */
  @Post("revenuecat")
  @Hidden()
  @Response<ErrorResponse>(401, "Unauthorized - invalid webhook secret")
  @Response<ErrorResponse>(500, "Internal server error")
  public async handleRevenueCatWebhook(
    @Request() request: ExpressRequest,
    @Body() body: RevenueCatWebhookEvent
  ): Promise<{status: string}> {
    // Validate webhook authorization
    const webhookSecret = process.env.REVENUECAT_WEBHOOK_SECRET;
    const authHeader = request.headers.authorization;

    if (webhookSecret) {
      if (!authHeader || authHeader !== `Bearer ${webhookSecret}`) {
        this.setStatus(401);
        throw {
          error: "Unauthorized",
          message: "Invalid webhook authorization",
        };
      }
    }

    // Return 200 immediately
    this.setStatus(200);

    // Process async (fire-and-forget)
    SubscriptionService.handleWebhookEvent(body).catch((error) => {
      logger.error("webhook:revenuecat — processing failed", {
        eventId: body?.event?.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return {status: "ok"};
  }
}
