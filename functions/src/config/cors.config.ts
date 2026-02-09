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

  // Development origins
  "http://localhost:3000",
  "http://localhost:8081",
  "exp://localhost:8081",
];

// Add additional origins from environment variable
if (process.env.ALLOWED_ORIGINS) {
  const envOrigins = process.env.ALLOWED_ORIGINS.split(",").map((o) =>
    o.trim()
  );
  allowedOrigins.push(...envOrigins);
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
    } else {
      logger.warn("CORS blocked request from origin:", origin);
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true, // Allow cookies
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-request-id",
    "x-skip-cache",
  ],
  exposedHeaders: ["x-request-id", "RateLimit-Limit", "RateLimit-Remaining"],
  maxAge: 600, // Preflight cache 10 minutes
};
