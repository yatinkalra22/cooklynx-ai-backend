import {database} from "../config/firebase.config";
import {randomUUID} from "crypto";
import * as crypto from "crypto";
import * as logger from "firebase-functions/logger";

/**
 * Session management service for tracking active user sessions
 * Enables logout, device tracking, and token revocation
 */

export interface SessionInfo {
  sessionId: string;
  deviceFingerprint: string;
  ip: string;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
}

export class SessionService {
  /**
   * Create a new session for a user
   */
  static async createSession(
    userId: string,
    ip: string,
    userAgent: string
  ): Promise<string> {
    const sessionId = randomUUID();
    const deviceFingerprint = this.generateDeviceFingerprint(ip, userAgent);
    const now = new Date().toISOString();

    const sessionData: SessionInfo = {
      sessionId,
      deviceFingerprint,
      ip,
      userAgent: userAgent.substring(0, 200), // Limit length
      createdAt: now,
      lastSeenAt: now,
    };

    await database.ref(`sessions/${userId}/${sessionId}`).set(sessionData);

    return sessionId;
  }

  /**
   * Verify session exists and is valid
   */
  static async verifySession(
    userId: string,
    sessionId: string,
    ip: string,
    userAgent: string
  ): Promise<boolean> {
    const sessionSnapshot = await database
      .ref(`sessions/${userId}/${sessionId}`)
      .get();

    if (!sessionSnapshot.exists()) {
      return false;
    }

    const session = sessionSnapshot.val() as SessionInfo;

    // Check device fingerprint
    const currentFingerprint = this.generateDeviceFingerprint(ip, userAgent);
    if (currentFingerprint !== session.deviceFingerprint) {
      logger.warn("Device fingerprint mismatch", {
        userId,
        sessionId,
        expected: session.deviceFingerprint,
        actual: currentFingerprint,
      });
      // Log but don't reject - user might be on different network
    }

    // Update last seen timestamp
    await database
      .ref(`sessions/${userId}/${sessionId}/lastSeenAt`)
      .set(new Date().toISOString());

    return true;
  }

  /**
   * Delete a specific session (logout)
   */
  static async deleteSession(userId: string, sessionId: string): Promise<void> {
    await database.ref(`sessions/${userId}/${sessionId}`).remove();
  }

  /**
   * Delete all sessions for a user (logout from all devices)
   */
  static async deleteAllSessions(userId: string): Promise<void> {
    await database.ref(`sessions/${userId}`).remove();
  }

  /**
   * Get all active sessions for a user
   */
  static async getUserSessions(userId: string): Promise<SessionInfo[]> {
    const sessionsSnapshot = await database.ref(`sessions/${userId}`).get();

    if (!sessionsSnapshot.exists()) {
      return [];
    }

    const sessions: SessionInfo[] = [];
    sessionsSnapshot.forEach((child) => {
      sessions.push(child.val() as SessionInfo);
    });

    return sessions;
  }

  /**
   * Clean up old sessions (older than 30 days)
   */
  static async cleanupOldSessions(userId: string): Promise<void> {
    const sessions = await this.getUserSessions(userId);
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

    for (const session of sessions) {
      const lastSeen = new Date(session.lastSeenAt).getTime();
      if (lastSeen < thirtyDaysAgo) {
        await this.deleteSession(userId, session.sessionId);
      }
    }
  }

  /**
   * Generate device fingerprint from IP and user agent
   */
  private static generateDeviceFingerprint(
    ip: string,
    userAgent: string
  ): string {
    return crypto
      .createHash("sha256")
      .update(`${ip}:${userAgent}`)
      .digest("hex");
  }
}
