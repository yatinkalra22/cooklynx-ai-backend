import {database} from "../config/firebase.config";
import {MAX_CONTENT_VIOLATIONS, FREE_CREDIT_LIMIT} from "../config/constants";
import {CreditTransactionType, CreditLedgerEntry} from "../types/api.types";

export type UserPhotoCounterDeltas = {
  totalPhotos?: number;
  totalPhotoCompleted?: number;
  totalPhotoFailed?: number;
};

export class UserService {
  /**
   * Atomically increment user photo counters in Realtime Database.
   * Creates counters if missing (defaults to 0) and applies deltas.
   */
  static async incrementUserPhotoCounters(
    userId: string,
    deltas: UserPhotoCounterDeltas
  ): Promise<void> {
    const ops: Array<Promise<unknown>> = [];

    const applyTxn = (path: string, by: number) =>
      database
        .ref(`users/${userId}/${path}`)
        .transaction((current: unknown) => {
          const currNum = typeof current === "number" ? current : 0;
          return currNum + by;
        });

    if (deltas.totalPhotos) {
      ops.push(applyTxn("totalPhotos", deltas.totalPhotos));
    }
    if (deltas.totalPhotoCompleted) {
      ops.push(applyTxn("totalPhotoCompleted", deltas.totalPhotoCompleted));
    }
    if (deltas.totalPhotoFailed) {
      ops.push(applyTxn("totalPhotoFailed", deltas.totalPhotoFailed));
    }

    if (ops.length === 0) return;
    await Promise.all(ops);
  }

  /**
   * Record a content policy violation for a user.
   * Returns the new violation count.
   */
  static async recordContentViolation(
    userId: string,
    category: string
  ): Promise<number> {
    // Increment violation count atomically
    const result = await database
      .ref(`users/${userId}/contentViolations/count`)
      .transaction((current: unknown) => {
        const currNum = typeof current === "number" ? current : 0;
        return currNum + 1;
      });

    const newCount = result.snapshot.val() as number;

    // Log the violation with timestamp
    await database.ref(`users/${userId}/contentViolations/history`).push({
      category,
      timestamp: new Date().toISOString(),
    });

    // If user has reached max violations, mark account as blocked
    if (newCount >= MAX_CONTENT_VIOLATIONS) {
      await database.ref(`users/${userId}/contentViolations/blocked`).set(true);
      await database
        .ref(`users/${userId}/contentViolations/blockedAt`)
        .set(new Date().toISOString());
    }

    return newCount;
  }

  /**
   * Check if a user is blocked due to content violations.
   */
  static async isUserBlocked(userId: string): Promise<boolean> {
    const snapshot = await database
      .ref(`users/${userId}/contentViolations/blocked`)
      .get();
    return snapshot.val() === true;
  }

  /**
   * Get user's content violation count.
   */
  static async getViolationCount(userId: string): Promise<number> {
    const snapshot = await database
      .ref(`users/${userId}/contentViolations/count`)
      .get();
    return (snapshot.val() as number) || 0;
  }

  /**
   * Get user's credit information.
   * Returns both credit (consumed) and creditLimit (max allowed).
   * Reads creditLimit from subscription node, falls back to FREE_CREDIT_LIMIT.
   */
  static async getCredits(
    userId: string
  ): Promise<{credit: number; creditLimit: number}> {
    const userRef = database.ref(`users/${userId}`);
    const snapshot = await userRef.get();

    let credit = 0;
    let creditLimit = FREE_CREDIT_LIMIT;

    if (snapshot.exists()) {
      const userData = snapshot.val();
      credit = typeof userData.credit === "number" ? userData.credit : 0;
      creditLimit =
        typeof userData.creditLimit === "number"
          ? userData.creditLimit
          : FREE_CREDIT_LIMIT;
    }

    return {credit, creditLimit};
  }

  /**
   * Atomically reserve credits for an operation.
   * Checks availability AND deducts in a single RTDB transaction,
   * eliminating the TOCTOU race condition.
   * Credit limit is read from user's subscription (set by RevenueCat sync).
   * Returns remaining credits after reservation.
   * @param userId - The user's ID
   * @param amount - Number of credits to reserve
   * @param type - The type of credit transaction
   * @param resourceId - Identifier for the resource being charged
   */
  static async reserveCredits(
    userId: string,
    amount: number,
    type: CreditTransactionType,
    resourceId: string
  ): Promise<number> {
    // Read creditLimit first (safe — set by subscription sync, not subject to races)
    const limitSnapshot = await database
      .ref(`users/${userId}/creditLimit`)
      .get();
    const creditLimit = limitSnapshot.exists()
      ? (limitSnapshot.val() as number)
      : FREE_CREDIT_LIMIT;

    // Atomic transaction: check + deduct in one step
    const result = await database
      .ref(`users/${userId}/credit`)
      .transaction((current: unknown) => {
        const currCredit = typeof current === "number" ? current : 0;
        const remaining = creditLimit - currCredit;

        if (remaining < amount) {
          // Abort transaction by returning undefined
          return undefined;
        }

        return currCredit + amount;
      });

    if (!result.committed) {
      // Transaction was aborted — not enough credits
      const currentCredit =
        typeof result.snapshot.val() === "number" ? result.snapshot.val() : 0;
      const remaining = Math.max(0, creditLimit - currentCredit);
      throw {
        error: "Credit Limit Reached",
        message: `Not enough credits. Required: ${amount}, Available: ${remaining}. Upgrade your plan for more credits.`,
      };
    }

    const newCredit = result.snapshot.val() as number;
    const remaining = Math.max(0, creditLimit - newCredit);

    // Fire-and-forget audit log
    this.logCreditTransaction(userId, {
      type,
      amount,
      resourceId,
      timestamp: new Date().toISOString(),
      creditAfter: newCredit,
    }).catch(() => {});

    return remaining;
  }

  /**
   * Log a credit transaction to the user's ledger (fire-and-forget).
   */
  private static async logCreditTransaction(
    userId: string,
    entry: CreditLedgerEntry
  ): Promise<void> {
    await database.ref(`users/${userId}/creditLedger`).push(entry);
  }
}
