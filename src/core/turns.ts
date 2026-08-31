/**
 * Turn engine — turn grouping, range resolution, slicing.
 * STUB (RED phase): contracts frozen in flow/plans/oas-export-turn-split-design.md.
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

export function groupTurns(messages: SessionMessage[]): Turn[] {
  throw new Error("not implemented: groupTurns");
}

export function resolveRange(spec: TurnRangeSpec, totalTurns: number): RangeResult {
  throw new Error("not implemented: resolveRange");
}

export function sliceTurn(detail: SessionDetail, turns: Turn[], range: ResolvedRange): SessionDetail {
  throw new Error("not implemented: sliceTurn");
}
