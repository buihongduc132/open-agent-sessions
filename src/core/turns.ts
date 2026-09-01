/**
 * Turn engine — turn grouping, range resolution, slicing.
 * Contracts: flow/plans/oas-export-turn-split-design.md (frozen before RED).
 */
import type { SessionDetail, SessionMessage } from "./types";

export interface Turn {
  /** 0-based absolute turn index */
  index: number;
  messages: SessionMessage[];
}

export interface TurnRangeSpec {
  fromRelative?: string;
  toRelative?: string;
  from?: string;
  to?: string;
}

export interface ResolvedRange {
  from: number;
  to: number;
}

export type RangeResult = { ok: true; value: ResolvedRange } | { ok: false; error: string };

/** Message carrying a 1-based slice-local index alongside its global index. */
export type SliceMessage = SessionMessage & { slice_index: number };

const INT_RE = /^-?\d+$/;
/**
 * SessionMessage with the de-facto schema field `index` (1-based global message
 * position, present in main's working tree; not yet in this branch's types.ts).
 * Local intersection keeps this module compiling without widening the shared type.
 */
type IndexedMessage = SessionMessage & { index?: number };
/** Trailing "— turn N/M" title suffix appended by sliceTurn (stripped for idempotency). */
const TITLE_SUFFIX_RE = /\s*—\s*turn\s+\d+\/\d+\s*$/;

/**
 * A turn starts at a user message containing a non-tool_result part.
 * Messages before the first turn start (prologue) merge into turn 0.
 * Consecutive user text messages start separate turns.
 * Input is pre-sorted: by message index when every message has one,
 * else by created_at (stable in both cases).
 */
export function groupTurns(messages: SessionMessage[]): Turn[] {
  if (messages.length === 0) return [];

  const sorted = sortByPosition(messages);

  const turns: Turn[] = [];
  let prologue: SessionMessage[] = [];

  for (const msg of sorted) {
    // A turn starts at a user message carrying REAL content: a text part.
    // tool_result-only and step-start/step-finish-only user messages are
    // metadata — they merge into the current turn instead of starting one.
    const isTurnStart = msg.role === "user" && msg.parts.some((p) => p.type === "text");
    if (isTurnStart) {
      turns.push({ index: turns.length, messages: [...prologue, msg] });
      prologue = [];
    } else if (turns.length === 0) {
      prologue.push(msg);
    } else {
      turns[turns.length - 1].messages.push(msg);
    }
  }

  // Trailing prologue (session with no user text turn at all) is its own turn.
  if (prologue.length > 0) {
    turns.push({ index: turns.length, messages: prologue });
  }

  return turns;
}

function sortByPosition(messages: SessionMessage[]): SessionMessage[] {
  const typed = messages as IndexedMessage[];
  const withIndex = typed.filter((m) => typeof m.index === "number");
  if (withIndex.length === typed.length) {
    return [...typed].sort((a, b) => (a.index as number) - (b.index as number));
  }
  return [...messages].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

/**
 * Resolve turn bounds to absolute 0-based inclusive indices.
 * Relative (pandas model): abs = T-1+r — 0 = current turn, -1 = previous.
 * Relative domain is r <= 0 ("0" valid, "-0" rejected); absolute domain is >= 0.
 * Single bound implies the missing end (from → to=T-1, to → from=0).
 * Post-resolve out-of-range is distinct from inversion; both echo resolved values.
 */
export function resolveRange(spec: TurnRangeSpec, totalTurns: number): RangeResult {
  const err = (error: string): RangeResult => ({ ok: false, error });

  // Strict integer validation first.
  for (const [name, v] of [
    ["--from-relative", spec.fromRelative],
    ["--to-relative", spec.toRelative],
    ["--from", spec.from],
    ["--to", spec.to],
  ] as const) {
    if (v !== undefined && !INT_RE.test(v)) {
      return err(`Invalid ${name} value "${v}": must be an integer (e.g. 0, -1, 2).`);
    }
  }

  // Domain validation.
  if (spec.fromRelative === "-0" || spec.toRelative === "-0") {
    const name = spec.fromRelative === "-0" ? "--from-relative" : "--to-relative";
    return err(`Invalid ${name} value "-0": relative 0 is written without a sign.`);
  }
  const fromRel = spec.fromRelative !== undefined ? Number(spec.fromRelative) : undefined;
  const toRel = spec.toRelative !== undefined ? Number(spec.toRelative) : undefined;
  if (fromRel !== undefined && fromRel > 0) {
    return err(
      `--from-relative only accepts 0 or negative values (0 = current turn); use --from <n> for absolute turn indices.`
    );
  }
  if (toRel !== undefined && toRel > 0) {
    return err(
      `--to-relative only accepts 0 or negative values (0 = current turn); use --to <n> for absolute turn indices.`
    );
  }
  const fromAbs = spec.from !== undefined ? Number(spec.from) : undefined;
  const toAbs = spec.to !== undefined ? Number(spec.to) : undefined;
  if (fromAbs !== undefined && fromAbs < 0) {
    return err(`--from only accepts absolute indices >= 0; negative values belong to --from-relative.`);
  }
  if (toAbs !== undefined && toAbs < 0) {
    return err(`--to only accepts absolute indices >= 0; negative values belong to --to-relative.`);
  }

  // Resolve both ends (relative wins if both forms somehow reach this layer).
  // Single bound implies the missing end: from defaults to 0, to defaults to T-1.
  const T = totalTurns;
  const from: number = fromRel !== undefined ? T - 1 + fromRel : fromAbs !== undefined ? fromAbs : 0;
  const to: number = toRel !== undefined ? T - 1 + toRel : toAbs !== undefined ? toAbs : T - 1;

  // Post-resolve out-of-range (distinct from inversion) — echoes total turns.
  const oor = (which: string, abs: number): string =>
    `Turn index out of range: ${which} resolves to absolute ${abs}, but the session has ${T} turn${T === 1 ? "" : "s"} (valid 0–${T - 1}).`;
  if (T <= 0) {
    return err(`Turn index out of range: the session has ${T} turns — nothing to slice.`);
  }
  if (from < 0 || from > T - 1) {
    const which = fromRel !== undefined ? `--from-relative ${spec.fromRelative}` : `--from ${spec.from}`;
    return err(oor(which, from));
  }
  if (to < 0 || to > T - 1) {
    const which = toRel !== undefined ? `--to-relative ${spec.toRelative}` : `--to ${spec.to}`;
    return err(oor(which, to));
  }

  // Inversion — shows both resolved absolute values.
  if (from > to) {
    return err(
      `Inverted turn range: --from resolves to absolute turn ${from} but --to resolves to absolute turn ${to} (from must be <= to).`
    );
  }

  return { ok: true, value: { from, to } };
}

/**
 * Slice a session detail to turns[range.from..range.to]:
 * - message_count rewritten to the slice's message count
 * - title gains "— turn N/M" (N = 1-based first turn, M = 1-based last turn;
 *   an existing suffix is stripped first so re-export stays idempotent)
 * - created_at/updated_at from the slice's first/last message
 * - messages keep their global index and gain a 1-based slice-local slice_index
 */
export function sliceTurn(detail: SessionDetail, turns: Turn[], range: ResolvedRange): SessionDetail {
  const sliceTurns = turns.slice(range.from, range.to + 1);

  const messages: SliceMessage[] = [];
  let local = 1;
  for (const turn of sliceTurns) {
    for (const msg of turn.messages) {
      messages.push({ ...msg, slice_index: local++ });
    }
  }

  const baseTitle = detail.title.replace(TITLE_SUFFIX_RE, "");
  const title = `${baseTitle} — turn ${range.from + 1}/${range.to + 1}`;

  const first = messages[0];
  const last = messages[messages.length - 1];

  return {
    ...detail,
    title,
    message_count: messages.length,
    messages,
    created_at: first ? first.created_at : detail.created_at,
    updated_at: last ? last.created_at : detail.updated_at,
  };
}
