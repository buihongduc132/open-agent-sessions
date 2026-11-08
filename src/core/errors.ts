import type { AdapterHandle } from "./types";

/** Capability detection must describe actual available behavior, not placeholders. */
export type Capability = "fork" | "similar" | "toolSearch" | string;
export const CAPABILITY_UNSUPPORTED_EXIT = 4 as const;

export class CapabilityUnsupportedError extends Error {
  readonly code = "OAS_CAPABILITY_UNSUPPORTED" as const;
  constructor(
    readonly agent: string,
    readonly alias: string,
    readonly capability: Capability,
    detail?: string
  ) {
    super(`${agent}:${alias} does not support ${capability}${detail ? ": " + detail : ""}`);
    this.name = "CapabilityUnsupportedError";
  }
}

/** Code-based identity works even when separate bun import paths load two copies. */
export function isCapabilityUnsupported(e: unknown): e is CapabilityUnsupportedError {
  return typeof e === "object" && e !== null &&
    (e as { code?: unknown }).code === "OAS_CAPABILITY_UNSUPPORTED";
}

export function requireCapability<K extends keyof AdapterHandle>(
  handle: AdapterHandle,
  method: K,
  capability: Capability,
): NonNullable<AdapterHandle[K]> {
  const candidate = handle[method];
  if (typeof candidate !== "function") {
    throw new CapabilityUnsupportedError(handle.agent, handle.alias, capability);
  }
  return candidate.bind(handle) as NonNullable<AdapterHandle[K]>;
}
