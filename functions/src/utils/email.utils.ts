import {EMAIL_REGEX, ALIASING_PROVIDERS} from "../config/constants";

/**
 * Validate email format using RFC 5322 compliant regex
 */
export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

/**
 * Normalize email to prevent aliasing abuse
 * - Converts to lowercase
 * - For Gmail/Outlook: removes dots and plus-addressing
 * - Returns canonical form for duplicate detection
 */
export function normalizeEmail(email: string): string {
  const [localPart, domain] = email.toLowerCase().trim().split("@");

  if (!domain) return email.toLowerCase();

  // Check if it's a provider that supports aliasing
  const isAliasingProvider = ALIASING_PROVIDERS.includes(domain);

  if (isAliasingProvider) {
    // Remove everything after + (plus addressing)
    const cleanLocal = localPart.split("+")[0];
    // Remove all dots (Gmail ignores dots)
    const normalizedLocal = cleanLocal.replace(/\./g, "");
    return `${normalizedLocal}@${domain}`;
  }

  // For other providers, just lowercase
  return `${localPart}@${domain}`;
}

/**
 * Validate and normalize email
 * Throws error if invalid format
 */
export function validateAndNormalizeEmail(email: string): {
  original: string;
  normalized: string;
} {
  const trimmed = email.trim();

  if (!isValidEmail(trimmed)) {
    throw {
      error: "Bad Request",
      message: "Invalid email format",
      status: 400,
    };
  }

  return {
    original: trimmed.toLowerCase(),
    normalized: normalizeEmail(trimmed),
  };
}
