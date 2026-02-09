# CookLynx AI Backend

Backend services for CookLynx AI - an AI-powered cooking and recipe analysis
platform. Built with Express.js, TypeScript, and Firebase Cloud Functions.

## Features

- **Google & Custom Login** - Firebase Auth with email/password and Google OAuth
- **Gemini AI Integration** - AI-powered analysis and generation
- **Image Analysis** - Upload photos for AI-powered analysis
- **Video Processing** - Record walkthroughs and get timeline-based feedback
- **AI Fix Generation** - Generate AI-improved images/videos
- **Atomic Credit System** - Race-condition-free credit reservation
- **Content Deduplication** - SHA-256 hashing avoids re-processing
- **Content Moderation** - AI-powered safety checks on all uploads
- **OpenAPI/Swagger** - Auto-generated API docs at `/swagger`

## Tech Stack

| Technology                      | Purpose                                |
| ------------------------------- | -------------------------------------- |
| **Node.js 22**                  | Runtime                                |
| **TypeScript**                  | Type-safe development                  |
| **Express.js + tsoa**           | REST API with auto-generated OpenAPI   |
| **Firebase Cloud Functions v2** | Serverless compute (3 functions)       |
| **Firebase Realtime Database**  | Primary database                       |
| **Firebase Auth**               | Authentication (email + Google)        |
| **Google Cloud Storage**        | File storage (images, videos, frames)  |
| **Google Cloud Pub/Sub**        | Async video processing queues          |
| **Google Gemini AI**            | Analysis, fix generation, moderation   |
| **FFmpeg**                      | Video frame extraction & validation    |
| **Sharp**                       | Image optimization & resizing          |
| **Redis** (optional)            | Non-blocking cache layer               |
| **Sentry**                      | Error tracking & performance profiling |
| **Helmet**                      | Security headers                       |

## Quick Start

```bash
# Clone and install
git clone https://github.com/yatinkalra22/cooklynx-ai-backend.git
cd cooklynx-ai-backend/functions
npm install

# Configure environment
cp .env.example .env
# Edit .env with your values (see docs/environment-setup.md)

# Run with emulators
npm run dev:emulator
```

## Project Structure

```
cooklynx-ai-backend/
├── functions/                    # Cloud Functions code
│   ├── src/
│   │   ├── index.ts             # Express app setup (middleware, routes, error handling)
│   │   ├── functions.ts         # Cloud Function exports (api, videoAnalysisWorker, videoFixWorker)
│   │   ├── observability.ts     # Sentry integration
│   │   ├── config/              # Firebase, Pub/Sub, Redis, CORS, constants, env validation
│   │   ├── controllers/         # tsoa controllers (auth, image, fix, video, video-fix, asset, health)
│   │   ├── services/            # Business logic (AI, storage, video, fix, dedup, cache, user, auth)
│   │   ├── middleware/          # Auth, rate limiting, file upload, caching
│   │   ├── types/               # TypeScript interfaces (API types, video types, Gemini models)
│   │   ├── utils/               # Validation utilities
│   │   └── generated/           # tsoa auto-generated routes + swagger.json
│   ├── lib/                     # Compiled JavaScript output
│   ├── .env.example             # Environment template
│   └── package.json             # Dependencies and scripts
├── docs/                        # Documentation
├── firebase.json                # Firebase project configuration
├── database.rules.json          # RTDB security rules
└── storage.rules                # Cloud Storage security rules
```

## API Endpoints

| Route                           | Method | Purpose                      | Auth |
| ------------------------------- | ------ | ---------------------------- | ---- |
| `/v1/auth/signup`               | POST   | Create account               | No   |
| `/v1/auth/login`                | POST   | Login (email/password)       | No   |
| `/v1/auth/google`               | POST   | Google sign-in               | No   |
| `/v1/auth/me`                   | GET    | Get profile + credits        | Yes  |
| `/v1/images/upload`             | POST   | Upload image for analysis    | Yes  |
| `/v1/images/{id}`               | GET    | Get image metadata           | Yes  |
| `/v1/images/{id}/analysis`      | GET    | Get analysis results (poll)  | Yes  |
| `/v1/images/{id}/fixes`         | POST   | Create AI fix                | Yes  |
| `/v1/images/{id}/fixes/{fixId}` | GET    | Get fix status/result (poll) | Yes  |
| `/v1/videos/upload`             | POST   | Upload video for analysis    | Yes  |
| `/v1/videos/{id}/analysis`      | GET    | Get analysis results (poll)  | Yes  |
| `/v1/videos/{id}/fixes`         | POST   | Create video fix             | Yes  |
| `/v1/videos/{id}/fixes/{fixId}` | GET    | Get fix status/result (poll) | Yes  |
| `/v1/assets`                    | GET    | List all images + videos     | Yes  |

Full OpenAPI spec available at `/swagger` when running.

## Available Scripts

Run from the `functions/` directory:

| Command                | Description                                  |
| ---------------------- | -------------------------------------------- |
| `npm run dev:emulator` | Run emulators with auto-reload (recommended) |
| `npm run serve`        | Run emulators (one-time build)               |
| `npm run build`        | Compile TypeScript + generate OpenAPI spec   |
| `npm run deploy`       | Deploy to Firebase                           |
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

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file
for details.
