# Deployment Guide

Complete guide for deploying CookLynx AI backend to Firebase Cloud Functions.

## Prerequisites

- Firebase CLI installed: `npm install -g firebase-tools`
- Authenticated with Firebase: `firebase login`
- Firebase project created with:
  - Cloud Functions enabled
  - Cloud Storage enabled
  - Authentication enabled
  - Realtime Database enabled (or Firestore)
  - **Cloud Pub/Sub enabled** (for video processing)

## Pre-Deployment Setup

### 1. Enable Required GCP Services

```bash
# Enable Cloud Pub/Sub for video processing
gcloud services enable pubsub.googleapis.com

# Create Pub/Sub topics for async processing
gcloud pubsub topics create video-analysis-queue
gcloud pubsub topics create video-fix-queue
```

### 2. Configure Environment Variables

Set all required secrets in Firebase:

```bash
cd functions

# AI/ML
firebase functions:secrets:set GEMINI_API_KEY

# Authentication (WEB_API_KEY only - GOOGLE_CLIENT_ID is public, set as env var)
firebase functions:secrets:set WEB_API_KEY

# Firebase Credentials (from Firebase Console → Project Settings → Service Account)
firebase functions:secrets:set FIREBASE_PROJECT_ID
firebase functions:secrets:set FIREBASE_PRIVATE_KEY
firebase functions:secrets:set FIREBASE_CLIENT_EMAIL

# Optional: Custom region (default: us-central1)
firebase functions:secrets:set CUSTOM_FUNCTION_REGION
```

### 3. Verify Local Build

```bash
npm run build
```

Ensure:

- No TypeScript errors
- OpenAPI spec generated in `src/generated/swagger.json`
- JavaScript compiled in `lib/` directory

### 4. Test Locally

```bash
npm run dev:emulator
```

- Health check:
  `GET http://localhost:5001/cooklynx-ai/us-central1/api/health`
- Swagger UI: `http://localhost:5001/cooklynx-ai/us-central1/api/swagger`

## Deployment

### Deploy All Functions

```bash
npm run deploy
```

This runs the Firebase pre-deploy hooks configured in
[firebase.json](/firebase.json):

1. **Lint:** `npm run lint`
2. **Build:** `npm run build`
3. **Deploy:** Firebase CLI uploads to Cloud Functions

### Deploy Specific Function

```bash
firebase deploy --only functions:api
```

## Post-Deployment Verification

### 1. Check Deployment Status

```bash
firebase functions:list
```

You should see these functions in the `us-central1` region:

- `api` - Main HTTP API
- `videoAnalysisWorker` - Pub/Sub triggered video analysis processor
- `videoFixWorker` - Pub/Sub triggered video fix processor

### 2. Test Endpoints

```bash
# Health check (no auth required)
curl https://us-central1-cooklynx-ai.cloudfunctions.net/api/health

# Swagger UI
open https://us-central1-cooklynx-ai.cloudfunctions.net/api/swagger

# OpenAPI spec
curl https://us-central1-cooklynx-ai.cloudfunctions.net/api/docs.json
```

### 3. View Logs

```bash
firebase functions:log --only api
```

Or in Firebase Console:

1. Functions → api
2. Logs tab

## URL Routing Explained

### Why Paths Differ Between Local and Production

**Local Emulator:**

```
http://localhost:5001/cooklynx-ai/us-central1/api/v1/auth/login
                      ├─ Project ID ──────────────────┤ ├─ Function ─┤ ├─ Route ────┤
```

**Production:**

```
https://us-central1-cooklynx-ai.cloudfunctions.net/api/v1/auth/login
├─ Region ─┤ ├─ Project ID ──────────────┤ ├─ Function ─┤ ├─ Route ────┤
```

### How It Works

1. **Function Export** ([src/functions.ts](../functions/src/functions.ts)):

   ```typescript
   export const api = onRequest({region: REGION}, app);
   ```

2. **Firebase Cloud Functions URL Pattern:**
   - Local: `http://localhost:5001/{projectId}/{region}/api`
   - Production: `https://{region}-{projectId}.cloudfunctions.net/api`

3. **Your Express App** routes start with `/v1/`:
   - Auth: `/v1/auth/login`, `/v1/auth/signup`, etc.
   - Images: `/v1/images/upload`, `/v1/images/{id}/analysis`, etc.
   - Health: `/health`

4. **Result:**
   - Local: Base URL + `/v1/auth/login` = Full path includes `/api/v1/`
   - Production: Base URL + `/v1/auth/login` = Function name is part of base URL

**Key Insight:** The `/api` path is the function name, **not part of your
routing**. Your routes should always start with `/v1/` for consistent behavior.

## Troubleshooting

### Deployment Fails: Lint Errors

```bash
npm run lint
```

Fix any linting errors, then retry deployment.

### Deployment Fails: Build Errors

```bash
npm run build
```

Ensure:

- All TypeScript is valid
- tsoa can generate from controllers
- No missing dependencies

### Function Timeout in Production

If image analysis times out:

1. Increase timeout in [src/index.ts](../functions/src/index.ts#L14):

   ```typescript
   timeoutSeconds: 540; // 9 minutes instead of 5
   ```

2. Increase memory allocation:

   ```typescript
   memory: "2GiB"; // from "1GiB"
   ```

3. Redeploy: `npm run deploy`

### 404 Errors in Production

Check the URL structure:

- ❌ Wrong:
  `https://us-central1-cooklynx-ai.cloudfunctions.net/api/api/v1/auth/login`
- ✅ Correct:
  `https://us-central1-cooklynx-ai.cloudfunctions.net/api/v1/auth/login`

The function name (`api`) is part of the base URL, don't duplicate it.

### Can't Access Swagger UI

Verify the function is deployed:

```bash
firebase functions:list
```

Access at: `https://{region}-{projectId}.cloudfunctions.net/api/swagger`

### Authentication Failing

Ensure Firebase Auth tokens:

1. Are current (not expired)
2. Belong to the same Firebase project
3. Are sent as: `Authorization: Bearer <token>`

## Scaling & Performance

### Default Configuration

Set in [src/index.ts](../functions/src/index.ts#L14-L17):

```typescript
setGlobalOptions({
  maxInstances: 10, // Up to 10 concurrent functions
  timeoutSeconds: 300, // 5 minutes for AI processing
  memory: "1GiB", // 1 GB RAM per instance
});
```

### For High-Load Production

Increase in [src/index.ts](../functions/src/index.ts):

```typescript
setGlobalOptions({
  maxInstances: 50, // Scale to 50 instances
  timeoutSeconds: 540, // 9 minutes for slower networks
  memory: "2GiB", // 2 GB for faster processing
});
```

Then redeploy: `npm run deploy`

## Database & Storage Seeding

### Initialize Firebase Storage

Create security rules in [storage.rules](/storage.rules) and deploy:

```bash
firebase deploy --only storage
```

#### Configure Storage CORS

To allow direct downloads from your Firebase Storage bucket (required for fix
images/videos), apply CORS configuration:

1. Create [storage-cors.json](/storage-cors.json) in project root:

```json
[
  {
    "origin": [
      "https://cooklynx-ai.firebaseapp.com",
      "https://cooklynx-ai.web.app",
      "https://cooklynx-ai.vercel.app",
      "http://localhost:3000",
      "http://localhost:8081"
    ],
    "method": ["GET", "HEAD", "PUT", "POST", "DELETE"],
    "maxAgeSeconds": 3600,
    "responseHeader": [
      "Content-Type",
      "Content-Length",
      "Content-Disposition",
      "Cache-Control"
    ]
  }
]
```

2. Apply CORS configuration to the bucket:

```bash
gsutil cors set storage-cors.json gs://YOUR-PROJECT-ID.firebasestorage.app
```

Replace `YOUR-PROJECT-ID` with your actual Firebase project ID.

**Note:** This is separate from API CORS (configured in
[cors.config.ts](../functions/src/config/cors.config.ts)) which only applies to
Cloud Functions endpoints. Storage CORS is required for browser downloads of
signed URLs.

### Initialize Realtime Database

Structure and rules should be in `database.rules.json` (if using RTDB):

```bash
firebase deploy --only database
```

## Monitoring & Alerts

### View Real-Time Logs

```bash
firebase functions:log --follow
```

### Set Up Alerts (Firebase Console)

1. Go to Cloud Functions
2. Click on `api` function
3. Monitoring tab
4. Create alerts for:
   - Error rate > 1%
   - Timeout rate > 0.5%
   - Memory usage > 800MB

## Rollback

### View Deployment History

```bash
firebase functions:describe api
```

### Rollback to Previous Version

In Firebase Console:

1. Cloud Functions
2. Select `api`
3. Revisions tab
4. Select previous revision and promote

Or use gcloud CLI:

```bash
gcloud functions deploy api \
  --gen2 \
  --region=us-central1 \
  --revision-id=<previous-revision-id>
```

## Security Considerations

- ✅ Secrets stored in Firebase Secrets Manager (not in code)
- ✅ API CORS enabled for client origins
  ([cors.config.ts](../functions/src/config/cors.config.ts))
- ✅ Storage CORS configured for direct downloads (storage-cors.json)
- ✅ Firebase Auth required for protected endpoints
- ✅ Input validation via tsoa
- ✅ File upload limits enforced (images: 10MB, videos: 50MB)
- ✅ Video duration limit enforced (60 seconds max)
- ✅ AI content moderation on all uploads

See [docs/architecture.md](./architecture.md) for security details.

## Additional Resources

- [Firebase Cloud Functions Docs](https://firebase.google.com/docs/functions)
- [Express.js Guide](https://expressjs.com/)
- [tsoa Documentation](https://tsoa-community.github.io/docs/)
- [Google Gemini API](https://ai.google.dev/)
