# Architecture Overview

## System Overview

```
Clients (Mobile App / Web App)
    │
    ▼
┌──────────────────────────────────────────────┐
│  Google Cloud Functions v2 (us-central1)     │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │ api (HTTP)                           │    │
│  │ Express.js + tsoa (OpenAPI)          │    │
│  │ 1 GiB RAM · 5 min timeout           │    │
│  └──────────┬───────────────────────────┘    │
│             │                                │
│  ┌──────────▼───────────────────────────┐    │
│  │ Middleware Stack                      │    │
│  │ Sentry → Helmet → CORS → Multer →   │    │
│  │ JSON parser → Rate limiter → tsoa    │    │
│  │ auth (Firebase JWT)                  │    │
│  └──────────┬───────────────────────────┘    │
│             │                                │
│  ┌──────────▼───────────────────────────┐    │
│  │ Controllers (tsoa)                   │    │
│  │ Auth · Image · Fix · Video ·         │    │
│  │ VideoFix · Asset · Health            │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │ videoAnalysisWorker (Pub/Sub)        │    │
│  │ 2 GiB RAM · 9 min timeout           │    │
│  │ Subscribes: video-analysis-queue     │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │ videoFixWorker (Pub/Sub)             │    │
│  │ 2 GiB RAM · 9 min timeout           │    │
│  │ Subscribes: video-fix-queue          │    │
│  └──────────────────────────────────────┘    │
└──────────────────────────────────────────────┘
    │              │              │
    ▼              ▼              ▼
┌────────┐  ┌───────────┐  ┌──────────────┐
│Firebase│  │  Cloud     │  │  Google       │
│ RTDB   │  │  Storage   │  │  Gemini AI   │
└────────┘  └───────────┘  └──────────────┘
    │
    ▼ (optional)
┌────────┐
│ Redis  │
│ Cache  │
└────────┘
```

---

## Cloud Functions

| Function                | Trigger   | Memory | Timeout | Max Instances | Purpose                          |
| ----------------------- | --------- | ------ | ------- | ------------- | -------------------------------- |
| `api`                   | HTTP      | 1 GiB  | 300s    | 10            | Main REST API (Express + tsoa)   |
| `videoAnalysisWorker`   | Pub/Sub   | 2 GiB  | 540s    | 5             | Async video analysis processing  |
| `videoFixWorker`        | Pub/Sub   | 2 GiB  | 540s    | 5             | Async video fix generation       |

---

## AI Models (Google Gemini)

| Model                         | ID                            | Purpose                           |
| ----------------------------- | ----------------------------- | --------------------------------- |
| **Gemini 3 Flash Preview**    | `gemini-3-flash-preview`      | Room analysis (images + videos)   |
| **Gemini 3 Pro Image Preview**| `gemini-3-pro-image-preview`  | Fix image generation (text+image output) |
| **Gemini 2.0 Flash**          | `gemini-2.0-flash`            | Content moderation (safety checks)|

- **Analysis model** sends multimodal input (image or full video) and returns structured JSON with scores across 6 dimensions
- **Image generation model** uses `responseModalities: ["Text", "Image"]` to produce a visually fixed room image
- **Moderation model** is cheap/free-tier eligible, used only for binary safety classification

---

## API Endpoints

| Controller         | Route Prefix                       | Purpose                                    |
| ------------------ | ---------------------------------- | ------------------------------------------ |
| HealthController   | `/`                                | Health check                               |
| AuthController     | `/v1/auth`                         | Signup, login, Google sign-in, profile, email verification |
| ImageController    | `/v1/images`                       | Upload image, get analysis, list images, signed URLs |
| FixController      | `/v1/images/{imageId}/fixes`       | Create/get/list/delete image fixes         |
| VideoController    | `/v1/videos`                       | Upload video, get analysis, list videos    |
| VideoFixController | `/v1/videos/{videoId}/fixes`       | Create/get/list/delete video fixes         |
| AssetController    | `/v1/assets`                       | Unified list of all images + videos        |

All endpoints except health require **Bearer auth** (Firebase Auth JWT). OpenAPI docs auto-generated at `/swagger`.

---

## Request Flows

### Image Upload + Analysis (Synchronous)

```
Client                     api Cloud Function                 Cloud Storage    Gemini AI        RTDB
  │                              │                                │               │              │
  ├── POST /v1/images/upload ──► │                                │               │              │
  │   (image file)               │                                │               │              │
  │                              ├── reserveBetaCredits() ───────────────────────────────────────►│
  │                              │   (atomic: check + deduct)     │               │              │
  │                              │                                │               │              │
  │                              ├── SHA-256 dedup check ────────────────────────────────────────►│
  │                              │                                │               │              │
  │                              ├── Sharp: optimize/resize       │               │              │
  │                              │                                │               │              │
  │                              ├── Content moderation ─────────────────────────► │              │
  │                              │   (Gemini 2.0 Flash)           │               │              │
  │                              │                                │               │              │
  │                              ├── Upload optimized image ────► │               │              │
  │                              │                                │               │              │
  │                              ├── Save metadata ──────────────────────────────────────────────►│
  │                              │                                │               │              │
  │ ◄── 201 {imageId, status} ──┤                                │               │              │
  │                              │                                │               │              │
  │                              │  [Background - no wait]        │               │              │
  │                              ├── analyzeRoom() ──────────────────────────────►│              │
  │                              │   (Gemini 3 Flash Preview)     │               │              │
  │                              │   Returns 6-dimension scoring  │               │              │
  │                              │                                │               │              │
  │                              ├── Save analysis ──────────────────────────────────────────────►│
  │                              │   + cache in Redis             │               │              │
  │                              │                                │               │              │
  ├── GET /images/{id}/analysis ►│ ◄── poll until completed ─────────────────────────────────────►│
```

### Image Fix (Synchronous)

```
Client                     api Cloud Function                 Cloud Storage    Gemini AI        RTDB
  │                              │                                │               │              │
  ├── POST /images/{id}/fixes ─► │                                │               │              │
  │   {fixScope, problemIds}     │                                │               │              │
  │                              ├── reserveBetaCredits() ───────────────────────────────────────►│
  │                              │                                │               │              │
  │                              ├── Dedup: fix signature check   │               │              │
  │                              │   SHA-256(imageId + problemIds)│               │              │
  │                              │                                │               │              │
  │                              ├── Create fix job ─────────────────────────────────────────────►│
  │                              │                                │               │              │
  │ ◄── 202 {fixId} ────────────┤                                │               │              │
  │                              │                                │               │              │
  │                              │  [Background - no wait]        │               │              │
  │                              ├── generateFixedImage() ───────────────────────►│              │
  │                              │   (Gemini 3 Pro Image Preview) │               │              │
  │                              │   Input: original + problems   │               │ AI-generated │
  │                              │   Output: fixed room image     │               │ room image   │
  │                              │                                │               │              │
  │                              │   On failure, fallback:        │               │              │
  │                              │   generateFixPlan() ──────────────────────────►│              │
  │                              │   (text-only design plan)      │               │              │
  │                              │                                │               │              │
  │                              ├── Upload fixed image ─────────►│               │              │
  │                              ├── Save result ────────────────────────────────────────────────►│
  │                              │                                │               │              │
  ├── GET /images/{id}/fixes/{fixId} ► poll until completed ─────────────────────────────────────►│
```

### Video Upload + Analysis (Pub/Sub Async)

```
Client              api Cloud Function      Pub/Sub          videoAnalysisWorker      Cloud Storage    Gemini AI      RTDB
  │                       │                    │                     │                     │              │             │
  ├── POST /videos/upload►│                    │                     │                     │              │             │
  │   (video file)        │                    │                     │                     │              │             │
  │                       ├── reserveCredits()─┼─────────────────────┼─────────────────────┼──────────────┼────────────►│
  │                       │   (2 credits)      │                     │                     │              │             │
  │                       │                    │                     │                     │              │             │
  │                       ├── ffmpeg: extract  │                     │                     │              │             │
  │                       │   thumbnail +      │                     │                     │              │             │
  │                       │   validate duration│                     │                     │              │             │
  │                       │   (max 60s)        │                     │                     │              │             │
  │                       │                    │                     │                     │              │             │
  │                       ├── Moderate thumbnail────────────────────────────────────────────────────────►│             │
  │                       │   (Gemini 2.0 Flash)                     │                     │              │             │
  │                       │                    │                     │                     │              │             │
  │                       ├── Upload video + thumbnail──────────────────────────────────►│              │             │
  │                       │                    │                     │                     │              │             │
  │                       ├── Save metadata ───┼─────────────────────┼─────────────────────┼──────────────┼────────────►│
  │                       │                    │                     │                     │              │             │
  │                       ├── Publish ────────►│ video-analysis-queue│                     │              │             │
  │                       │   {videoId, userId}│                     │                     │              │             │
  │                       │                    │                     │                     │              │             │
  │◄── 201 {videoId} ────┤                    │                     │                     │              │             │
  │                       │                    ├── Trigger ─────────►│                     │              │             │
  │                       │                    │                     │                     │              │             │
  │                       │                    │                     ├── Download video ──►│              │             │
  │                       │                    │                     │   from Storage       │              │             │
  │                       │                    │                     │                     │              │             │
  │                       │                    │                     ├── ffmpeg: extract   │              │             │
  │                       │                    │                     │   frames (every 5s, │              │             │
  │                       │                    │                     │   max 12 frames)    │              │             │
  │                       │                    │                     │                     │              │             │
  │                       │                    │                     ├── Upload frames ───►│              │             │
  │                       │                    │                     │                     │              │             │
  │                       │                    │                     ├── Moderate frames (batch 4)───────►│             │
  │                       │                    │                     │   (Gemini 2.0 Flash)│              │             │
  │                       │                    │                     │                     │              │             │
  │                       │                    │                     ├── Analyze video ───────────────────►│             │
  │                       │                    │                     │   (Gemini 3 Flash Preview)         │             │
  │                       │                    │                     │   Sends whole video inline          │             │
  │                       │                    │                     │                     │              │             │
  │                       │                    │                     ├── Extract problem frames at exact timestamps    │
  │                       │                    │                     │                     │              │             │
  │                       │                    │                     ├── Save analysis ───────────────────────────────►│
  │                       │                    │                     │   + cache in Redis  │              │             │
  │                       │                    │                     │                     │              │             │
  ├── GET /videos/{id}/analysis ► poll (queued→extracting→moderating→analyzing→aggregating→completed) ──►│
```

### Video Fix (Pub/Sub Async)

```
Client              api Cloud Function      Pub/Sub          videoFixWorker           Cloud Storage    Gemini AI      RTDB
  │                       │                    │                     │                     │              │             │
  ├── POST /videos/{id}/fixes►│                │                     │                     │              │             │
  │   {fixScope, problemIds}  │                │                     │                     │              │             │
  │                       │                    │                     │                     │              │             │
  │                       ├── reserveCredits()─┼─────────────────────┼─────────────────────┼──────────────┼────────────►│
  │                       │   (2 credits)      │                     │                     │              │             │
  │                       │                    │                     │                     │              │             │
  │                       ├── Dedup: fix signature check             │                     │              │             │
  │                       │                    │                     │                     │              │             │
  │                       ├── Create fix job ──┼─────────────────────┼─────────────────────┼──────────────┼────────────►│
  │                       │                    │                     │                     │              │             │
  │                       ├── Publish ────────►│ video-fix-queue     │                     │              │             │
  │                       │   {fixId, videoId} │                     │                     │              │             │
  │                       │                    │                     │                     │              │             │
  │◄── 201 {fixId} ──────┤                    │                     │                     │              │             │
  │                       │                    ├── Trigger ─────────►│                     │              │             │
  │                       │                    │                     │                     │              │             │
  │                       │                    │                     ├── For each target frame:            │             │
  │                       │                    │                     │   Download frame ──►│              │             │
  │                       │                    │                     │                     │              │             │
  │                       │                    │                     │   generateFixedImage()────────────►│             │
  │                       │                    │                     │   (Gemini 3 Pro Image Preview)     │             │
  │                       │                    │                     │   Fallback: generateFixPlan()──────►│             │
  │                       │                    │                     │                     │              │             │
  │                       │                    │                     │   Upload fixed frame►│              │             │
  │                       │                    │                     │                     │              │             │
  │                       │                    │                     ├── Save result ─────────────────────────────────►│
  │                       │                    │                     │                     │              │             │
  ├── GET /videos/{id}/fixes/{fixId} ► poll until completed ────────────────────────────────────────────►│
```

---

## Credit System

Credits are reserved **atomically upfront** using a single Firebase RTDB transaction that checks availability AND deducts in one step. This eliminates race conditions from concurrent requests.

| Operation       | Credit Cost | Transaction Type  |
| --------------- | ----------- | ----------------- |
| Image analysis  | 1           | `image_analysis`  |
| Image fix       | 1           | `image_fix`       |
| Video analysis  | 2           | `video_analysis`  |
| Video fix       | 2           | `video_fix`       |

- Default limit: **20 credits** per account (configurable per user via `creditLimit`)
- Credits deducted on **request submission**, not on processing success
- All transactions logged to `users/{uid}/creditLedger` for audit trail
- `GET /v1/auth/me` returns current `credit` (consumed) and `creditLimit` (max allowed)

---

## Security Architecture

### Multi-Layer Security

```
Client (Mobile / Web)
    │ [1. Firebase Auth Token in Authorization header]
    ▼
Cloud Functions (api)
    │ [2. Helmet: security headers (CSP, HSTS, X-Frame-Options, etc.)]
    │ [3. CORS: whitelist of allowed origins]
    │ [4. Rate limiter: strict on auth, moderate on API]
    │ [5. tsoa auth middleware: validate Firebase JWT]
    │ [6. Extract userId from token]
    ▼
Controller
    │ [7. Resource ownership check (userId match)]
    │ [8. Credit reservation (atomic)]
    ▼
Service Layer
    │ [9. Content moderation (Gemini 2.0 Flash)]
    │ [10. Input validation]
    ▼
Database / Storage
```

### Content Moderation

All uploads go through AI-powered content moderation before processing:

1. **CSAM Detection** - Zero tolerance for child exploitation material
2. **Adult Content** - Block nudity and sexual content
3. **Violence/Gore** - Block graphic violence
4. **Inappropriate Content** - Block drugs, weapons, hate symbols

Violations are tracked per user. After **3 violations**, the account is permanently suspended.

---

## Database Schema (Firebase Realtime Database)

```
/users/{userId}
    ├── credit: number                    # Credits consumed
    ├── creditLimit: number               # Max credits allowed (default: 20)
    ├── creditLedger/                     # Audit trail
    │   └── {pushId}: { type, amount, resourceId, timestamp, creditAfter }
    ├── totalPhotos: number
    ├── totalPhotoCompleted: number
    ├── totalPhotoFailed: number
    └── contentViolations/
        ├── count: number
        ├── blocked: boolean
        ├── blockedAt: string
        └── history/
            └── {pushId}: { category, timestamp }

/images/{imageId}
    ├── imageId, userId, storagePath, originalName, mimeType, size
    ├── width, height, uploadedAt
    ├── analysisStatus: "pending" | "processing" | "completed" | "failed"
    ├── overallScore: number
    ├── fixCount: number
    ├── contentHash: string               # SHA-256 for dedup
    └── analysisSourceId?: string         # Source image if duplicate

/analysis/{imageId}
    ├── overall: { score, grade, summary }
    └── dimensions: { lighting, spatial, color, clutter, biophilic, fengShui }
        └── each: { score, status, problems[], solutions[] }

/fixes/{fixId}
    ├── fixId, originalImageId, userId
    ├── status: "pending" | "processing" | "completed" | "failed"
    ├── fixScope: "single" | "multiple" | "all"
    ├── problemIds[], dimensions[], version
    ├── fixSignature: string              # SHA-256 for dedup
    └── sourceFixId?: string              # Source fix if deduplicated

/fixResults/{fixId}
    ├── fixedImageStoragePath, problemsFixed[]
    ├── summary, fixName, changesApplied[]
    ├── originalScore, fixedScore, scoreDelta
    ├── originalDimensionScores, fixedDimensionScores
    └── fixDescription?: string           # Text fallback if image gen failed

/videos/{videoId}
    ├── videoId, userId, videoStoragePath, thumbnailStoragePath
    ├── originalName, mimeType, size, duration, width, height, frameCount
    ├── analysisStatus: "pending" | "queued" | "extracting" | "moderating"
    │                   | "analyzing" | "aggregating" | "completed" | "failed"
    ├── overallScore: number
    ├── fixCount: number
    ├── contentHash: string
    └── analysisSourceId?: string

/videoAnalysis/{videoId}
    ├── overall: { score, grade, summary, consistencyScore }
    ├── dimensions: { lighting, spatial, color, clutter, biophilic, fengShui }
    ├── timeline: [{ markerId, timestamp, frameIndex, dimension, issue, severity }]
    ├── frames: [{ frameIndex, timestamp, storagePath, analysis, isKeyFrame }]
    └── categorizedProblems: { general[], problemFrames[] }

/videoFixes/{fixId}
    ├── fixId, originalVideoId, userId
    ├── status, fixScope, problemIds[], dimensions[], version
    ├── fixSignature, sourceFixId?
    ├── generalProblemIds?, frameFixes?
    └── createdAt, completedAt?, error?

/videoFixResults/{fixId}
    ├── fixedFrames: [{ frameIndex, timestamp, originalFrameStoragePath,
    │                    fixedFrameStoragePath, fixDescription, problems[] }]
    ├── problemsFixed[], summary, fixName, changesApplied[]
    ├── originalScore, fixedScore, scoreDelta
    ├── originalDimensionScores, fixedDimensionScores
    └── duration, generatedAt

/videoFixSignatures/{videoId}/{signature} → fixId
/videoFixIndex/{videoId}/{fixId} → { version, status, createdAt }
/videoHashes/{userId}/{contentHash} → { videoId, createdAt }
```

---

## Cloud Storage Structure

```
gs://{bucket}/
└── users/{userId}/
    ├── images/
    │   └── {imageId}.jpg                 # Optimized original
    ├── fixes/
    │   └── {fixId}.png                   # AI-generated fixed image
    └── videos/{videoId}/
        ├── video.{ext}                   # Original video (mp4/mov/webm)
        ├── thumbnail.jpg                 # First frame thumbnail
        └── frames/
            └── frame_{index}.jpg         # Extracted analysis frames
```

---

## Caching Architecture (Redis - Optional)

Redis is completely optional and non-blocking. If unavailable, the app falls back to direct database reads.

```
Request → Check Redis Cache → Hit? Return cached
                            → Miss? Fetch from RTDB → Cache → Return
```

Key TTLs:

| Cache Type       | TTL      | Key Pattern                    |
| ---------------- | -------- | ------------------------------ |
| Analysis results | 24 hours | `analysis:{imageId}`           |
| Fix results      | 7 days   | `fix:{fixId}`                  |
| Image lists      | 5 min    | `user:{userId}:images`         |
| Image hashes     | 30 days  | `ihash:{userId}:{hash}`        |
| Video fix results| 7 days   | `vfix:{fixId}`                 |

See [caching.md](./caching.md) for full details.

---

## Observability

- **Sentry** - Error tracking + performance profiling (disabled in emulator mode)
- **Firebase Functions Logger** - Structured logging with correlation IDs (`x-request-id`)
- **Log-based metrics** - `api_usage` events logged for every request (method, path, status, duration, userId)

---

## Cost Optimization

1. **Deduplication** - SHA-256 content hashing; duplicate uploads reuse previous analysis
2. **Fix deduplication** - Same problem set on same image/video reuses existing fix result
3. **Frame limiting** - Max 12 frames per video analysis (every 5s for 60s video)
4. **Batch moderation** - Process frames in batches of 4 to reduce API calls
5. **Model selection** - Cheap Gemini 2.0 Flash for moderation; Flash Preview for analysis
6. **Optional caching** - Redis reduces repeated database reads
7. **Signed URLs** - 7-day expiration reduces storage egress
