import dotenv from "dotenv";
import {GoogleGenerativeAI} from "@google/generative-ai";
import {EMULATOR_HOSTS} from "./emulator.config";
import {GEMINI_MODELS} from "../types/gemini.types";

// Load .env variables BEFORE initializing Firebase
// For local dev: uses functions/.env
// For production: use Firebase Secrets (firebase functions:secrets:set)
dotenv.config();

// Detect if running in Firebase emulator
// FUNCTIONS_EMULATOR is set by Firebase CLI when running emulators
const runningLocally = process.env.FUNCTIONS_EMULATOR === "true";
if (runningLocally) {
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    process.env.FIREBASE_AUTH_EMULATOR_HOST = EMULATOR_HOSTS.AUTH;
  }
  if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) {
    process.env.FIREBASE_DATABASE_EMULATOR_HOST = EMULATOR_HOSTS.DATABASE;
  }
  if (!process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
    process.env.FIREBASE_STORAGE_EMULATOR_HOST = EMULATOR_HOSTS.STORAGE;
  }
  if (!process.env.PUBSUB_EMULATOR_HOST) {
    process.env.PUBSUB_EMULATOR_HOST = EMULATOR_HOSTS.PUBSUB;
  }
}

export const isEmulator = runningLocally;

import * as admin from "firebase-admin";

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp();
}

export const auth = admin.auth();
export const database = admin.database();
export const storage = admin.storage();

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

// Text/analysis model - Gemini 3 Flash for fast multimodal analysis
export const geminiModel = genAI.getGenerativeModel({
  model: GEMINI_MODELS.GEMINI_3_FLASH_PREVIEW,
});

// Image generation model (for fix feature) - Gemini 3 Pro Image
// Note: responseModalities is a valid Gemini API parameter but not in the SDK types yet
const imageGenConfig = {
  responseModalities: ["Text", "Image"],
};
export const geminiImageModel = genAI.getGenerativeModel({
  model: GEMINI_MODELS.GEMINI_3_PRO_IMAGE_PREVIEW,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  generationConfig: imageGenConfig as any,
});

// Content moderation model - Gemini 2.0 Flash (cheaper/free tier eligible)
// Used only for safety checks, doesn't need high quality output
export const geminiModerationModel = genAI.getGenerativeModel({
  model: GEMINI_MODELS.GEMINI_2_FLASH,
});

export default admin;
