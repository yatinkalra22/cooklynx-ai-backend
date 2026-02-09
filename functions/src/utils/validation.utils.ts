import validator from "validator";

/**
 * Input validation and sanitization utilities
 */

/**
 * Sanitize display name - removes HTML tags and limits length
 */
export function sanitizeDisplayName(name: string | undefined): string {
  if (!name) {
    throw {
      error: "Bad Request",
      message: "Display name is required",
      status: 400,
    };
  }

  const trimmed = name.trim();

  // Remove HTML tags and entities
  const sanitized = validator.escape(trimmed);

  // Limit length
  const limited = sanitized.substring(0, 50);

  if (!limited || limited.length === 0) {
    throw {
      error: "Bad Request",
      message: "Invalid display name",
      status: 400,
    };
  }

  return limited;
}

/**
 * Sanitize and validate URL
 */
export function sanitizeURL(url: string | undefined): string | null {
  if (!url) return null;

  const trimmed = url.trim();

  // Validate URL format - only allow http(s)
  if (
    !validator.isURL(trimmed, {
      protocols: ["http", "https"],
      require_protocol: true,
    })
  ) {
    throw {
      error: "Bad Request",
      message: "Invalid URL format",
      status: 400,
    };
  }

  // Limit length to prevent abuse
  return trimmed.substring(0, 500);
}

/**
 * Sanitize database key to prevent NoSQL injection
 * Firebase Realtime Database doesn't allow: . $ # [ ] /
 */
export function sanitizeDatabaseKey(key: string): string {
  if (/[.$#[\]/]/.test(key)) {
    throw {
      error: "Bad Request",
      message: "Invalid characters in key",
      status: 400,
    };
  }
  return key;
}

/**
 * Validate password strength
 */
export function validatePasswordStrength(password: string): void {
  if (password.length < 12) {
    throw {
      error: "Bad Request",
      message: "Password must be at least 12 characters long",
      status: 400,
    };
  }

  // Check for at least one lowercase letter
  if (!/[a-z]/.test(password)) {
    throw {
      error: "Bad Request",
      message: "Password must contain at least one lowercase letter",
      status: 400,
    };
  }

  // Check for at least one uppercase letter
  if (!/[A-Z]/.test(password)) {
    throw {
      error: "Bad Request",
      message: "Password must contain at least one uppercase letter",
      status: 400,
    };
  }

  // Check for at least one number
  if (!/[0-9]/.test(password)) {
    throw {
      error: "Bad Request",
      message: "Password must contain at least one number",
      status: 400,
    };
  }
}

/**
 * Redact sensitive data from objects before logging
 */
const SENSITIVE_FIELDS = [
  "password",
  "token",
  "apikey",
  "api_key",
  "secret",
  "authorization",
  "bearer",
  "credentials",
];

export function redactSensitiveData(obj: unknown): unknown {
  if (typeof obj !== "object" || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveData(item));
  }

  const redacted: Record<string, unknown> = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const typedObj = obj as Record<string, unknown>;
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_FIELDS.some((field) => lowerKey.includes(field))) {
        redacted[key] = "[REDACTED]";
      } else if (typeof typedObj[key] === "object") {
        redacted[key] = redactSensitiveData(typedObj[key]);
      } else {
        redacted[key] = typedObj[key];
      }
    }
  }
  return redacted;
}
