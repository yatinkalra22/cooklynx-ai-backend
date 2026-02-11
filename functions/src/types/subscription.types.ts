/**
 * Subscription Types — RevenueCat integration
 */

// ============================================================================
// Enums & Constants
// ============================================================================

export type SubscriptionPlan = "free" | "starter" | "pro" | "pro_max";

export type SubscriptionStatus =
  | "active"
  | "expired"
  | "billing_issue"
  | "paused"
  | "cancelled";

export type SubscriptionStore =
  | "APP_STORE"
  | "PLAY_STORE"
  | "STRIPE"
  | "RC_BILLING"
  | null;

// ============================================================================
// Plan Configuration
// ============================================================================

export interface PlanConfig {
  creditLimit: number;
  price: string;
  name: string;
  entitlementId: string | null;
}

export const PLAN_CONFIG: Record<SubscriptionPlan, PlanConfig> = {
  free: {
    creditLimit: 5,
    price: "$0",
    name: "Free",
    entitlementId: null,
  },
  starter: {
    creditLimit: 20,
    price: "$4.99/mo",
    name: "Starter",
    entitlementId: "starter",
  },
  pro: {
    creditLimit: 50,
    price: "$9.99/mo",
    name: "Pro",
    entitlementId: "pro",
  },
  pro_max: {
    creditLimit: 500,
    price: "$19.99/mo",
    name: "Pro Max",
    entitlementId: "pro_max",
  },
};

// ============================================================================
// User Subscription (stored in RTDB)
// ============================================================================

export interface UserSubscription {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  entitlementId: string | null;
  productId: string | null;
  store: SubscriptionStore;
  expiresAt: string | null;
  periodStartAt: string | null;
  creditLimit: number;
  creditsUsedThisPeriod: number;
  lastSyncedAt: string;
  originalPurchaseDate: string | null;
}

// ============================================================================
// RevenueCat Webhook
// ============================================================================

export type RevenueCatWebhookEventType =
  | "TEST"
  | "INITIAL_PURCHASE"
  | "RENEWAL"
  | "CANCELLATION"
  | "UNCANCELLATION"
  | "NON_RENEWING_PURCHASE"
  | "SUBSCRIPTION_PAUSED"
  | "SUBSCRIPTION_EXTENDED"
  | "BILLING_ISSUE"
  | "PRODUCT_CHANGE"
  | "EXPIRATION"
  | "TRANSFER";

export interface RevenueCatWebhookEvent {
  api_version: string;
  event: {
    id: string;
    type: RevenueCatWebhookEventType;
    app_user_id: string;
    original_app_user_id: string;
    product_id: string;
    entitlement_ids: string[] | null;
    period_type: "NORMAL" | "TRIAL" | "INTRO";
    purchased_at_ms: number;
    expiration_at_ms: number | null;
    store: string;
    environment: "SANDBOX" | "PRODUCTION";
    is_family_share: boolean;
    country_code: string;
    currency: string;
    price_in_purchased_currency: number;
    subscriber_attributes?: Record<
      string,
      {value: string; updated_at_ms: number}
    >;
    transaction_id: string;
    original_transaction_id: string;
    /** Present for PRODUCT_CHANGE events */
    new_product_id?: string;
  };
}

// ============================================================================
// API Responses
// ============================================================================

export interface SubscriptionInfoResponse {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  creditsUsed: number;
  creditsLimit: number;
  creditsRemaining: number;
  currentPeriodEnd: string | null;
  willRenew: boolean;
}

export interface PlanInfoResponse {
  plan: SubscriptionPlan;
  name: string;
  price: string;
  creditLimit: number;
  entitlementId: string | null;
}

export interface PlansListResponse {
  plans: PlanInfoResponse[];
}

export interface SyncResponse {
  message: string;
  subscription: SubscriptionInfoResponse;
  /** Debug info — only present in non-production environments */
  debug?: {
    revenuecatUserId: string;
    revenuecatStatus: string;
    entitlementsFound: string[];
    activeEntitlements: string[];
    resolvedPlan: string;
  };
}
