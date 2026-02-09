import {auth} from "../config/firebase.config";

/**
 * Email service for sending verification and notification emails
 */

interface EmailVerificationOptions {
  email: string;
  returnUrl?: string;
}

/**
 * Generate verification link for email verification
 *
 * NOTE: This function only generates the link but does NOT send the email from the backend.
 * Firebase's admin.auth().generateSignInWithEmailLink() is a client-side only method
 * for passwordless sign-in. It does not automatically send emails when called from the backend.
 *
 * Reference: https://firebase.google.com/docs/auth/custom-email-handler
 * The email template configured in Firebase Console is only used when calling
 * sendSignInLinkToEmail() from the client-side Firebase Auth SDK.
 *
 * RECOMMENDED APPROACH (Client-Side):
 * Instead of calling this from the backend, instruct the frontend to:
 * 1. User signs up via POST /v1/auth/signup (backend creates account)
 * 2. Backend responds with { requiresEmailVerification: true }
 * 3. Frontend redirects to verification screen
 * 4. Frontend calls Firebase Auth SDK client-side:
 *    import { sendSignInLinkToEmail } from "firebase/auth";
 *    await sendSignInLinkToEmail(auth, email, {
 *      url: 'https://yourapp.com/verify',
 *      handleCodeInApp: true
 *    });
 * 5. Firebase automatically sends email using the configured template
 * 6. User clicks link in email → email verified
 *
 * ALTERNATIVE: For backend email sending, integrate with SendGrid, AWS SES, or
 * use Google Cloud Tasks with Cloud Functions to send emails asynchronously.
 */
export async function sendVerificationEmail(
  options: EmailVerificationOptions
): Promise<void> {
  const {email, returnUrl} = options;

  // Generate sign-in link (for reference/logging only)
  // This does NOT send the email - see documentation above
  const actionCodeSettings = {
    url:
      returnUrl ||
      process.env.APP_URL ||
      "https://cooklynx-ai.firebaseapp.com",
    handleCodeInApp: true,
  };

  try {
    // Generate link for logging purposes only (never expose to clients)
    await auth.generateSignInWithEmailLink(email, actionCodeSettings);
    // Log sanitized version only (never log the actual link - contains token)
    const maskedEmail = email.replace(/(?<=.{2}).*(?=@)/, "***");
    console.log(`Verification link generated for: ${maskedEmail}`);
  } catch (error: unknown) {
    const maskedEmail = email.replace(/(?<=.{2}).*(?=@)/, "***");
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(
      `Failed to generate verification link for ${maskedEmail}:`,
      errorMessage
    );
    throw error;
  }
}
