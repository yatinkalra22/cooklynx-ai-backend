import {UserRecord} from "firebase-admin/auth";
import {auth, database} from "../config/firebase.config";
import {LoginSuccessResponse} from "../types/api.types";
import {SessionService} from "./session.service";
import {PreferenceService} from "./preference.service";

export interface IssueTokenOptions {
  /** The Firebase user record */
  userRecord: UserRecord;
  /** Custom message for the response */
  message?: string;
  /** Additional profile data from the database to include in response */
  profileData?: Record<string, unknown>;
  /** User IP address for session tracking */
  ip?: string;
  /** User agent for session tracking */
  userAgent?: string;
}

/**
 * Issues a custom token and returns a standardized login success response.
 * This is reusable across all authentication methods (email/password, Google, Apple, etc.)
 *
 * - Generates a Firebase custom token
 * - Updates lastLoginAt in the database
 * - Syncs emailVerified status if needed
 * - Returns a consistent response structure
 */
export async function issueAuthToken(
  options: IssueTokenOptions
): Promise<LoginSuccessResponse> {
  const {
    userRecord,
    message = "Login successful",
    profileData = {},
    ip = "unknown",
    userAgent = "unknown",
  } = options;

  // Create session for tracking
  const sessionId = await SessionService.createSession(
    userRecord.uid,
    ip,
    userAgent
  );

  // Generate custom token with session ID in claims
  const customToken = await auth.createCustomToken(userRecord.uid, {
    sessionId,
  });

  const now = new Date().toISOString();

  // Update lastLoginAt and sync emailVerified status if needed
  const updates: Record<string, unknown> = {
    lastLoginAt: now,
  };

  // Sync emailVerified status to database if user is verified but DB isn't updated
  if (userRecord.emailVerified && !profileData?.emailVerified) {
    updates.emailVerified = true;
    updates.verifiedAt = now;
  }

  await database.ref(`users/${userRecord.uid}`).update(updates);

  // Check if user has completed onboarding (set food preferences)
  const hasCompletedOnboarding = await PreferenceService.hasCompletedOnboarding(
    userRecord.uid
  );

  return {
    message,
    user: {
      uid: userRecord.uid,
      email: userRecord.email!,
      displayName: userRecord.displayName || null,
      photoURL: userRecord.photoURL || undefined,
      emailVerified: userRecord.emailVerified,
      hasCompletedOnboarding,
      ...profileData,
    },
    token: customToken,
  };
}
