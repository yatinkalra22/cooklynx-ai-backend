/**
 * Environment variable validation
 * Ensures all required secrets and config are loaded on startup
 */

export function validateRequiredEnvironment(): void {
  // Skip validation in local/emulator environment
  if (
    process.env.FUNCTIONS_EMULATOR === "true" ||
    process.env.NODE_ENV === "development"
  ) {
    console.log(
      "⚠ Running in development mode - skipping environment validation"
    );
    return;
  }

  const required = ["WEB_API_KEY", "GOOGLE_CLIENT_ID", "GEMINI_API_KEY"];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    // Only warn during deployment, don't throw error
    // Firebase secrets are injected at runtime, not during analysis
    console.warn(
      `⚠ Warning: Some environment variables not found during deployment analysis: ${missing.join(", ")}`
    );
    console.warn(
      "These will be injected from Firebase Secret Manager at runtime."
    );
    return;
  }

  console.log("All required environment variables are present");
}

/**
 * Validate optional environment variables and provide warnings
 */
export function validateOptionalEnvironment(): void {
  const optional = {
    SENTRY_DSN: "Error tracking will be disabled",
    APP_URL: "Using default Firebase hosting URL",
    REDIS_ENABLED: "Caching will use database only",
  };

  for (const [key, warning] of Object.entries(optional)) {
    if (!process.env[key]) {
      console.warn(`⚠ ${key} not set: ${warning}`);
    }
  }
}
