# Environment & Secrets Setup

This document explains how to configure environment variables for local
development and production deployment.

## GCP Services Required

Before deploying, ensure these Google Cloud services are enabled:

| Service           | Purpose                     | How to Enable                                      |
| ----------------- | --------------------------- | -------------------------------------------------- |
| Cloud Functions   | API hosting                 | Auto-enabled with Firebase                         |
| Cloud Storage     | File storage                | Auto-enabled with Firebase                         |
| Realtime Database | Metadata storage            | Auto-enabled with Firebase                         |
| Cloud Pub/Sub     | URL recipe extraction queue | Enable in GCP Console                              |
| Secret Manager    | Store API keys              | Auto-enabled with `firebase functions:secrets:set` |

### Enable Cloud Pub/Sub

```bash
# Using gcloud CLI
gcloud services enable pubsub.googleapis.com

# Or visit: https://console.cloud.google.com/apis/library/pubsub.googleapis.com
```

### Create Pub/Sub Topics

The URL recipe extraction feature requires a Pub/Sub topic:

```bash
gcloud pubsub topics create url-recipe-extraction
```

---

## Overview

| Variable                    | Local Dev   | Production           | Type   |
| --------------------------- | ----------- | -------------------- | ------ |
| `GEMINI_API_KEY`            | `.env` file | Firebase Secret      | Secret |
| `WEB_API_KEY`               | `.env` file | Firebase Secret      | Secret |
| `GOOGLE_CLIENT_ID`          | `.env` file | Environment variable | Config |
| `REVENUECAT_WEBHOOK_SECRET` | `.env` file | Firebase Secret      | Secret |
| `REVENUECAT_API_KEY`        | `.env` file | Firebase Secret      | Secret |
| `FIREBASE_PROJECT_ID`       | `.env` file | Auto-configured      | Config |
| `FIREBASE_DATABASE_URL`     | `.env` file | Auto-configured      | Config |
| `GCP_PROJECT_ID`            | `.env` file | Auto-configured      | Config |
| `GCP_REGION`                | `.env` file | `firebase.json`      | Config |
| `STORAGE_BUCKET`            | `.env` file | Auto-configured      | Config |
| `MAX_IMAGE_SIZE`            | `.env` file | Environment variable | Config |
| `ALLOWED_MIME_TYPES`        | `.env` file | Environment variable | Config |

---

## Local Development Setup

### 1. Create `functions/.env`

```bash
cd functions
cp .env.example .env
```

### 2. Edit `functions/.env`

```env
# Required for AI analysis
GEMINI_API_KEY=your-gemini-api-key

# Required for email/password authentication
WEB_API_KEY=your-firebase-web-api-key

# Required for Google Sign-In
GOOGLE_CLIENT_ID=your-google-client-id

# Optional - for subscription management
REVENUECAT_API_KEY=your-revenuecat-api-key
REVENUECAT_WEBHOOK_SECRET=your-webhook-secret

# Optional - override defaults
CUSTOM_FUNCTION_REGION=us-central1
MAX_IMAGE_SIZE=10485760
ALLOWED_MIME_TYPES=image/jpeg,image/png,image/webp
```

### 3. Get Required API Keys

#### Gemini API Key (for AI analysis)

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Click "Create API Key"
3. Copy the key to your `.env` file

#### Firebase Web API Key (for password verification)

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project → ⚙️ Settings → Project settings
3. Scroll to "Your apps" section
4. Copy the **Web API Key** to your `.env` file

#### Google Client ID (for Google Sign-In)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. APIs & Services → Credentials
3. Create OAuth 2.0 Client ID (Web application)
4. Copy the Client ID to your `.env` file

#### RevenueCat API Keys (for subscriptions)

1. Go to [RevenueCat Dashboard](https://app.revenuecat.com/)
2. Select your project
3. API Keys section → Copy "Public Key" for frontend
4. Copy "Secret Key" for backend (`REVENUECAT_API_KEY`)
5. Webhooks → Create webhook → Copy "Authorization Header" value
   (`REVENUECAT_WEBHOOK_SECRET`)

### 4. Run the Emulator

```bash
cd functions
npm run dev:emulator
```

---

## Production Deployment

### Secrets (Sensitive Data)

Use Firebase Secrets for sensitive data like API keys. Secrets are stored in
Google Cloud Secret Manager.

#### Set Secrets

```bash
# Set required secrets (sensitive data only)
firebase functions:secrets:set GEMINI_API_KEY
firebase functions:secrets:set WEB_API_KEY
firebase functions:secrets:set REVENUECAT_API_KEY
firebase functions:secrets:set REVENUECAT_WEBHOOK_SECRET

# You'll be prompted to enter each value
```

**Note:** `GOOGLE_CLIENT_ID` is not a secret (it's public in client apps). Set
it via Firebase environment config or `.env` file instead.

#### List Secrets

```bash
firebase functions:secrets:list
```

#### Access Secrets in Code

Secrets are automatically available as environment variables. No code changes
needed.

```typescript
// Already works - secrets are injected as env vars
const apiKey = process.env.GEMINI_API_KEY;
const revenuecatKey = process.env.REVENUECAT_API_KEY;
```

#### Destroy a Secret

```bash
firebase functions:secrets:destroy GEMINI_API_KEY
```

---

### Environment Variables (Non-Sensitive Config)

For non-sensitive configuration, use the `functions/.env.<project>` pattern or
define in code.

#### Option 1: Project-specific .env files

```bash
# Create production env file
touch functions/.env.cooklynx-ai

# Add non-sensitive config
echo "MAX_IMAGE_SIZE=10485760" >> functions/.env.cooklynx-ai
echo "ALLOWED_MIME_TYPES=image/jpeg,image/png,image/webp" >> functions/.env.cooklynx-ai
```

Firebase automatically loads `.env.<project-id>` in production.

#### Option 2: Define in firebase.json

```json
{
  "functions": [
    {
      "source": "functions",
      "runtime": "nodejs22",
      "env": {
        "MAX_IMAGE_SIZE": "10485760",
        "ALLOWED_MIME_TYPES": "image/jpeg,image/png,image/webp"
      }
    }
  ]
}
```

#### Option 3: Use Firebase Functions params (Recommended for typed config)

```typescript
import {defineString, defineInt} from "firebase-functions/params";

const maxImageSize = defineInt("MAX_IMAGE_SIZE", {default: 10485760});
const allowedMimeTypes = defineString("ALLOWED_MIME_TYPES", {
  default: "image/jpeg,image/png,image/webp",
});

// Use in code
const size = maxImageSize.value();
```

---

## GCP Secret Manager (Direct Access)

If you need to manage secrets directly via GCP:

### Prerequisites

```bash
# Install gcloud CLI
brew install google-cloud-sdk

# Authenticate
gcloud auth login

# Set project
gcloud config set project cooklynx-ai
```

### Create a Secret

```bash
# Create secret
echo -n "your-api-key-value" | gcloud secrets create GEMINI_API_KEY --data-file=-

# Or from a file
gcloud secrets create GEMINI_API_KEY --data-file=./secret.txt
```

### Add a New Version

```bash
echo -n "new-api-key-value" | gcloud secrets versions add GEMINI_API_KEY --data-file=-
```

### View Secret Value

```bash
gcloud secrets versions access latest --secret=GEMINI_API_KEY
```

### List All Secrets

```bash
gcloud secrets list
```

### Delete a Secret

```bash
gcloud secrets delete GEMINI_API_KEY
```

### Grant Access to Cloud Functions

```bash
# Get the service account email
gcloud functions describe api --region=us-central1 --format='value(serviceAccountEmail)'

# Grant access
gcloud secrets add-iam-policy-binding GEMINI_API_KEY \
  --member="serviceAccount:YOUR_SERVICE_ACCOUNT@appspot.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

---

## Deployment Commands

### Deploy with Secrets

```bash
# Deploy functions (secrets are automatically injected)
firebase deploy --only functions
```

### Verify Environment in Production

```bash
# Check function logs
firebase functions:log

# Or via gcloud
gcloud functions logs read api --region=us-central1
```

---

## Environment Variables Reference

### Core Settings

| Variable                      | Description                    | Required | Default                           |
| ----------------------------- | ------------------------------ | -------- | --------------------------------- |
| `GEMINI_API_KEY`              | Google Gemini AI API key       | Yes      | -                                 |
| `WEB_API_KEY`                 | Firebase Web API Key           | Yes      | -                                 |
| `GOOGLE_CLIENT_ID`            | Google OAuth Client ID         | Yes      | -                                 |
| `REVENUECAT_API_KEY`          | RevenueCat Secret API Key      | Yes      | -                                 |
| `REVENUECAT_WEBHOOK_SECRET`   | RevenueCat Webhook Auth        | No       | -                                 |
| `SENTRY_DSN`                  | Sentry DSN                     | No       | -                                 |
| `SENTRY_TRACES_SAMPLE_RATE`   | Sentry traces sample rate      | No       | `0.1`                             |
| `SENTRY_PROFILES_SAMPLE_RATE` | Sentry profiles sample rate    | No       | `0.1`                             |
| `SENTRY_RELEASE`              | Sentry release version         | No       | -                                 |
| `SENTRY_ENVIRONMENT`          | Sentry environment             | No       | `NODE_ENV`                        |
| `CUSTOM_FUNCTION_REGION`      | Cloud Functions region         | No       | `us-central1`                     |
| `MAX_IMAGE_SIZE`              | Max upload size in bytes       | No       | `10485760` (10MB)                 |
| `ALLOWED_MIME_TYPES`          | Comma-separated mime types     | No       | `image/jpeg,image/png,image/webp` |
| `ALLOWED_ORIGINS`             | CORS origins (comma-separated) | No       | Production + dev URLs             |

### Subscription Plans (Hardcoded Constants)

These are defined in `src/types/subscription.types.ts` and not configurable via
env:

| Constant             | Value       | Description                         |
| -------------------- | ----------- | ----------------------------------- |
| `FREE_CREDIT_LIMIT`  | 20 credits  | Free tier beta credit limit         |
| `PRO_MONTHLY_LIMIT`  | 100 credits | Pro plan monthly credit limit       |
| `PREMIUM_LIMIT`      | -1          | Premium plan (unlimited)            |
| `IMAGE_CREDIT_COST`  | 1 credit    | Credits consumed per image upload   |
| `RECIPE_CREDIT_COST` | 1 credit    | Credits consumed per URL extraction |

---

## Troubleshooting

### Secret not found in production

```bash
# Verify secret exists
firebase functions:secrets:list

# Re-deploy functions to pick up new secrets
firebase deploy --only functions
```

### Permission denied accessing secret

```bash
# Grant Cloud Functions access to the secret
gcloud secrets add-iam-policy-binding GEMINI_API_KEY \
  --member="serviceAccount:cooklynx-ai@appspot.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### Environment variable not loading locally

1. Ensure `.env` file is in the `functions/` directory
2. Restart the emulator after changes
3. Check the file is not in `.gitignore` with a wrong pattern
