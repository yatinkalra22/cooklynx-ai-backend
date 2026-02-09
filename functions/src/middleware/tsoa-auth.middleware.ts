import {Request} from "express";
import {auth} from "../config/firebase.config";

/**
 * User info attached to authenticated requests
 */
export interface AuthUser {
  uid: string;
  email: string | undefined;
}

/**
 * tsoa authentication handler
 * This is called automatically when a controller method has @Security decorator
 */
export async function expressAuthentication(
  request: Request,
  securityName: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _scopes?: string[]
): Promise<AuthUser> {
  if (securityName === "BearerAuth") {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new Error("No token provided");
    }

    const token = authHeader.split("Bearer ")[1];

    try {
      // First try to verify as Firebase ID token
      const decodedToken = await auth.verifyIdToken(token);
      return {
        uid: decodedToken.uid,
        email: decodedToken.email,
      };
    } catch (idTokenError) {
      // Only allow custom token fallback in development/emulator
      if (
        process.env.FUNCTIONS_EMULATOR === "true" ||
        process.env.NODE_ENV === "development"
      ) {
        try {
          // Custom tokens are JWTs - decode the payload (emulator/testing only)
          const payload = JSON.parse(
            Buffer.from(token.split(".")[1], "base64").toString()
          );
          if (payload.uid) {
            return {
              uid: payload.uid,
              email: payload.email,
            };
          }
        } catch {
          // Ignore decode errors, throw original error
        }
      }
      throw new Error("Invalid token");
    }
  }

  throw new Error("Unknown security scheme");
}
