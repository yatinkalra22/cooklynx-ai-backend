export const GEMINI_MODELS = {
  GEMINI_3_FLASH_PREVIEW: "gemini-3-flash-preview",
  GEMINI_3_PRO_IMAGE_PREVIEW: "gemini-3-pro-image-preview",
  GEMINI_3_FLASH: "gemini-3-flash",
  GEMINI_2_FLASH: "gemini-2.0-flash",
} as const;

export type GeminiModelName =
  (typeof GEMINI_MODELS)[keyof typeof GEMINI_MODELS];
