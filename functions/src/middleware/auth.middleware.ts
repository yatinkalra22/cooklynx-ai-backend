import {Request, Response, NextFunction} from "express";
import {auth} from "../config/firebase.config";

/**
 * Extended Express Request with user data
 */
export interface AuthRequest extends Request {
  user?: {
    uid: string;
    email: string | undefined;
  };
}

/**
 * Middleware to verify Firebase Auth token
 *
 * Usage:
 *   app.get('/protected', requireAuth, (req, res) => {
 *     const userId = req.user.uid;
 *     res.json({ userId });
 *   });
 */
/**
 * @param {AuthRequest} req - Express request with auth token
 * @param {Response} res - Express response object
 * @param {NextFunction} next - Express next middleware function
 * @return {Promise<void>}
 */
export async function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({
        error: "Unauthorized",
        message: "No token provided. Include 'Authorization: Bearer <token>'",
      });
      return;
    }

    // Extract token
    const token = authHeader.split("Bearer ")[1];

    if (!token) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Invalid token format",
      });
      return;
    }

    // Try to verify as ID token first
    let decodedToken;
    try {
      decodedToken = await auth.verifyIdToken(token);
    } catch (idTokenError: unknown) {
      // Only allow custom token fallback in development/emulator
      if (
        process.env.FUNCTIONS_EMULATOR === "true" ||
        process.env.NODE_ENV === "development"
      ) {
        try {
          // For custom tokens, decode without verification (emulator/testing only)
          const parts = token.split(".");
          if (parts.length === 3) {
            const decoded = JSON.parse(
              Buffer.from(parts[1], "base64").toString()
            );
            // Custom tokens have 'uid' in the payload
            if (decoded.uid) {
              // Attach user from custom token
              req.user = {
                uid: decoded.uid,
                email: undefined,
              };
              next();
              return;
            }
          }
        } catch {
          // Fall through to error handling
        }
      }
      // Re-throw the original ID token error
      const err =
        idTokenError instanceof Error
          ? idTokenError
          : new Error(String(idTokenError));
      throw err;
    }

    // Attach user info to request
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
    };

    next();
  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error ? error.message : "Authentication failed";
    console.error("Auth error:", errorMessage);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errorCode = (error as any).code;
    if (errorCode === "auth/id-token-expired") {
      res.status(401).json({
        error: "Token expired",
        message: "Please login again",
      });
      return;
    }

    if (errorCode === "auth/argument-error") {
      res.status(401).json({
        error: "Invalid token",
        message: "Token is malformed or invalid",
      });
      return;
    }

    res.status(401).json({
      error: "Unauthorized",
      message: "Invalid or expired token",
    });
  }
}

/**
 * Optional auth middleware - continues even if no token
 * Sets req.user if token is valid, otherwise req.user is undefined
 */
/**
 * @param {AuthRequest} req - Express request with user
 * @param {Response} res - Express response object
 * @param {NextFunction} next - Express next middleware function
 * @return {Promise<void>}
 */
export async function optionalAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      next();
      return;
    }

    const token = authHeader.split("Bearer ")[1];
    const decodedToken = await auth.verifyIdToken(token);

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
    };

    next();
  } catch (error) {
    // Silent fail - just continue without user
    next();
  }
}
