import {
  Body,
  Controller,
  Delete,
  Get,
  Hidden,
  Patch,
  Post,
  Request,
  Response,
  Route,
  Security,
  SuccessResponse,
  Tags,
} from "tsoa";
import {Request as ExpressRequest} from "express";
import {auth, database} from "../config/firebase.config";
import {OAuth2Client} from "google-auth-library";
import {
  SignupRequest,
  SignupResponse,
  LoginRequest,
  LoginResponse,
  GoogleSignInRequest,
  ProfileUpdateRequest,
  ProfileUpdateResponse,
  ProfileResponse,
  DeleteAccountResponse,
  ErrorResponse,
  ResendVerificationRequest,
  ResendVerificationResponse,
} from "../types/api.types";
import {AuthUser} from "../middleware/tsoa-auth.middleware";
import {validateAndNormalizeEmail} from "../utils/email.utils";
import {verifyPasswordWithFirebase} from "../utils/auth.utils";
import {sendVerificationEmail} from "../services/email.service";
import {issueAuthToken} from "../services/auth.service";
import {
  MIN_PASSWORD_LENGTH,
  MAX_VERIFICATION_ATTEMPTS,
  COOLDOWN_HOURS,
  COOLDOWN_MS,
  FIREBASE_ERROR_CODES,
  HTTP_STATUS,
} from "../config/constants";
import {UserService} from "../services/user.service";
import {
  validatePasswordStrength,
  sanitizeDisplayName,
  sanitizeURL,
} from "../utils/validation.utils";
import {SessionService} from "../services/session.service";

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

@Route("v1/auth")
@Tags("Auth")
export class AuthController extends Controller {
  /**
   * Create a new user account. A verification email will be sent.
   * @summary Sign up with email and password
   * @param requestBody User registration details
   */
  @Post("signup")
  @SuccessResponse(201, "User created successfully")
  @Response<ErrorResponse>(400, "Bad Request - validation error")
  @Response<ErrorResponse>(409, "Email already registered")
  @Response<ErrorResponse>(500, "Internal server error")
  public async signup(
    @Body() requestBody: SignupRequest
  ): Promise<SignupResponse> {
    const {email, password, displayName} = requestBody;

    // Validation
    if (!email || !password) {
      this.setStatus(HTTP_STATUS.BAD_REQUEST);
      throw {error: "Bad Request", message: "Email and password are required"};
    }

    // Validate and normalize email
    let normalizedEmail: string;
    let originalEmail: string;
    try {
      const emailResult = validateAndNormalizeEmail(email);
      originalEmail = emailResult.original;
      normalizedEmail = emailResult.normalized;
    } catch (err: unknown) {
      const error = err as {status?: number; error?: string; message?: string};
      this.setStatus(error.status || HTTP_STATUS.BAD_REQUEST);
      throw err;
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      this.setStatus(HTTP_STATUS.BAD_REQUEST);
      throw {
        error: "Bad Request",
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      };
    }

    // Validate password strength
    try {
      validatePasswordStrength(password);
    } catch (err: unknown) {
      const error = err as {status?: number; error?: string; message?: string};
      this.setStatus(error.status || HTTP_STATUS.BAD_REQUEST);
      throw err;
    }

    // Sanitize display name if provided
    const sanitizedDisplayName = displayName
      ? sanitizeDisplayName(displayName)
      : originalEmail.split("@")[0];

    try {
      // Create user in Firebase Auth with original email
      const userRecord = await auth.createUser({
        email: originalEmail,
        password,
        displayName: sanitizedDisplayName,
        emailVerified: false,
      });

      // Create user profile in Realtime Database
      // Store both original and normalized email for duplicate detection
      const now = new Date().toISOString();
      await database.ref(`users/${userRecord.uid}`).set({
        email: userRecord.email,
        normalizedEmail,
        displayName: userRecord.displayName,
        createdAt: now,
        photoURL: null,
        emailVerified: userRecord.emailVerified,
        ...(userRecord.emailVerified && {verifiedAt: now}),
        metadata: {
          signupMethod: "email",
        },
        // Track verification email attempts for rate limiting
        verificationAttempts: {
          count: 0,
          lastAttemptAt: null,
          resetAt: null,
        },
      });

      // Send verification email with magic link
      // NOTE: Currently generates link but does not send email (see email.service.ts)
      // Frontend must call Firebase SDK's sendSignInLinkToEmail() to trigger the email
      try {
        await sendVerificationEmail({
          email: userRecord.email!,
        });
      } catch (emailError) {
        // Log error but don't fail signup - user can request resend later
        console.error("Failed to generate verification link:", emailError);
      }

      this.setStatus(HTTP_STATUS.CREATED);

      return {
        message: "User created successfully. Please verify your email.",
        user: {
          uid: userRecord.uid,
          email: userRecord.email!,
          displayName: userRecord.displayName || null,
          emailVerified: false,
        },
        requiresEmailVerification: true,
      };
    } catch (error: unknown) {
      const code = (error as {code?: string}).code;

      if (code === FIREBASE_ERROR_CODES.EMAIL_ALREADY_EXISTS) {
        // Check if the existing user is verified
        try {
          const existingUser = await auth.getUserByEmail(email);
          if (existingUser.emailVerified) {
            this.setStatus(HTTP_STATUS.CONFLICT);
            throw {
              error: "Conflict",
              message: "Email already registered. Please login instead.",
            };
          } else {
            // User exists but not verified - they need to verify their email
            this.setStatus(HTTP_STATUS.CONFLICT);
            throw {
              error: "Conflict",
              message:
                "Email already registered but not verified. " +
                "Please check your email for the verification link.",
              requiresVerification: true,
            };
          }
        } catch (innerError: unknown) {
          // If it's our custom error, re-throw it
          if ((innerError as {error?: string}).error) {
            throw innerError;
          }
          // Otherwise, generic conflict error
          this.setStatus(HTTP_STATUS.CONFLICT);
          throw {error: "Conflict", message: "Email already registered"};
        }
      }

      if (code === FIREBASE_ERROR_CODES.INVALID_EMAIL) {
        this.setStatus(HTTP_STATUS.BAD_REQUEST);
        throw {error: "Bad Request", message: "Invalid email format"};
      }

      this.setStatus(HTTP_STATUS.INTERNAL_SERVER_ERROR);
      throw {error: "Internal Server Error", message: "Failed to create user"};
    }
  }

  /**
   * Login with email and password.
   * If email not verified, returns verification status with rate-limited email sending.
   * @summary Login with email and password
   * @param requestBody User login credentials
   */
  @Post("login")
  @Response<ErrorResponse>(400, "Email and password are required")
  @Response<ErrorResponse>(401, "Invalid credentials")
  @Response<ErrorResponse>(404, "User not found")
  @Response<ErrorResponse>(500, "Internal server error")
  public async login(
    @Body() requestBody: LoginRequest,
    @Request() request: ExpressRequest
  ): Promise<LoginResponse> {
    const {email, password} = requestBody;

    if (!email || !password) {
      this.setStatus(HTTP_STATUS.BAD_REQUEST);
      throw {error: "Bad Request", message: "Email and password are required"};
    }

    try {
      // IMPORTANT: Verify password FIRST before revealing verification status
      const passwordResult = await verifyPasswordWithFirebase(email, password);
      if (!passwordResult.success) {
        // Check if user doesn't exist vs wrong password
        if (passwordResult.error === "EMAIL_NOT_FOUND") {
          this.setStatus(HTTP_STATUS.NOT_FOUND);
          throw {error: "Not Found", message: "User not found"};
        }
        this.setStatus(HTTP_STATUS.UNAUTHORIZED);
        throw {error: "Unauthorized", message: "Invalid email or password"};
      }

      const userRecord = await auth.getUserByEmail(email);

      // Check if user is blocked due to content violations
      const isBlocked = await UserService.isUserBlocked(userRecord.uid);
      if (isBlocked) {
        this.setStatus(HTTP_STATUS.FORBIDDEN);
        throw {
          error: "Forbidden",
          message:
            "Your account has been suspended due to repeated content policy violations.",
        };
      }

      // Get user profile from database
      const userSnapshot = await database.ref(`users/${userRecord.uid}`).get();
      const userProfile = userSnapshot.val() || {};

      // If email is not verified, return a simple status and let UI redirect
      if (!userRecord.emailVerified) {
        this.setStatus(HTTP_STATUS.OK);
        return {
          message: "Email not verified!",
          requiresVerification: true,
          emailSent: false,
        };
      }

      // Auth service to issue token and return response
      return await issueAuthToken({
        userRecord,
        message: "Login successful",
        profileData: userProfile,
        ip: request.ip || "unknown",
        userAgent: request.get("user-agent") || "unknown",
      });
    } catch (error: unknown) {
      // Re-throw our custom errors
      if ((error as {error?: string}).error) {
        throw error;
      }

      this.setStatus(HTTP_STATUS.INTERNAL_SERVER_ERROR);
      throw {error: "Internal Server Error", message: "Login failed"};
    }
  }

  /**
   * Authenticate using Google Sign-In
   * @summary Sign in with Google
   * @param requestBody Google ID token from client
   */
  @Post("google")
  @Response<ErrorResponse>(400, "Google ID token is required")
  @Response<ErrorResponse>(401, "Invalid Google token")
  @Response<ErrorResponse>(500, "Internal server error")
  public async googleSignIn(
    @Body() requestBody: GoogleSignInRequest,
    @Request() request: ExpressRequest
  ): Promise<LoginResponse> {
    const {idToken} = requestBody;

    if (!idToken) {
      this.setStatus(HTTP_STATUS.BAD_REQUEST);
      throw {error: "Bad Request", message: "Google ID token is required"};
    }

    try {
      // Verify Google ID token
      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });

      const payload = ticket.getPayload();

      if (!payload) {
        this.setStatus(HTTP_STATUS.UNAUTHORIZED);
        throw {error: "Unauthorized", message: "Invalid Google token"};
      }

      const {
        sub: googleId,
        email,
        name: displayName,
        picture: photoURL,
      } = payload;

      // Check if user exists in Firebase Auth
      let userRecord;
      try {
        userRecord = await auth.getUserByEmail(email!);

        // Check if existing user is blocked
        const isBlocked = await UserService.isUserBlocked(userRecord.uid);
        if (isBlocked) {
          this.setStatus(HTTP_STATUS.FORBIDDEN);
          throw {
            error: "Forbidden",
            message:
              "Your account has been suspended due to repeated content policy violations.",
          };
        }
      } catch (error: unknown) {
        // Re-throw our custom Forbidden error
        if ((error as {error?: string}).error === "Forbidden") {
          throw error;
        }

        const code = (error as {code?: string}).code;
        // User doesn't exist, create new user
        if (code === "auth/user-not-found") {
          userRecord = await auth.createUser({
            email,
            displayName,
            photoURL,
            emailVerified: true,
          });

          // Create user profile in database
          await database.ref(`users/${userRecord.uid}`).set({
            email,
            displayName,
            photoURL,
            createdAt: new Date().toISOString(),
            emailVerified: true,
            metadata: {
              signupMethod: "google",
              googleId,
            },
          });
        } else {
          throw error;
        }
      }

      // Get user profile from database for consistent response
      const userSnapshot = await database.ref(`users/${userRecord.uid}`).get();
      const userProfile = userSnapshot.val() || {};

      // Auth service to issue token and return response
      return await issueAuthToken({
        userRecord,
        message: "Google sign-in successful",
        profileData: userProfile,
        ip: request.ip || "unknown",
        userAgent: request.get("user-agent") || "unknown",
      });
    } catch (error: unknown) {
      const errType = (error as {error?: string}).error;
      // Re-throw custom errors (Unauthorized, Forbidden)
      if (errType === "Unauthorized" || errType === "Forbidden") {
        throw error;
      }
      this.setStatus(HTTP_STATUS.INTERNAL_SERVER_ERROR);
      throw {error: "Internal Server Error", message: "Google sign-in failed"};
    }
  }

  /**
   * Resend verification email with rate limiting
   * @summary Resend email verification link
   * @param requestBody Email to resend the verification to
   */
  @Post("verification/resend")
  @Response<ErrorResponse>(400, "Email is required")
  @Response<ErrorResponse>(404, "User not found")
  @Response<ErrorResponse>(500, "Internal server error")
  public async resendVerification(
    @Body() requestBody: ResendVerificationRequest
  ): Promise<ResendVerificationResponse> {
    const {email} = requestBody;

    if (!email) {
      this.setStatus(HTTP_STATUS.BAD_REQUEST);
      throw {error: "Bad Request", message: "Email is required"};
    }

    try {
      // Locate user
      const userRecord = await auth.getUserByEmail(email);

      // Get profile
      const userSnapshot = await database.ref(`users/${userRecord.uid}`).get();
      const userProfile = userSnapshot.val() || {};

      // If already verified, no need to resend
      if (userRecord.emailVerified) {
        this.setStatus(HTTP_STATUS.OK);
        return {
          message: "Email already verified",
          emailVerified: true,
          canResend: false,
        };
      }

      // Rate limiting state
      const verificationAttempts = userProfile.verificationAttempts || {
        count: 0,
        lastAttemptAt: null,
        resetAt: null,
      };

      const now = Date.now();

      // Reset cooldown if expired
      if (verificationAttempts.resetAt) {
        const resetTime = new Date(verificationAttempts.resetAt).getTime();
        if (now >= resetTime) {
          verificationAttempts.count = 0;
          verificationAttempts.resetAt = null;
        }
      }

      // If rate limited, return timing
      if (verificationAttempts.count >= MAX_VERIFICATION_ATTEMPTS) {
        this.setStatus(HTTP_STATUS.OK);
        return {
          message: `Too many verification emails sent. Please try again after ${COOLDOWN_HOURS} hours.`,
          emailVerified: false,
          canResend: false,
          attemptsRemaining: 0,
          retryAfter: verificationAttempts.resetAt,
        };
      }

      // Increment and persist attempt counters
      const newCount = verificationAttempts.count + 1;
      const attemptsRemaining = MAX_VERIFICATION_ATTEMPTS - newCount;
      const resetAt =
        newCount >= MAX_VERIFICATION_ATTEMPTS
          ? new Date(now + COOLDOWN_MS).toISOString()
          : verificationAttempts.resetAt;

      await database.ref(`users/${userRecord.uid}/verificationAttempts`).set({
        count: newCount,
        lastAttemptAt: new Date().toISOString(),
        resetAt: resetAt,
      });

      // Trigger Firebase email send (magic link)
      await sendVerificationEmail({email: userRecord.email!});

      this.setStatus(HTTP_STATUS.OK);
      return {
        message:
          attemptsRemaining > 0
            ? `Verification email sent. ${attemptsRemaining} attempt(s) remaining.`
            : "Final verification email sent. Wait 2 hours before requesting again.",
        emailVerified: false,
        canResend: attemptsRemaining > 0,
        attemptsRemaining,
        ...(resetAt && {retryAfter: resetAt}),
      };
    } catch (error: unknown) {
      if (
        (error as {code?: string}).code === FIREBASE_ERROR_CODES.USER_NOT_FOUND
      ) {
        this.setStatus(HTTP_STATUS.NOT_FOUND);
        throw {error: "Not Found", message: "User not found"};
      }

      this.setStatus(HTTP_STATUS.INTERNAL_SERVER_ERROR);
      throw {
        error: "Internal Server Error",
        message: "Failed to resend verification email",
      };
    }
  }

  /**
   * Apple Sign-In (placeholder for future implementation)
   * @summary Sign in with Apple (Coming Soon)
   */
  @Post("apple")
  @Response<ErrorResponse>(501, "Not implemented")
  public async appleSignIn(): Promise<ErrorResponse> {
    this.setStatus(HTTP_STATUS.NOT_IMPLEMENTED);
    return {
      error: "Not Implemented",
      message: "Apple Sign-In coming soon",
    };
  }

  /**
   * Get authenticated user's profile
   * @summary Get current user profile
   */
  @Get("me")
  @Security("BearerAuth")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(500, "Internal server error")
  public async getProfile(
    @Request() request: ExpressRequest
  ): Promise<ProfileResponse> {
    const user = request.user as AuthUser;

    try {
      // Get user from Firebase Auth
      const userRecord = await auth.getUser(user.uid);

      // Get profile from database
      const profileSnapshot = await database.ref(`users/${user.uid}`).get();
      const profile = profileSnapshot.val();

      // Get beta credits
      const {credit, creditLimit} = await UserService.getBetaCredits(user.uid);

      return {
        user: {
          uid: userRecord.uid,
          email: userRecord.email!,
          displayName: userRecord.displayName || null,
          photoURL: userRecord.photoURL || undefined,
          emailVerified: userRecord.emailVerified,
          ...profile,
          credit,
          creditLimit,
        },
      };
    } catch {
      this.setStatus(HTTP_STATUS.INTERNAL_SERVER_ERROR);
      throw {error: "Internal Server Error", message: "Failed to get profile"};
    }
  }

  /**
   * Update authenticated user's profile
   * @summary Update user profile
   * @param requestBody Profile fields to update
   */
  @Patch("profile")
  @Security("BearerAuth")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(500, "Internal server error")
  public async updateProfile(
    @Request() request: ExpressRequest,
    @Body() requestBody: ProfileUpdateRequest
  ): Promise<ProfileUpdateResponse> {
    const user = request.user as AuthUser;
    const {displayName, photoURL} = requestBody;

    // Sanitize inputs
    const sanitizedDisplayName = displayName
      ? sanitizeDisplayName(displayName)
      : undefined;
    const sanitizedPhotoURL = photoURL ? sanitizeURL(photoURL) : undefined;

    try {
      // Update Firebase Auth profile
      await auth.updateUser(user.uid, {
        displayName: sanitizedDisplayName,
        photoURL: sanitizedPhotoURL,
      });

      // Update database profile
      await database.ref(`users/${user.uid}`).update({
        displayName: sanitizedDisplayName,
        photoURL: sanitizedPhotoURL,
        updatedAt: new Date().toISOString(),
      });

      return {
        message: "Profile updated successfully",
        user: {
          uid: user.uid,
          displayName: sanitizedDisplayName || null,
          photoURL: sanitizedPhotoURL || null,
        },
      };
    } catch {
      this.setStatus(HTTP_STATUS.INTERNAL_SERVER_ERROR);
      throw {
        error: "Internal Server Error",
        message: "Failed to update profile",
      };
    }
  }

  /**
   * Logout user and invalidate session
   * @summary Logout current session
   */
  @Post("logout")
  @Security("BearerAuth")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(500, "Internal server error")
  public async logout(
    @Request() request: ExpressRequest
  ): Promise<{message: string}> {
    const user = request.user as AuthUser;

    try {
      // Get session ID from token claims
      const authHeader = request.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.split("Bearer ")[1];
        try {
          const decodedToken = await auth.verifyIdToken(token);
          const sessionId = decodedToken.sessionId as string | undefined;

          if (sessionId) {
            // Delete specific session
            await SessionService.deleteSession(user.uid, sessionId);
          } else {
            // Fallback: delete all sessions if no sessionId in token
            await SessionService.deleteAllSessions(user.uid);
          }
        } catch {
          // If token verification fails, still try to clean up
          await SessionService.deleteAllSessions(user.uid);
        }
      }

      return {
        message: "Logged out successfully",
      };
    } catch {
      this.setStatus(HTTP_STATUS.INTERNAL_SERVER_ERROR);
      throw {
        error: "Internal Server Error",
        message: "Failed to logout",
      };
    }
  }

  /**
   * Permanently delete authenticated user's account
   * @summary Delete user account
   */
  @Delete("account")
  @Security("BearerAuth")
  @Response<ErrorResponse>(401, "Unauthorized")
  @Response<ErrorResponse>(500, "Internal server error")
  public async deleteAccount(
    @Request() request: ExpressRequest
  ): Promise<DeleteAccountResponse> {
    const user = request.user as AuthUser;

    try {
      // Delete all sessions
      await SessionService.deleteAllSessions(user.uid);

      // Delete from Realtime Database
      await database.ref(`users/${user.uid}`).remove();

      // Delete from Firebase Auth
      await auth.deleteUser(user.uid);

      return {
        message: "Account deleted successfully",
      };
    } catch {
      this.setStatus(HTTP_STATUS.INTERNAL_SERVER_ERROR);
      throw {
        error: "Internal Server Error",
        message: "Failed to delete account",
      };
    }
  }

  /**
   * Admin endpoint to mark a user's email as verified.
   * Requires x-admin-key header matching ADMIN_SECRET_KEY env var.
   * @summary Admin: Verify user email
   * @param userId The user's Firebase UID
   */
  @Post("admin/verify-email/{userId}")
  @Hidden()
  @Response<ErrorResponse>(400, "Bad Request")
  @Response<ErrorResponse>(401, "Unauthorized - invalid admin key")
  @Response<ErrorResponse>(404, "User not found")
  @Response<ErrorResponse>(500, "Internal server error")
  public async adminVerifyEmail(
    userId: string,
    @Request() request: ExpressRequest
  ): Promise<{message: string; userId: string; emailVerified: boolean}> {
    // Validate admin key
    const adminKey = request.headers["x-admin-key"] as string;
    if (!adminKey || adminKey !== process.env.ADMIN_SECRET_KEY) {
      this.setStatus(HTTP_STATUS.UNAUTHORIZED);
      throw {error: "Unauthorized", message: "Invalid or missing admin key"};
    }

    if (!userId) {
      this.setStatus(HTTP_STATUS.BAD_REQUEST);
      throw {error: "Bad Request", message: "userId is required"};
    }

    try {
      // Update Firebase Auth
      await auth.updateUser(userId, {emailVerified: true});

      // Update RTDB profile
      await database.ref(`users/${userId}`).update({
        emailVerified: true,
        verifiedAt: new Date().toISOString(),
      });

      return {
        message: "User email marked as verified",
        userId,
        emailVerified: true,
      };
    } catch (error: unknown) {
      const code = (error as {code?: string}).code;
      if (code === FIREBASE_ERROR_CODES.USER_NOT_FOUND) {
        this.setStatus(HTTP_STATUS.NOT_FOUND);
        throw {error: "Not Found", message: "User not found"};
      }

      this.setStatus(HTTP_STATUS.INTERNAL_SERVER_ERROR);
      throw {
        error: "Internal Server Error",
        message: "Failed to verify user email",
      };
    }
  }
}
