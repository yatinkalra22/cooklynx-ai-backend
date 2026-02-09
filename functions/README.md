# CookLynx AI - Backend API

REST API for CookLynx AI - Recipe and cooking powered by AI.

## Tech Stack

- **Runtime:** Node.js 22 + TypeScript
- **Framework:** Express.js
- **Platform:** Firebase Cloud Functions
- **Database:** Firebase Realtime Database
- **Storage:** Firebase Cloud Storage
- **AI:** Google Gemini API
- **Docs:** OpenAPI 3.0 (auto-generated via tsoa)

## API Documentation

### Swagger UI

| Environment | URL                                                                    |
| ----------- | ---------------------------------------------------------------------- |
| Local       | `http://localhost:5001/cooklynx-ai/us-central1/api/swagger`      |
| Production  | `https://us-central1-cooklynx-ai.cloudfunctions.net/api/swagger` |

### OpenAPI Spec (JSON)

| Environment | URL                                                                      |
| ----------- | ------------------------------------------------------------------------ |
| Local       | `http://localhost:5001/cooklynx-ai/us-central1/api/docs.json`      |
| Production  | `https://us-central1-cooklynx-ai.cloudfunctions.net/api/docs.json` |

> ⚠️ **Note on URL Paths:** The local URLs include `/api` because Firebase
> Emulator mirrors the full function path. In production, Firebase automatically
> strips the function name, so `/api` becomes just the base. All endpoints start
> with `/v1/` in both environments.

## API Endpoints

All endpoints below are relative to the base URL (e.g.,
`http://localhost:5001/cooklynx-ai/us-central1/api/v1/auth/signup`)

### Health

- `GET /health` - Health check (no auth required)

### Auth

- `POST /v1/auth/signup` - Create account
- `POST /v1/auth/login` - Login
- `POST /v1/auth/google` - Google Sign-In
- `POST /v1/auth/apple` - Apple Sign-In (coming soon)
- `GET /v1/auth/me` - Get profile (auth required)
- `PATCH /v1/auth/profile` - Update profile (auth required)
- `DELETE /v1/auth/account` - Delete account (auth required)

### Images

- `POST /v1/images/upload` - Upload image (auth required)
- `GET /v1/images` - List images (auth required)
- `GET /v1/images/{imageId}/analysis` - Get analysis (auth required)

### Videos

- `POST /v1/videos/upload` - Upload video for analysis (2 credits)
- `GET /v1/videos` - List user's videos
- `GET /v1/videos/{videoId}/analysis` - Get video analysis status/result

### Video Fixes

- `POST /v1/videos/{videoId}/fixes` - Create fix request (async, 2 credits on
  completion)
- `GET /v1/videos/{videoId}/fixes` - List all fixes for a video
- `GET /v1/videos/{videoId}/fixes/{fixId}` - Poll fix status/result
- `DELETE /v1/videos/{videoId}/fixes/{fixId}` - Delete a fix

## Async Processing Architecture

Video analysis and video fixes use asynchronous processing via Google Cloud
Pub/Sub to handle long-running AI operations.

### How It Works

```
1. Client calls POST /v1/videos/upload or POST /v1/videos/{id}/fixes
2. API validates request, creates job, publishes to Pub/Sub queue
3. API returns immediately with job ID (status: "pending")
4. Pub/Sub worker picks up job and processes (frame extraction, AI analysis, etc.)
5. Worker updates status to "completed" or "failed"
6. Client polls GET endpoint for status/result
```

### Pub/Sub Topics

| Topic                  | Worker Function       | Purpose                         |
| ---------------------- | --------------------- | ------------------------------- |
| `video-analysis-queue` | `videoAnalysisWorker` | Process uploaded video analysis |
| `video-fix-queue`      | `videoFixWorker`      | Process video fix requests      |

### Video Fix Flow

```
POST /fixes → Returns fixId → Poll GET /fixes/{fixId}

Processing:
1. Send original video to Gemini 3 Pro Video model
2. Generate complete fixed video with applied design improvements
3. Extract first frame as thumbnail using ffmpeg
4. Upload fixed video and thumbnail to Cloud Storage
5. Calculate scores and save results
6. Deduct 2 credits on completion

Advantages:
- Better visual consistency (single AI generation)
- Maintains originality while applying fixes
- Faster processing (no frame extraction/reassembly)
- Higher quality output
```

### Deduplication

**Fix Signature:** SHA256(videoId + sorted problemIds) - 16 chars

- Same video + same problems = reuse cached result
- Credits still deducted (user intentionally requested)

**Video Content Hash:** SHA256(video buffer) - 32 chars

- Same video content = copy analysis from original
- Stored in `videoHashes/{userId}/{hash}`

## Development

### Prerequisites

- Node.js >= 22
- Firebase CLI (`npm install -g firebase-tools`)
- Firebase project with Auth, Database, Storage enabled

### Setup

```bash
cd functions
npm install
cp env.example.txt .env.local  # Configure environment variables
```

### Run Locally

```bash
# Build and start emulator
npm run serve

# Or watch mode with emulator
npm run dev:emulator
```

### Available Scripts

| Script                 | Description                                |
| ---------------------- | ------------------------------------------ |
| `npm run build`        | Generate Swagger spec + compile TypeScript |
| `npm run swagger`      | Generate OpenAPI spec and routes           |
| `npm run serve`        | Build + start Firebase emulator            |
| `npm run dev:emulator` | Watch mode with emulator                   |
| `npm run deploy`       | Deploy to Firebase                         |
| `npm run lint`         | Lint code                                  |
| `npm run format`       | Format code                                |

## Adding New Endpoints

Swagger documentation is **automatically generated** from TypeScript. No manual
documentation needed!

### 1. Define Types

Add request/response interfaces to `src/types/api.types.ts`:

```typescript
export interface MyRequest {
  name: string;
  count: number;
}

export interface MyResponse {
  id: string;
  message: string;
}
```

### 2. Create Controller

Create or update a controller in `src/controllers/`:

```typescript
import {Controller, Post, Body, Route, Tags, Security, Response} from "tsoa";
import {MyRequest, MyResponse, ErrorResponse} from "../types/api.types";

@Route("v1/my-resource")
@Tags("MyResource")
export class MyController extends Controller {
  @Post("")
  @Security("BearerAuth") // Requires auth
  @Response<ErrorResponse>(400, "Bad Request")
  public async create(@Body() body: MyRequest): Promise<MyResponse> {
    // Implementation
    return {id: "123", message: "Created"};
  }
}
```

### 3. Build

```bash
npm run build
```

The Swagger spec is automatically regenerated with your new endpoint!

## Deployment

### Deploy to Production

```bash
npm run deploy
```

The deployment process automatically:

1. **Lints** code (`npm run lint`)
2. **Generates** OpenAPI spec from TypeScript controllers
3. **Compiles** TypeScript to JavaScript
4. **Deploys** to Firebase Cloud Functions

### Pre-Deployment Checklist

- [ ] Environment variables configured in Firebase Secrets:
  ```bash
  firebase functions:secrets:set GEMINI_API_KEY
  firebase functions:secrets:set SENTRY_DSN
  firebase functions:secrets:set FIREBASE_PROJECT_ID
  firebase functions:secrets:set FIREBASE_PRIVATE_KEY
  firebase functions:secrets:set FIREBASE_CLIENT_EMAIL
  ```
- [ ] Build succeeds locally: `npm run build`
- [ ] All tests pass (if applicable)
- [ ] .gitignore prevents committing `.env` and `lib/` directory

### Understanding URL Routing

**Important:** Firebase Cloud Functions automatically strip the function name
from the path:

| Context            | Base URL                                                       | Example Endpoint | Full URL                                                                     |
| ------------------ | -------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------- |
| **Local Emulator** | `http://localhost:5001/cooklynx-ai/us-central1/api`      | `/v1/auth/login` | `http://localhost:5001/cooklynx-ai/us-central1/api/v1/auth/login`      |
| **Production**     | `https://us-central1-cooklynx-ai.cloudfunctions.net/api` | `/v1/auth/login` | `https://us-central1-cooklynx-ai.cloudfunctions.net/api/v1/auth/login` |

**Why the difference?**

- The Cloud Function is exported as `api` in
  [src/functions.ts](src/functions.ts)
- Firebase automatically prepends `/functionName/` to all paths
- In production, this becomes part of the base URL structure
- Your `/v1/` routes remain consistent in both environments

### Production Considerations

- **Timeout:** Set to 300s (5 minutes) for AI image analysis
- **Memory:** Allocated to 1GB for image processing
- **Max Instances:** Configured to 10 instances for scaling
- **Region:** Defaults to `us-central1` (configurable via
  `CUSTOM_FUNCTION_REGION` env var)

## Project Structure

```
functions/
├── src/
│   ├── config/           # Firebase configuration
│   ├── controllers/      # tsoa controllers (API endpoints)
│   ├── middleware/       # Auth, file upload middleware
│   ├── services/         # Business logic (AI, storage)
│   ├── types/            # TypeScript interfaces (→ OpenAPI schemas)
│   ├── generated/        # Auto-generated (gitignored)
│   │   ├── routes.ts     # Express routes from tsoa
│   │   └── swagger.json  # OpenAPI specification
│   ├── index.ts          # Express app setup
│   └── functions.ts      # Cloud Functions export
├── tsoa.json             # tsoa configuration
├── tsconfig.json         # TypeScript configuration
└── package.json
```

## Authentication

All protected endpoints require a Firebase token in the Authorization header:

```
Authorization: Bearer <firebase-id-token>
```

Get tokens via:

- Firebase Auth SDK (client-side)
- Custom token exchange (server-side)

## Environment Variables

See `env.example.txt` for required configuration.
