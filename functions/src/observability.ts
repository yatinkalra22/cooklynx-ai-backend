import type express from "express";
import * as Sentry from "@sentry/node";
import {nodeProfilingIntegration} from "@sentry/profiling-node";

let sentryEnabled = false;

export const initObservability = (app: express.Express): void => {
  const dsn = process.env.SENTRY_DSN;
  const isEmulator = process.env.FUNCTIONS_EMULATOR === "true";

  // Skip Sentry in local emulator mode
  if (!dsn || isEmulator) return;

  Sentry.init({
    dsn,
    integrations: [Sentry.expressIntegration(), nodeProfilingIntegration()],
    tracesSampleRate: parseFloat(
      process.env.SENTRY_TRACES_SAMPLE_RATE || "0.1"
    ),
    profilesSampleRate: parseFloat(
      process.env.SENTRY_PROFILES_SAMPLE_RATE || "0.1"
    ),
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    release: process.env.SENTRY_RELEASE,
  });

  // Setup request handlers - must be first middleware
  Sentry.setupExpressErrorHandler(app);

  sentryEnabled = true;
};

export const sentryErrorHandler = () =>
  sentryEnabled
    ? Sentry.expressErrorHandler()
    : // eslint-disable-next-line @typescript-eslint/no-unused-vars
      (
        err: unknown,
        _req: express.Request,
        _res: express.Response,
        next: express.NextFunction
      ) => next();

export const captureException = (
  err: unknown,
  context?: Record<string, unknown>
): void => {
  if (!sentryEnabled) return;
  if (context) {
    Sentry.captureException(err, {extra: context});
    return;
  }
  Sentry.captureException(err);
};
