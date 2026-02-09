import {FIREBASE_IDENTITY_TOOLKIT_URL} from "../config/constants";
import axios from "axios";

/**
 * Verify user password using Firebase Auth REST API
 * This is the secure way to verify passwords server-side
 */
export async function verifyPasswordWithFirebase(
  email: string,
  password: string
): Promise<{success: boolean; localId?: string; error?: string}> {
  const apiKey = process.env.WEB_API_KEY;

  if (!apiKey) {
    throw new Error("WEB_API_KEY is not configured");
  }

  try {
    const {data} = await axios.post(
      `${FIREBASE_IDENTITY_TOOLKIT_URL}?key=${apiKey}`,
      {
        email,
        password,
        returnSecureToken: true,
      },
      {
        headers: {"Content-Type": "application/json"},
        timeout: 5000,
      }
    );

    return {success: true, localId: data.localId};
  } catch (err: unknown) {
    const error = err as {response?: {data?: {error?: {message?: string}}}};
    const message =
      error.response?.data?.error?.message || "Authentication failed";
    return {success: false, error: message};
  }
}
