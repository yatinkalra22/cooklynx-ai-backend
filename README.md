# CookLynx AI Backend

Backend services for CookLynx AI - an AI-powered cooking and recipe analysis
platform. Built with Express.js, TypeScript, and Firebase Cloud Functions.

## Features

- **Food Image Analysis** - Upload photos of ingredients, get AI-detected
  items + 3 recipe recommendations
- **Recipe Extraction from Any URL** - Paste a YouTube, Instagram, TikTok, or
  any recipe URL and get a complete grocery-list-ready recipe extracted by AI
- **User Preferences** - Save dietary restrictions, cuisine preferences, and
  allergies for personalized recommendations
- **Subscription Management** - RevenueCat integration for in-app purchases and
  subscription tracking
- **Google & Custom Login** - Firebase Auth with email/password and Google OAuth
- **Gemini AI Integration** - AI-powered food analysis and recipe extraction
- **Content Deduplication** - SHA-256 hashing avoids re-processing
- **Content Moderation** - AI-powered safety checks on all uploads
- **Session Management** - Track user sessions with device fingerprinting
- **OpenAPI/Swagger** - Auto-generated API docs at `/swagger`

## Tech Stack

| Technology                      | Purpose                                      |
| ------------------------------- | -------------------------------------------- |
| **Node.js 22**                  | Runtime                                      |
| **TypeScript**                  | Type-safe development                        |
| **Express.js + tsoa**           | REST API with auto-generated OpenAPI         |
| **Firebase Cloud Functions v2** | Serverless compute (Cloud Run-based)         |
| **Firebase Realtime Database**  | Primary database                             |
| **Firebase Auth**               | Authentication (email + Google)              |
| **Google Cloud Storage**        | File storage (images)                        |
| **Google Cloud Pub/Sub**        | Async processing queues                      |
| **Google Gemini AI**            | Food analysis, recipe extraction, moderation |
| **RevenueCat**                  | Subscription management & in-app purchases   |
| **Sharp**                       | Image optimization & resizing                |
| **Redis** (optional)            | Non-blocking cache layer                     |
| **Sentry**                      | Error tracking & performance profiling       |
| **Helmet**                      | Security headers                             |

## Architecture

```
Client Request
    |
    v
[Firebase Cloud Functions v2 / Express.js + tsoa]
    |
    +-- Middleware: Auth (Firebase ID tokens) + Rate Limiting + Security Headers
    |
    +-- Controllers
    |     +-- /v1/auth/*               Authentication & user management
    |     +-- /v1/images/*             Image upload & food analysis + recipes
    |     +-- /v1/recipes/*            URL recipe extraction (any URL)
    |     +-- /v1/user/preferences     Food preferences & dietary restrictions
    |     +-- /v1/subscription/*       Subscription management (RevenueCat)
    |     +-- /v1/webhooks/*           RevenueCat webhook handler
    |     +-- /v1/assets/*             Unified asset listing
    |
    +-- Services
    |     +-- AIService                Gemini AI (food analysis, moderation)
    |     +-- UrlRecipeService         URL recipe extraction (YouTube + URL Context)
    |     +-- PreferenceService        User food preferences
    |     +-- SubscriptionService      RevenueCat integration & credit management
    |     +-- StorageService           Cloud Storage (upload, optimize, signed URLs)
    |     +-- UserService              User profiles, credits, session management
    |     +-- CacheService             Non-blocking Redis caching
    |     +-- DedupService             SHA256 duplicate detection
    |
    +-- Async Workers (Pub/Sub)
          +-- urlRecipeExtractionWorker      URL recipe extraction via Gemini
```

### How URL Recipe Extraction Works

```
User submits URL (any platform)
    |
    +-- YouTube URL?
    |     YES --> Gemini fileData: watches the actual video (native support)
    |     NO  --> Gemini URL Context: reads the webpage content (REST API)
    |
    v
AI extracts structured recipe (ingredients with quantities, steps, timings)
    |
    v
Stored in Firebase RTDB --> Client polls for results
    |
    v
Frontend keeps original URL for embed/preview (no downloads, no storage)
```

| Platform      | Method             | What AI Sees                              |
| ------------- | ------------------ | ----------------------------------------- |
| YouTube       | Gemini `fileData`  | Watches the full video (audio + visuals)  |
| Instagram     | Gemini URL Context | Reads post caption, description, comments |
| TikTok        | Gemini URL Context | Reads video description, pinned comments  |
| Recipe blogs  | Gemini URL Context | Reads full recipe page (best quality)     |
| Any other URL | Gemini URL Context | Best-effort from page content             |

## Quick Start

```bash
# Clone and install
git clone https://github.com/yatinkalra22/cooklynx-ai-backend.git
cd cooklynx-ai-backend/functions
npm install

# Configure environment
cp .env.example .env
# Edit .env with your values (see docs/local-setup.md)

# Run with emulators
npm run dev:emulator
```

## Project Structure

```
cooklynx-ai-backend/
  functions/
    src/
      index.ts                 Express app setup (middleware, routes, error handling)
      functions.ts             Cloud Function exports (api + Pub/Sub workers)
      observability.ts         Sentry integration
      config/
        constants.ts           App-wide constants & limits
        firebase.config.ts     Firebase + Gemini model initialization
        pubsub.config.ts       Pub/Sub topics & publish functions
        redis.config.ts        Redis client, TTLs, cache keys
        emulator.config.ts     Local emulator host configuration
      controllers/
        auth.tsoa.controller.ts           /v1/auth/* endpoints
        image.tsoa.controller.ts          /v1/images/* endpoints
        recipe-url.tsoa.controller.ts     /v1/recipes/* endpoints
        video.tsoa.controller.ts          /v1/videos/* endpoints
        asset.tsoa.controller.ts          /v1/assets/* endpoints
        health.controller.ts              GET /health
      services/
        ai.service.ts                 Gemini AI (food analysis, content moderation)
        url-recipe.service.ts         URL recipe extraction (YouTube + URL Context)
        storage.service.ts            Cloud Storage (upload, optimize, signed URLs)
        video.service.ts              Video processing pipeline
        video-analysis.service.ts     Frame extraction, Gemini video analysis
        user.service.ts               Credit management, profiles, violations
        cache.service.ts              Non-blocking Redis caching
        dedup.service.ts              SHA256 duplicate detection
      types/
        api.types.ts              Core API types (Image, Analysis, Recipe, Credits)
        recipe-url.types.ts       URL extraction types (ExtractedRecipe, RecipeIngredient)
        video.types.ts            Video analysis types
        asset.types.ts            Unified asset types
        gemini.types.ts           Gemini model constants
      middleware/
        tsoa-auth.middleware.ts   Bearer token authentication
        rate-limit.middleware.ts  Per-endpoint rate limiting
      generated/
        routes.ts                Auto-generated by tsoa
        swagger.json             Auto-generated OpenAPI 3.0 spec
  docs/
    local-setup.md               Local development guide
    environment-setup.md         Environment variables & secrets
    deployment.md                Production deployment guide
    infra-setup.md               Infrastructure setup (Firebase, GCP)
    architecture.md              System architecture overview
    recipe-recommendations.md    Image recipe recommendation architecture
    url-recipe-extraction.md     URL recipe extraction architecture
    caching.md                   Redis caching & deduplication
    cost-estimation.md           Cost estimates for GCP services
    security-improvements.md     Security features & best practices
    FRONTEND_REVENUECAT_INTEGRATION.md  Frontend subscription integration
```

## API Endpoints

### Authentication

| Route                          | Method | Purpose                 | Auth |
| ------------------------------ | ------ | ----------------------- | ---- |
| `/v1/auth/signup`              | POST   | Create account          | No   |
| `/v1/auth/login`               | POST   | Login (email/password)  | No   |
| `/v1/auth/google`              | POST   | Google sign-in          | No   |
| `/v1/auth/me`                  | GET    | Get profile + credits   | Yes  |
| `/v1/auth/profile`             | PATCH  | Update name/photo       | Yes  |
| `/v1/auth/account`             | DELETE | Delete account          | Yes  |
| `/v1/auth/logout`              | POST   | Logout (revoke session) | Yes  |
| `/v1/auth/verification/resend` | POST   | Resend verification     | No   |

### Images (Food Analysis) - 1 credit per upload

| Route                      | Method | Purpose                               | Auth |
| -------------------------- | ------ | ------------------------------------- | ---- |
| `/v1/images/upload`        | POST   | Upload image for analysis             | Yes  |
| `/v1/images`               | GET    | List user's images                    | Yes  |
| `/v1/images/{id}`          | GET    | Get image metadata                    | Yes  |
| `/v1/images/{id}/analysis` | GET    | Get analysis + recipe recommendations | Yes  |
| `/v1/images/{id}/url`      | GET    | Get signed download URL               | Yes  |

### Recipes (URL Extraction) - 1 credit per URL

| Route                          | Method | Purpose                              | Auth |
| ------------------------------ | ------ | ------------------------------------ | ---- |
| `/v1/recipes/extract-from-url` | POST   | Extract recipe from any URL          | Yes  |
| `/v1/recipes/url/{urlId}`      | GET    | Get extraction status/results (poll) | Yes  |
| `/v1/recipes/urls`             | GET    | List user's URL extractions          | Yes  |

### Preferences

| Route                        | Method | Purpose                        | Auth |
| ---------------------------- | ------ | ------------------------------ | ---- |
| `/v1/food-preferences/types` | GET    | Get available preference types | No   |
| `/v1/user/preferences`       | GET    | Get user's preferences         | Yes  |
| `/v1/user/preferences`       | POST   | Save/update preferences        | Yes  |
| `/v1/user/preferences`       | DELETE | Clear preferences              | Yes  |

### Subscriptions

| Route                    | Method | Purpose               | Auth |
| ------------------------ | ------ | --------------------- | ---- |
| `/v1/subscription`       | GET    | Get subscription info | Yes  |
| `/v1/subscription/sync`  | POST   | Sync from RevenueCat  | Yes  |
| `/v1/subscription/plans` | GET    | List available plans  | No   |

### Other

| Route        | Method | Purpose         | Auth |
| ------------ | ------ | --------------- | ---- |
| `/v1/assets` | GET    | List all images | Yes  |
| `/health`    | GET    | Health check    | No   |

Full OpenAPI spec available at `/swagger` when running.

## Gemini AI Models

| Model                    | Purpose                                    | Cost               |
| ------------------------ | ------------------------------------------ | ------------------ |
| `gemini-3-flash-preview` | Food image analysis, URL recipe extraction | Paid               |
| `gemini-2.0-flash`       | Content moderation (safety checks)         | Free tier eligible |

## Subscription Plans

The app uses RevenueCat for subscription management. Three tiers are available:

| Plan        | Credits         | Price     | Features                                    |
| ----------- | --------------- | --------- | ------------------------------------------- |
| **Free**    | 20 beta credits | $0        | Limited trial usage                         |
| **Pro**     | 100/month       | $9.99/mo  | Unlimited food analysis & recipe extraction |
| **Premium** | Unlimited       | $19.99/mo | All Pro features + priority support         |

### Credit Costs

| Action                                                | Cost     |
| ----------------------------------------------------- | -------- |
| Image upload + food analysis + recipe recommendations | 1 credit |
| URL recipe extraction (any platform)                  | 1 credit |

## Cost Estimates (Gemini API)

| Feature                         | Cost per request | At 1,000/day |
| ------------------------------- | ---------------- | ------------ |
| Image analysis (food + recipes) | ~$0.003          | ~$3/day      |
| URL recipe extraction (YouTube) | ~$0.01           | ~$10/day     |
| URL recipe extraction (webpage) | ~$0.005          | ~$5/day      |
| Content moderation              | Free tier        | $0           |

See [docs/cost-estimation.md](docs/cost-estimation.md) for detailed cost
breakdowns.

| Command                | Description                                  |
| ---------------------- | -------------------------------------------- |
| `npm run dev:emulator` | Run emulators with auto-reload (recommended) |
| `npm run serve`        | Run emulators (one-time build)               |
| `npm run build`        | Compile TypeScript + generate OpenAPI spec   |
| `npm run deploy`       | Deploy to Firebase                           |
| `npm run deploy:db`    | Deploy database + storage rules              |
| `npm run lint`         | Run ESLint                                   |
| `npm run logs`         | View function logs                           |

## Deployment

```bash
cd functions
npm run deploy
```

This automatically:

1. Generates OpenAPI spec from TypeScript (tsoa)
2. Compiles TypeScript
3. Deploys to Firebase Cloud Functions

After functions deploy, also deploy Firebase rules (Realtime Database +
Storage):

```bash
cd ..
firebase deploy --only database,storage

# Configure Storage CORS for direct downloads
gsutil cors set storage-cors.json gs://YOUR-PROJECT-ID.firebasestorage.app
```

## Documentation

- [Local Development Setup](docs/local-setup.md)
- [Environment & Secrets Setup](docs/environment-setup.md)
- [Infrastructure Setup Guide](docs/infra-setup.md)
- [Deployment Guide](docs/deployment.md)
- [System Architecture](docs/architecture.md)
- [Recipe Recommendations (Image)](docs/recipe-recommendations.md)
- [URL Recipe Extraction](docs/url-recipe-extraction.md)
- [Redis Caching & Deduplication](docs/caching.md)
- [Cost Estimation](docs/cost-estimation.md)
- [Security Improvements](docs/security-improvements.md)
- [Frontend RevenueCat Integration](functions/docs/FRONTEND_REVENUECAT_INTEGRATION.md)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file
for details.
