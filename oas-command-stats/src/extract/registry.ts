/**
 * Per-agent extraction dispatch.
 *
 * Walks a SessionDetail (from @open-agent-sessions/sdk), finds bash/shell
 * tool_use parts, derives per-agent event_id, returns ExtractedEvent[] ready
 * for ingestBatch.
 *
 * @file src/extract/registry.ts
 */
import type { SessionDetail } from "@open-agent-sessions/sdk";
import type { ExtractedEvent, SupportedAgent } from "../types/contract";
import { derivePiEventId } from "./pi";
import { deriveZcodeEventId } from "./zcode";
import { deriveHermesEventId } from "./hermes";

export interface ExtractContext {
  session_file_path?: string;
  session_db_path?: string;
}

const BASH_TOOL_PATTERNS = /bash|shell|exec|cmd|powershell|terminal/i;

/**
 * Extract bash command events from a SessionDetail.
 *
 * For pi: event_id = derivePiEventId(session_file_path, byte_offset)
 *   where byte_offset is approximated as cumulative char-length of preceding
 *   records (stable as long as messages aren't reordered).
 * For zcode: event_id = part.state.id (tool_usage.id)
 * For hermes: event_id = deriveHermesEventId(session_id, message_id, idx)
 */
export function extractEvents(
  detail: SessionDetail,
  ctx: ExtractContext,
): ExtractedEvent[] {
  const agent = detail.agent as SupportedAgent;
  const events: ExtractedEvent[] = [];

  if (!detail.messages || detail.messages.length === 0) return events;

  // Track byte offset accumulator for pi derivation
  let byteOffsetAccum = 0;

  for (const msg of detail.messages) {
    const msgTs = msg.created_at ? new Date(msg.created_at) : new Date();
    let toolCallIdx = 0;
    for (const part of msg.parts ?? []) {
      const partType = (part as any)?.type;
      const toolName =
        (part as any)?.name ??
        (part as any)?.tool ??
        ((part as any)?.state as any)?.tool ??
        "";

      // Detect bash/shell tool calls
      const isBash =
        partType === "tool" || partType === "tool_use" ||
        BASH_TOOL_PATTERNS.test(String(toolName));
      if (!isBash) continue;

      const state = (part as any)?.state ?? (part as any)?.input ?? {};
      const command =
        state.command ?? state.cmd ?? state.script ?? state.input;
      if (!command || typeof command !== "string") continue;

      const cwd = state.cwd ?? state.working_directory ?? (msg as any).cwd ?? null;
      const exit_code = state.exit_code ?? state.exitCode ?? null;
      const duration_ms = state.duration_ms ?? state.duration ?? null;

      const event_id = deriveEventId(agent, detail.id, msg.id, toolCallIdx, ctx, byteOffsetAccum, state);
      if (!event_id) continue;

      events.push({
        agent,
        alias: detail.alias,
        session_id: detail.id,
        event_id,
        source_schema_version: "0.1.0",
        event_ts: msgTs,
        raw_command: command,
        cwd_hint: cwd ?? null,
        exit_code: typeof exit_code === "number" ? exit_code : null,
        duration_ms: typeof duration_ms === "number" ? duration_ms : null,
      });

      toolCallIdx++;
      byteOffsetAccum += JSON.stringify(part).length + 1; // +1 for newline
    }
  }

  return events;
}

function deriveEventId(
  agent: SupportedAgent,
  session_id: string,
  message_id: string,
  tool_call_idx: number,
  ctx: ExtractContext,
  byte_offset: number,
  state: any,
): string | null {
  switch (agent) {
    case "pi": {
      const fp = ctx.session_file_path ?? session_id;
      return derivePiEventId(fp, byte_offset);
    }
    case "zcode": {
      const tuId = state.id ?? state.tool_usage_id ?? `${message_id}:${tool_call_idx}`;
      return deriveZcodeEventId(String(tuId));
    }
    case "hermes": {
      return deriveHermesEventId(session_id, message_id, tool_call_idx);
    }
    default: {
      // opencode, claude, codex — use synthetic hash for now (Phase 2 scope).
      return deriveHermesEventId(session_id, message_id, tool_call_idx);
    }
  }
}
