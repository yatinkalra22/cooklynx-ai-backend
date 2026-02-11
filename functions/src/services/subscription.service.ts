import {database} from "../config/firebase.config";
import * as logger from "firebase-functions/logger";
import {
  SubscriptionPlan,
  UserSubscription,
  RevenueCatWebhookEvent,
  PLAN_CONFIG,
  SubscriptionInfoResponse,
} from "../types/subscription.types";
import {FREE_CREDIT_LIMIT} from "../config/constants";

const REVENUECAT_API_BASE = "https://api.revenuecat.com/v1";

/**
 * Map RevenueCat entitlement IDs to our subscription plans.
 * Highest tier wins when multiple entitlements are active.
 * Includes both normalized IDs and dashboard display names.
 */
const ENTITLEMENT_TO_PLAN: Record<string, SubscriptionPlan> = {
  pro_max: "pro_max",
  pro: "pro",
  starter: "starter",
  // Dashboard display names (RevenueCat returns these as-is)
  "CookLynx AI Pro Max": "pro_max",
  "CookLynx AI Pro": "pro",
  "CookLynx AI Starter": "starter",
};

/**
 * Map RevenueCat product IDs to our subscription plans.
 * Used as fallback when entitlement IDs don't match.
 */
const PRODUCT_TO_PLAN: Record<string, SubscriptionPlan> = {
  cooklynx_pro_max_monthly: "pro_max",
  cooklynx_pro_monthly: "pro",
  cooklynx_starter_monthly: "starter",
};

const PLAN_PRIORITY: Record<SubscriptionPlan, number> = {
  free: 0,
  starter: 1,
  pro: 2,
  pro_max: 3,
};

function getDefaultSubscription(): UserSubscription {
  return {
    plan: "free",
    status: "active",
    entitlementId: null,
    productId: null,
    store: null,
    expiresAt: null,
    periodStartAt: null,
    creditLimit: FREE_CREDIT_LIMIT,
    creditsUsedThisPeriod: 0,
    lastSyncedAt: new Date().toISOString(),
    originalPurchaseDate: null,
  };
}

export class SubscriptionService {
  /**
   * Fetch subscriber info from RevenueCat REST API.
   * Returns null if the API key is not configured.
   */
  static async getSubscriberInfo(
    userId: string
  ): Promise<Record<string, unknown> | null> {
    const apiKey = process.env.REVENUECAT_SECRET_API_KEY;
    if (!apiKey) {
      logger.warn("subscription:getSubscriberInfo — REVENUECAT_SECRET_API_KEY not set");
      return null;
    }

    const url = `${REVENUECAT_API_BASE}/subscribers/${encodeURIComponent(userId)}`;
    logger.info("subscription:getSubscriberInfo — calling RevenueCat", {
      userId,
      url,
      apiKeyPrefix: apiKey.substring(0, 6) + "...",
    });

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      logger.error("subscription:getSubscriberInfo — API error", {
        status: response.status,
        userId,
        body,
      });
      if (response.status === 404) {
        // User not found in RevenueCat — treat as free
        return null;
      }
      throw new Error(`RevenueCat API error: ${response.status} — ${body}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    logger.info("subscription:getSubscriberInfo — response received", {
      userId,
      hasSubscriber: !!(data as {subscriber?: unknown}).subscriber,
    });
    return data;
  }

  /**
   * Sync subscription state from RevenueCat → RTDB.
   * Reads entitlements, determines the active plan, and updates the local node.
   */
  static async syncSubscription(userId: string): Promise<{
    subscription: UserSubscription;
    debug: {
      revenuecatUserId: string;
      revenuecatStatus: string;
      entitlementsFound: string[];
      activeEntitlements: string[];
      resolvedPlan: string;
    };
  }> {
    const subscriberData = await this.getSubscriberInfo(userId);

    if (!subscriberData) {
      // No RevenueCat data — ensure free defaults are stored
      const sub = getDefaultSubscription();
      await database.ref(`users/${userId}/subscription`).set(sub);
      return {
        subscription: sub,
        debug: {
          revenuecatUserId: userId,
          revenuecatStatus: "no_data_returned",
          entitlementsFound: [],
          activeEntitlements: [],
          resolvedPlan: "free",
        },
      };
    }

    const subscriber = (
      subscriberData as {subscriber?: Record<string, unknown>}
    ).subscriber;
    if (!subscriber) {
      logger.warn("subscription:sync — no subscriber object in response", {userId});
      const sub = getDefaultSubscription();
      await database.ref(`users/${userId}/subscription`).set(sub);
      return {
        subscription: sub,
        debug: {
          revenuecatUserId: userId,
          revenuecatStatus: "no_subscriber_object",
          entitlementsFound: [],
          activeEntitlements: [],
          resolvedPlan: "free",
        },
      };
    }

    // RevenueCat REST API entitlement shape (note: is_active is NOT in REST API)
    interface RCEntitlement {
      expires_date: string | null;
      grace_period_expires_date: string | null;
      purchase_date: string;
      product_identifier: string;
      store: string;
    }

    const entitlements =
      (subscriber.entitlements as Record<string, RCEntitlement>) || {};

    const entitlementsFound = Object.keys(entitlements);
    const activeEntitlements: string[] = [];

    logger.info("subscription:sync — RevenueCat entitlements", {
      userId,
      entitlementsFound,
      entitlements: JSON.stringify(entitlements),
    });

    let bestPlan: SubscriptionPlan = "free";
    let bestEntitlementId: string | null = null;
    let bestProductId: string | null = null;
    let bestStore: string | null = null;
    let bestExpiresAt: string | null = null;
    let bestPurchaseDate: string | null = null;

    const now = Date.now();

    for (const [entId, entData] of Object.entries(entitlements)) {
      // Determine if active: check grace period first, then expires_date
      // null expires_date = lifetime/non-expiring entitlement (always active)
      const effectiveExpiry = entData.grace_period_expires_date || entData.expires_date;
      if (effectiveExpiry) {
        const expiresMs = new Date(effectiveExpiry).getTime();
        if (expiresMs < now) {
          logger.info("subscription:sync — skipping expired entitlement", {
            entId,
            productId: entData.product_identifier,
            expiresAt: effectiveExpiry,
          });
          continue;
        }
      }

      activeEntitlements.push(`${entId}(${entData.product_identifier})`);

      // Try mapping by entitlement ID first, then by product ID
      let plan = ENTITLEMENT_TO_PLAN[entId];
      if (!plan && entData.product_identifier) {
        plan = PRODUCT_TO_PLAN[entData.product_identifier];
      }

      if (!plan) {
        logger.warn("subscription:sync — unknown entitlement/product", {
          entId,
          productId: entData.product_identifier,
        });
        continue;
      }

      if (PLAN_PRIORITY[plan] > PLAN_PRIORITY[bestPlan]) {
        bestPlan = plan;
        bestEntitlementId = entId;
        bestProductId = entData.product_identifier || null;
        bestStore = entData.store || null;
        bestExpiresAt = entData.expires_date || null;
        bestPurchaseDate = entData.purchase_date || null;
      }
    }

    logger.info("subscription:sync — resolved plan", {
      userId,
      bestPlan,
      bestEntitlementId,
      bestProductId,
    });

    const planConfig = PLAN_CONFIG[bestPlan];

    // Read existing subscription to check for plan change
    const existingSnapshot = await database
      .ref(`users/${userId}/subscription`)
      .get();
    const existing = existingSnapshot.val() as UserSubscription | null;
    const planChanged = !existing || existing.plan !== bestPlan;

    // No rollover: reset credits to 0 when plan changes, otherwise preserve
    const creditsUsedThisPeriod = planChanged
      ? 0
      : (existing?.creditsUsedThisPeriod ?? 0);

    if (planChanged) {
      logger.info("subscription:sync — plan changed, resetting credits", {
        userId,
        oldPlan: existing?.plan ?? "none",
        newPlan: bestPlan,
        newCreditLimit: planConfig.creditLimit,
      });
      // Reset top-level credit counter
      await database.ref(`users/${userId}/credit`).set(0);
    }

    const sub: UserSubscription = {
      plan: bestPlan,
      status: "active",
      entitlementId: bestEntitlementId,
      productId: bestProductId,
      store: (bestStore as UserSubscription["store"]) || null,
      expiresAt: bestExpiresAt,
      periodStartAt: bestPurchaseDate,
      creditLimit: planConfig.creditLimit,
      creditsUsedThisPeriod,
      lastSyncedAt: new Date().toISOString(),
      originalPurchaseDate: bestPurchaseDate,
    };

    await database.ref(`users/${userId}/subscription`).set(sub);

    // Also update top-level creditLimit for atomic credit reservation
    await database.ref(`users/${userId}/creditLimit`).set(planConfig.creditLimit);

    return {
      subscription: sub,
      debug: {
        revenuecatUserId: userId,
        revenuecatStatus: "ok",
        entitlementsFound,
        activeEntitlements,
        resolvedPlan: bestPlan,
      },
    };
  }

  /**
   * Fast-path: read subscription from RTDB (no API call).
   * Returns free defaults if no subscription node exists.
   */
  static async getUserPlan(userId: string): Promise<UserSubscription> {
    const snapshot = await database
      .ref(`users/${userId}/subscription`)
      .get();

    if (snapshot.exists()) {
      return snapshot.val() as UserSubscription;
    }

    return getDefaultSubscription();
  }

  /**
   * Build the API response for current subscription status.
   * Reads actual credit usage from the top-level `credit` field
   * (the source of truth incremented by reserveCredits).
   */
  static async getSubscriptionInfo(
    userId: string
  ): Promise<SubscriptionInfoResponse> {
    const sub = await this.getUserPlan(userId);

    // Read actual credit usage from top-level field (source of truth)
    const creditSnapshot = await database
      .ref(`users/${userId}/credit`)
      .get();
    const creditsUsed = creditSnapshot.exists()
      ? (creditSnapshot.val() as number)
      : 0;

    const creditsRemaining = Math.max(0, sub.creditLimit - creditsUsed);

    // willRenew: true for active paid plans that haven't been cancelled
    const willRenew =
      sub.plan !== "free" &&
      sub.status === "active";

    return {
      plan: sub.plan,
      status: sub.status,
      creditsUsed,
      creditsLimit: sub.creditLimit,
      creditsRemaining,
      currentPeriodEnd: sub.expiresAt,
      willRenew,
    };
  }

  /**
   * Reset monthly credits to 0 on subscription renewal.
   */
  static async resetMonthlyCredits(userId: string): Promise<void> {
    await database.ref(`users/${userId}/subscription/creditsUsedThisPeriod`).set(0);
    await database.ref(`users/${userId}/credit`).set(0);

    // Log to credit ledger
    await database.ref(`users/${userId}/creditLedger`).push({
      type: "subscription_credit_reset",
      amount: 0,
      resourceId: "subscription-renewal",
      timestamp: new Date().toISOString(),
      creditAfter: 0,
    }).catch(() => {});
  }

  /**
   * Get the effective credit limit for a user based on their subscription.
   * Replaces the old hardcoded BETA_USAGE_LIMIT.
   */
  static async getEffectiveCreditLimit(userId: string): Promise<number> {
    const sub = await this.getUserPlan(userId);
    return sub.creditLimit;
  }

  /**
   * Process a RevenueCat webhook event.
   * Idempotent — stores event IDs to skip duplicates.
   */
  static async handleWebhookEvent(
    payload: RevenueCatWebhookEvent
  ): Promise<void> {
    const event = payload.event;
    const eventId = event.id;
    const userId = event.app_user_id;

    // Idempotency check
    const existingEvent = await database
      .ref(`webhookEvents/${eventId}`)
      .get();

    if (existingEvent.exists()) {
      logger.info("subscription:webhook — duplicate event skipped", {eventId});
      return;
    }

    // Mark event as processed
    await database.ref(`webhookEvents/${eventId}`).set({
      type: event.type,
      userId,
      processedAt: new Date().toISOString(),
    });

    logger.info("subscription:webhook — processing", {
      eventId,
      type: event.type,
      userId,
    });

    switch (event.type) {
    case "TEST":
      logger.info("subscription:webhook — TEST event received");
      break;

    case "INITIAL_PURCHASE":
    case "RENEWAL":
      await this.syncSubscription(userId);
      await this.resetMonthlyCredits(userId);
      break;

    case "CANCELLATION":
    case "EXPIRATION":
      await this.downgradeToFree(userId);
      break;

    case "BILLING_ISSUE":
      await this.markBillingIssue(userId);
      break;

    case "PRODUCT_CHANGE":
      await this.syncSubscription(userId);
      break;

    case "UNCANCELLATION":
      await this.syncSubscription(userId);
      break;

    case "SUBSCRIPTION_PAUSED":
      await database
        .ref(`users/${userId}/subscription/status`)
        .set("paused");
      break;

    default:
      logger.warn("subscription:webhook — unhandled event type", {
        type: event.type,
      });
    }
  }

  /**
   * Downgrade user to free plan.
   */
  private static async downgradeToFree(userId: string): Promise<void> {
    const sub = getDefaultSubscription();
    sub.status = "expired";
    await database.ref(`users/${userId}/subscription`).set(sub);
    await database.ref(`users/${userId}/creditLimit`).set(FREE_CREDIT_LIMIT);
  }

  /**
   * Mark a billing issue — keep current access during grace period.
   */
  private static async markBillingIssue(userId: string): Promise<void> {
    await database
      .ref(`users/${userId}/subscription/status`)
      .set("billing_issue");
  }
}
