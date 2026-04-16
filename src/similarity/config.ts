/**
 * REQ-SIM-04 — SimilarityConfig stub
 *
 * RED phase: this file exists only to satisfy TypeScript/module imports.
 * All real logic is TBD — tests define the expected behaviour.
 */

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

/** Raw parsed YAML map passed to parseSimilarityConfig */
export type RawSimilarityConfig = Record<string, unknown>;

export interface SimilarityConfig {
  enabled: boolean;
  embeddingProvider: "local" | "api";
  topK: number;
  vectorDimension?: 384 | 768 | 1536;
  apiEndpoint?: string;
}

export function parseSimilarityConfig(_raw: RawSimilarityConfig): SimilarityConfig {
  // TODO: implement
  throw new Error("parseSimilarityConfig not implemented");
}

export function initializeSimilarity(_db: unknown, _cfg: SimilarityConfig): void {
  // TODO: implement
  throw new Error("initializeSimilarity not implemented");
}
