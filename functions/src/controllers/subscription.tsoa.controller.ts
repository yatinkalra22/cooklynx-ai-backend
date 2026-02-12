import {
  Controller,
  Get,
  Post,
  Request,
  Response,
  Route,
  Security,
  Tags,
} from "tsoa";
import {Request as ExpressRequest} from "express";
import {SubscriptionService} from "../services/subscription.service";
import {AuthUser} from "../middleware/tsoa-auth.middleware";
import {
  SubscriptionInfoResponse,
  PlansListResponse,
  SyncResponse,
  PLAN_CONFIG,
  PlanInfoResponse,
  SubscriptionPlan,
} from "../types/subscription.types";
import {ErrorResponse} from "../types/api.types";
import * as logger from "firebase-functions/logger";

@Route("v1/subscription")
@Tags("Subscription")
export class SubscriptionController extends Controller {
  /**
   * Get the current user's subscription info including plan, status, and credit usage.
   * @summary Get current subscription
   */
  @Get()
  @Security("BearerAuth")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(500, "Internal server error")
  public async getSubscription(
    @Request() request: ExpressRequest
  ): Promise<SubscriptionInfoResponse> {
    const user = request.user as AuthUser;

    try {
      return await SubscriptionService.getSubscriptionInfo(user.uid);
    } catch {
      this.setStatus(500);
      throw {
        error: "Internal Server Error",
        message: "Failed to get subscription info",
      };
    }
  }

  /**
   * Force-sync the user's subscription from RevenueCat.
   * Call this after a purchase to ensure the backend reflects the latest state.
   * @summary Sync subscription from RevenueCat
   */
  @Post("sync")
  @Security("BearerAuth")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(500, "Internal server error")
  public async syncSubscription(
    @Request() request: ExpressRequest
  ): Promise<SyncResponse> {
    const user = request.user as AuthUser;

    try {
      logger.info("subscription:sync:start", {userId: user.uid});
      const result = await SubscriptionService.syncSubscription(user.uid);
      const info = await SubscriptionService.getSubscriptionInfo(user.uid);
      logger.info("subscription:sync:result", {
        userId: user.uid,
        plan: info.plan,
      });

      return {
        message: "Subscription synced successfully",
        subscription: info,
        debug: result.debug,
      };
    } catch (error) {
      logger.error("subscription:sync:error", {
        userId: user.uid,
        error: error instanceof Error ? error.message : String(error),
      });
      this.setStatus(500);
      throw {
        error: "Internal Server Error",
        message: "Failed to sync subscription",
      };
    }
  }

  /**
   * List all available subscription plans and pricing.
   * This endpoint does not require authentication.
   * @summary List available plans
   */
  @Get("plans")
  public async getPlans(): Promise<PlansListResponse> {
    const plans: PlanInfoResponse[] = (
      Object.keys(PLAN_CONFIG) as SubscriptionPlan[]
    ).map((plan) => {
      const config = PLAN_CONFIG[plan];
      return {
        plan,
        name: config.name,
        price: config.price,
        creditLimit: config.creditLimit,
        entitlementId: config.entitlementId,
      };
    });

    return {plans};
  }
}
