/**
 * Firebase Emulator Configuration
 * Centralized constants for all emulator hosts and ports
 */

export const EMULATOR_HOST = "localhost";

export const EMULATOR_PORTS = {
  AUTH: 9099,
  DATABASE: 9000,
  STORAGE: 9199,
  FIRESTORE: 8080,
  FUNCTIONS: 5001,
  HOSTING: 5000,
  PUBSUB: 8085,
} as const;

export const EMULATOR_HOSTS = {
  AUTH: `${EMULATOR_HOST}:${EMULATOR_PORTS.AUTH}`,
  DATABASE: `${EMULATOR_HOST}:${EMULATOR_PORTS.DATABASE}`,
  STORAGE: `${EMULATOR_HOST}:${EMULATOR_PORTS.STORAGE}`,
  FIRESTORE: `${EMULATOR_HOST}:${EMULATOR_PORTS.FIRESTORE}`,
  PUBSUB: `${EMULATOR_HOST}:${EMULATOR_PORTS.PUBSUB}`,
} as const;

/**
 * Generate storage emulator URL for a file path
 */
export function getEmulatorStorageUrl(
  bucketName: string,
  filePath: string,
  token?: string
): string {
  const encodedPath = encodeURIComponent(filePath);
  const base = `http://${EMULATOR_HOSTS.STORAGE}/v0/b/${bucketName}/o/${encodedPath}?alt=media`;
  return token ? `${base}&token=${encodeURIComponent(token)}` : base;
}
