# Frontend RevenueCat Integration Guide

This guide covers how to integrate RevenueCat into the CookLynx AI mobile app
for subscription management and paywalls.

---

## 1. SDK Setup

Install as per expo docs

---

## 2. Initialize SDK

Configure RevenueCat with your **public** API key (not the secret key used by
the backend).

```typescript
// React Native example
import Purchases from "react-native-purchases";

// Call once at app startup (e.g., App.tsx)
Purchases.configure({
  apiKey: "<REVENUECAT_PUBLIC_API_KEY>",
  // Do NOT set appUserID here - we set it after Firebase auth
});
```

---

## 3. Login / Logout

After Firebase authentication, identify the user to RevenueCat using their
Firebase UID. This links their purchases to the same user ID the backend uses.

### After Firebase Auth (login or signup)

```typescript
import Purchases from "react-native-purchases";

// After successful Firebase auth
const firebaseUser = auth().currentUser;
if (firebaseUser) {
  await Purchases.logIn(firebaseUser.uid);
}
```

### On Logout

```typescript
await Purchases.logOut();
```

---

## 4. Displaying Paywalls

### Option A: RevenueCat Paywall UI (Recommended)

RevenueCat offers pre-built paywall templates that can be configured from the
dashboard.

```typescript
import RevenueCatUI from "react-native-purchases-ui";

// Present the paywall
await RevenueCatUI.presentPaywall();

// Or present paywall only if user doesn't have an entitlement
await RevenueCatUI.presentPaywallIfNeeded({
  requiredEntitlementIdentifier: "pro",
});
```

### Option B: Custom Paywall

```typescript
// Fetch available packages
const offerings = await Purchases.getOfferings();
const currentOffering = offerings.current;

if (currentOffering) {
  // Display packages to user
  for (const pkg of currentOffering.availablePackages) {
    console.log(pkg.identifier); // e.g., "$rc_monthly"
    console.log(pkg.product.title); // e.g., "Pro Plan"
    console.log(pkg.product.priceString); // e.g., "$9.99"
  }
}
```

---

## 5. Purchase Flow

The SDK handles all store communication (App Store / Google Play).

```typescript
try {
  const {customerInfo} = await Purchases.purchasePackage(selectedPackage);

  // Check if entitlement is now active
  if (customerInfo.entitlements.active["pro"]) {
    // User now has pro access
    // Sync with backend
    await fetch("/v1/subscription/sync", {
      method: "POST",
      headers: {Authorization: `Bearer ${firebaseToken}`},
    });
  }
} catch (error) {
  if (error.userCancelled) {
    // User cancelled - no action needed
  } else {
    // Handle error
    console.error("Purchase failed:", error);
  }
}
```

---

## 6. Listening to Subscription Changes

```typescript
Purchases.addCustomerInfoUpdateListener((customerInfo) => {
  // Check active entitlements
  const activeEntitlements = customerInfo.entitlements.active;

  if (activeEntitlements["pro_max"]) {
    // Pro Max plan
  } else if (activeEntitlements["pro"]) {
    // Pro plan
  } else if (activeEntitlements["starter"]) {
    // Starter plan
  } else {
    // Free plan
  }

  // Optionally sync with backend
  syncSubscription();
});
```

---

## 7. Backend API Endpoints

### Get Current Subscription

```
GET /v1/subscription
Authorization: Bearer <firebase_id_token>
```

Response:

```json
{
  "plan": "pro",
  "status": "active",
  "creditLimit": 50,
  "creditsUsed": 12,
  "creditsRemaining": 38,
  "expiresAt": "2025-07-15T00:00:00Z",
  "store": "APP_STORE"
}
```

### Force Sync (after purchase)

```
POST /v1/subscription/sync
Authorization: Bearer <firebase_id_token>
```

Response:

```json
{
  "message": "Subscription synced successfully",
  "subscription": { ... }
}
```

### List Available Plans (no auth required)

```
GET /v1/subscription/plans
```

Response:

```json
{
  "plans": [
    {
      "plan": "free",
      "name": "Free",
      "price": "$0",
      "creditLimit": 5,
      "entitlementId": null
    },
    {
      "plan": "starter",
      "name": "Starter",
      "price": "$4.99/mo",
      "creditLimit": 20,
      "entitlementId": "starter"
    },
    {
      "plan": "pro",
      "name": "Pro",
      "price": "$9.99/mo",
      "creditLimit": 50,
      "entitlementId": "pro"
    },
    {
      "plan": "pro_max",
      "name": "Pro Max",
      "price": "$19.99/mo",
      "creditLimit": 500,
      "entitlementId": "pro_max"
    }
  ]
}
```

---

## 8. RevenueCat Dashboard Setup

### Products

Create these products in App Store Connect / Google Play Console, then add them
in RevenueCat:

| Product ID                 | Price     | Type           |
| -------------------------- | --------- | -------------- |
| `cooklynx_starter_monthly` | $4.99/mo  | Auto-Renewable |
| `cooklynx_pro_monthly`     | $9.99/mo  | Auto-Renewable |
| `cooklynx_pro_max_monthly` | $19.99/mo | Auto-Renewable |

### Entitlements

Create these entitlements in RevenueCat dashboard:

| Entitlement ID | Products                   |
| -------------- | -------------------------- |
| `starter`      | `cooklynx_starter_monthly` |
| `pro`          | `cooklynx_pro_monthly`     |
| `pro_max`      | `cooklynx_pro_max_monthly` |

### Offerings

Create a "default" offering with all three packages:

- Monthly Starter
- Monthly Pro
- Monthly Pro Max

### Webhook

Configure the webhook in RevenueCat dashboard:

- **URL**: `https://<your-cloud-function-url>/v1/webhooks/revenuecat`
- **Authorization header**: `Bearer <REVENUECAT_WEBHOOK_SECRET>`

---

## 9. Testing

### Sandbox Testing (iOS)

1. Create a Sandbox Apple ID in App Store Connect
2. Sign in with sandbox account on device (Settings > App Store > Sandbox
   Account)
3. Subscriptions auto-renew at accelerated rates (monthly = 5 minutes)

### Testing (Android)

1. Add test accounts in Google Play Console (Settings > License testing)
2. Use test card numbers for purchases
3. Subscriptions renew at accelerated rates

### Verify Integration

1. Purchase a subscription in sandbox
2. Call `GET /v1/subscription` - should reflect the new plan
3. Upload an image - should use subscription credit limit
4. Check RevenueCat dashboard for the transaction

---

## 10. Subscription Plans Summary

| Plan    | Price     | Credits/Month | Entitlement |
| ------- | --------- | ------------- | ----------- |
| Free    | $0        | 5             | (none)      |
| Starter | $4.99/mo  | 20            | `starter`   |
| Pro     | $9.99/mo  | 50            | `pro`       |
| Pro Max | $19.99/mo | 500           | `pro_max`   |

Credits reset monthly on subscription renewal.
