import { SessionDetail } from "../core/types";

export type TuiDetailMode = "detail" | "help";

export type TuiDetailEffect =
  | { type: "exit"; reason: "quit" | "ctrl-c" }
  | { type: "back" };

export type KeyInput = {
  name: string;
  ctrl?: boolean;
  sequence?: string;
};

export type TuiDetailState = {
  mode: TuiDetailMode;
  detail: SessionDetail;
  lines: string[];
  scrollOffset: number;
  viewportHeight: number;
};

export function createDetailState(detail: SessionDetail): TuiDetailState {
  return {
    mode: "detail",
    detail,
    lines: buildDetailLines(detail),
    scrollOffset: 0,
    viewportHeight: 10,
  };
}

export function setDetailViewportHeight(
  state: TuiDetailState,
  height: number
): TuiDetailState {
  const safeHeight = Number.isFinite(height) && height > 0 ? Math.floor(height) : 1;
  if (safeHeight === state.viewportHeight) {
    return state;
  }
  const next = { ...state, viewportHeight: safeHeight };
  return clampScroll(next);
}

export function applyDetailKey(
  state: TuiDetailState,
  key: KeyInput
): { state: TuiDetailState; effect: TuiDetailEffect | null } {
  if (key.ctrl && key.name === "c") {
    return { state, effect: { type: "exit", reason: "ctrl-c" } };
  }

  if (key.name === "q") {
    return { state, effect: { type: "exit", reason: "quit" } };
  }

  if (state.mode === "help") {
    if (key.name === "escape" || key.name === "?") {
      return { state: { ...state, mode: "detail" }, effect: null };
    }
    return { state, effect: null };
  }

  if (key.name === "?") {
    return { state: { ...state, mode: "help" }, effect: null };
  }

  if (key.name === "escape") {
    return { state, effect: { type: "back" } };
  }

  if (key.name === "j" || key.name === "down") {
    return { state: scrollBy(state, 1), effect: null };
  }

  if (key.name === "k" || key.name === "up") {
    return { state: scrollBy(state, -1), effect: null };
  }

  if (key.name === "g") {
    return { state: jumpTo(state, 0), effect: null };
  }

  if (key.name === "G") {
    return { state: jumpTo(state, "end"), effect: null };
  }

  return { state, effect: null };
}

export function buildDetailLines(detail: SessionDetail): string[] {
  const title = normalizeTitle(detail.title, detail.id);
  const lines = [
    `Session [${detail.agent}:${detail.alias}]`,
    `agent: ${detail.agent}`,
    `alias: ${detail.alias}`,
    `id: ${detail.id}`,
    `title: ${title}`,
    `created_at: ${detail.created_at}`,
    `updated_at: ${detail.updated_at}`,
    `message_count: ${String(detail.message_count)}`,
    `storage: ${detail.storage}`,
  ];

  const cloneLines = buildCloneLines(detail);
  lines.push(...cloneLines);
  return lines;
}

function buildCloneLines(detail: SessionDetail): string[] {
  const clone = detail.clone ?? {};
  const src = clone.src ?? {};
  const dst = clone.dst ?? {};
  return [
    `src.agent: ${formatValue(src.agent)}`,
    `src.session_id: ${formatValue(src.session_id)}`,
    `src.version: ${formatValue(src.version)}`,
    `dst.agent: ${formatValue(dst.agent)}`,
    `dst.session_id: ${formatValue(dst.session_id)}`,
    `dst.version: ${formatValue(dst.version)}`,
  ];
}

function normalizeTitle(title: string, id: string): string {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : id;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "n/a";
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : "n/a";
  }
  return String(value);
}

function scrollBy(state: TuiDetailState, delta: number): TuiDetailState {
  if (state.lines.length === 0) {
    return state;
  }
  const maxOffset = maxScrollOffset(state);
  const nextOffset = clamp(state.scrollOffset + delta, 0, maxOffset);
  if (nextOffset === state.scrollOffset) {
    return state;
  }
  return { ...state, scrollOffset: nextOffset };
}

function jumpTo(state: TuiDetailState, target: 0 | "end"): TuiDetailState {
  const maxOffset = maxScrollOffset(state);
  const nextOffset = target === "end" ? maxOffset : 0;
  if (nextOffset === state.scrollOffset) {
    return state;
  }
  return { ...state, scrollOffset: nextOffset };
}

function clampScroll(state: TuiDetailState): TuiDetailState {
  const maxOffset = maxScrollOffset(state);
  if (state.scrollOffset > maxOffset) {
    return { ...state, scrollOffset: maxOffset };
  }
  if (state.scrollOffset < 0) {
    return { ...state, scrollOffset: 0 };
  }
  return state;
}

function maxScrollOffset(state: TuiDetailState): number {
  return Math.max(0, state.lines.length - state.viewportHeight);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
