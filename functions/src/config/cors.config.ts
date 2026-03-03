/**
 * CORS configuration for API security
 */
import * as logger from "firebase-functions/logger";

// Allowed origins for CORS
const allowedOrigins = [
  // Production domains
  "https://cooklynx-ai.firebaseapp.com",
  "https://cooklynx-ai.web.app",
  "https://cooklynx-ai.vercel.app",
  "https://cooklynx-ai-app.vercel.app",

  // Development origins
  "http://localhost:3000",
  "http://localhost:8081",
  "exp://localhost:8081",
  "http://10.0.2.2:5001",
  "http://10.0.2.2:8081",
];

// Pattern-based origins for dynamic preview/deployment URLs
const allowedOriginPatterns: RegExp[] = [
  /^https:\/\/([a-z0-9-]+\.)?vercel\.app$/i,
  /^https:\/\/us-central1-[a-z0-9-]+\.cloudfunctions\.net$/i,
  /^https:\/\/[a-z0-9-]+-uc\.a\.run\.app$/i,
];

// Add additional origins from environment variable
if (process.env.ALLOWED_ORIGINS) {
  const envOrigins = process.env.ALLOWED_ORIGINS.split(",").map((o) =>
    o.trim()
  );
  allowedOrigins.push(...envOrigins);
}

if (process.env.APP_URL) {
  allowedOrigins.push(process.env.APP_URL.trim());
}

// Allow emulator origins in development
if (process.env.NODE_ENV === "development" || process.env.FUNCTIONS_EMULATOR) {
  allowedOrigins.push("http://localhost:5001");
  allowedOrigins.push("http://127.0.0.1:5001");
}

export const corsOptions = {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ) => {
    // Allow requests with no origin (mobile apps, Postman, server-to-server)
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else if (allowedOriginPatterns.some((pattern) => pattern.test(origin))) {
      callback(null, true);
    } else {
      logger.warn("CORS blocked request from origin:", origin);
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true, // Allow cookies
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Accept",
    "Origin",
    "Authorization",
    "X-Requested-With",
    "x-request-id",
    "x-skip-cache",
    "x-client-version",
  ],
  exposedHeaders: ["x-request-id", "RateLimit-Limit", "RateLimit-Remaining"],
  maxAge: 600, // Preflight cache 10 minutes
};
