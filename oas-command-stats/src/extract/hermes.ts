/**
 * hermes event_id derivation: synthetic hash of session_id + message_id +
 * tool_call_idx. Stable across re-ingest as long as message_id and tool_call
 * order unchanged.
 *
 * @file src/extract/hermes.ts
 */
import { createHash } from "node:crypto";

export function deriveHermesEventId(
  session_id: string,
  message_id: string,
  tool_call_idx: number,
): string {
  const input = `${session_id}:${message_id}:${tool_call_idx}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}
