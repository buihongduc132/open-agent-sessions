/**
 * Shared utility functions used across core and adapters.
 *
 * DRY consolidation of helpers previously duplicated in multiple modules.
 */

/**
 * Extract a human-readable message from an unknown error value.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}
