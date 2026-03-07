import { AgentEntry, AgentKind } from "../config/types";
import { SessionListError, SessionListResult } from "../core/list";
import { SessionSummary } from "../core/types";

const AGENT_ORDER: Record<AgentKind, number> = {
  opencode: 0,
  codex: 1,
  claude: 2,
};

export type FilterValue<T extends string> = "all" | T;

export type TuiMode = "list" | "help" | "filter" | "clone";

export type TuiEffect =
  | { type: "exit"; reason: "quit" | "ctrl-c" }
  | { type: "open-detail"; session: SessionSummary }
  | { type: "clone"; source: SessionSummary; destination: string };

export type KeyInput = {
  name: string;
  ctrl?: boolean;
  sequence?: string;
};

export type TuiListState = {
  mode: TuiMode;
  filter: {
    query: string;
    agent: FilterValue<AgentKind>;
    alias: FilterValue<string>;
  };
  filterInput: string;
  previousQuery: string;
  agentOptions: AgentKind[];
  aliasOptions: string[];
  opencodeDestinations: string[];
  allSessions: SessionSummary[];
  filteredSessions: SessionSummary[];
  errors: SessionListError[];
  selectionIndex: number | null;
  selectedKey: string | null;
  scrollOffset: number;
  viewportHeight: number;
  statusMessage?: string;
  clonePrompt?: {
    sourceSession: SessionSummary;
    destinations: string[];
    selectedIndex: number;
  };
};

export function createListState(entries: AgentEntry[]): TuiListState {
  const { agentOptions, aliasOptions, opencodeDestinations } = buildToggleOptions(entries);
  return {
    mode: "list",
    filter: {
      query: "",
      agent: "all",
      alias: "all",
    },
    filterInput: "",
    previousQuery: "",
    agentOptions,
    aliasOptions,
    opencodeDestinations,
    allSessions: [],
    filteredSessions: [],
    errors: [],
    selectionIndex: null,
    selectedKey: null,
    scrollOffset: 0,
    viewportHeight: 10,
    statusMessage: undefined,
  };
}

export function applyListData(
  state: TuiListState,
  result: SessionListResult
): TuiListState {
  const next = {
    ...state,
    allSessions: result.sessions.slice(),
    errors: result.errors.slice(),
  };
  return recomputeFiltered(next, true);
}

export function setViewportHeight(
  state: TuiListState,
  height: number
): TuiListState {
  const safeHeight = Number.isFinite(height) && height > 0 ? Math.floor(height) : 1;
  if (safeHeight === state.viewportHeight) {
    return state;
  }
  const next = { ...state, viewportHeight: safeHeight };
  return recomputeFiltered(next, false);
}

export function applyKey(
  state: TuiListState,
  key: KeyInput
): { state: TuiListState; effects: TuiEffect[] } {
  if (key.ctrl && key.name === "c") {
    return { state, effects: [{ type: "exit", reason: "ctrl-c" }] };
  }

  if (key.name === "q") {
    return { state, effects: [{ type: "exit", reason: "quit" }] };
  }

  if (state.mode === "help") {
    if (key.name === "escape" || key.name === "?") {
      return { state: { ...state, mode: "list" }, effects: [] };
    }
    return { state, effects: [] };
  }

  if (state.mode === "filter") {
    return { state: handleFilterInput(state, key), effects: [] };
  }

  if (state.mode === "clone") {
    return handleCloneInput(state, key);
  }

  return handleListInput(state, key);
}

export function getEmptyState(state: TuiListState): {
  kind: "none" | "empty" | "nomatch";
  message?: string;
} {
  if (state.allSessions.length === 0) {
    return { kind: "empty", message: "No sessions found." };
  }
  if (state.filteredSessions.length === 0) {
    return { kind: "nomatch", message: "No sessions match the current filters." };
  }
  return { kind: "none" };
}

export function formatFooter(state: TuiListState): string {
  const parts = [
    `agent:${state.filter.agent}`,
    `alias:${state.filter.alias}`,
  ];
  const errorLine = formatErrors(state.errors);
  if (errorLine) {
    parts.push(errorLine);
  }
  if (state.statusMessage) {
    parts.push(state.statusMessage);
  }
  return parts.join(" | ");
}

export function getSelectedSession(state: TuiListState): SessionSummary | null {
  if (state.selectionIndex === null) return null;
  return state.filteredSessions[state.selectionIndex] ?? null;
}

export function formatSessionLabel(session: { agent: string; alias: string }): string {
  return `[${session.agent}:${session.alias}]`;
}

function handleFilterInput(
  state: TuiListState,
  input: KeyInput
): TuiListState {
  const name = input.name;
  if (name === "escape") {
    const restored: TuiListState = {
      ...state,
      mode: "list",
      filterInput: state.previousQuery,
      filter: { ...state.filter, query: state.previousQuery },
      statusMessage: undefined,
    };
    return recomputeFiltered(restored, false);
  }

  if (name === "return") {
    const applied: TuiListState = {
      ...state,
      mode: "list",
      filterInput: state.filterInput,
      filter: { ...state.filter, query: state.filterInput },
      statusMessage: undefined,
    };
    return recomputeFiltered(applied, false);
  }

  if (name === "backspace") {
    const nextInput = state.filterInput.slice(0, -1);
    const next = {
      ...state,
      filterInput: nextInput,
      filter: { ...state.filter, query: nextInput },
      statusMessage: undefined,
    };
    return recomputeFiltered(next, false);
  }

  const text = getTextInput(name, input.sequence);
  if (text) {
    const nextInput = state.filterInput + text;
    const next = {
      ...state,
      filterInput: nextInput,
      filter: { ...state.filter, query: nextInput },
      statusMessage: undefined,
    };
    return recomputeFiltered(next, false);
  }

  return state;
}

function handleListInput(
  state: TuiListState,
  input: KeyInput
): { state: TuiListState; effects: TuiEffect[] } {
  const name = input.name;
  let next = { ...state, statusMessage: undefined };

  if (name === "?") {
    return { state: { ...next, mode: "help" }, effects: [] };
  }

  if (name === "/") {
    return {
      state: {
        ...next,
        mode: "filter",
        previousQuery: next.filter.query,
        filterInput: next.filter.query,
      },
      effects: [],
    };
  }

  if (name === "a") {
    const agent = cycleValue(next.filter.agent, ["all", ...next.agentOptions]);
    next = { ...next, filter: { ...next.filter, agent } };
    return { state: recomputeFiltered(next, true), effects: [] };
  }

  if (name === "l") {
    const alias = cycleValue(next.filter.alias, ["all", ...next.aliasOptions]);
    next = { ...next, filter: { ...next.filter, alias } };
    return { state: recomputeFiltered(next, true), effects: [] };
  }

  if (name === "0") {
    next = {
      ...next,
      filter: { ...next.filter, agent: "all", alias: "all" },
    };
    return { state: recomputeFiltered(next, true), effects: [] };
  }

  if (name === "j" || name === "down") {
    return { state: moveSelection(next, 1), effects: [] };
  }

  if (name === "k" || name === "up") {
    return { state: moveSelection(next, -1), effects: [] };
  }

  if (name === "g") {
    return { state: jumpSelection(next, 0), effects: [] };
  }

  if (name === "G") {
    return { state: jumpSelection(next, "end"), effects: [] };
  }

  if (name === "return") {
    if (next.allSessions.length === 0) {
      return {
        state: { ...next, statusMessage: "No session selected." },
        effects: [],
      };
    }

    if (next.filteredSessions.length === 0) {
      return { state: next, effects: [] };
    }

    const selected = getSelectedSession(next);
    if (selected) {
      return { state: next, effects: [{ type: "open-detail", session: selected }] };
    }

    return { state: next, effects: [] };
  }

  if (name === "c") {
    if (next.filteredSessions.length === 0) {
      return { state: next, effects: [] };
    }

    const selected = getSelectedSession(next);
    if (!selected) {
      return { state: next, effects: [] };
    }

    if (selected.agent !== "codex") {
      return {
        state: { ...next, statusMessage: "Clone not supported for this session type." },
        effects: [],
      };
    }

    const destinations = next.opencodeDestinations;
    if (destinations.length === 0) {
      return {
        state: { ...next, statusMessage: "No opencode destinations available." },
        effects: [],
      };
    }

    return {
      state: {
        ...next,
        mode: "clone",
        clonePrompt: {
          sourceSession: selected,
          destinations,
          selectedIndex: 0,
        },
      },
      effects: [],
    };
  }

  return { state: next, effects: [] };
}

function handleCloneInput(
  state: TuiListState,
  input: KeyInput
): { state: TuiListState; effects: TuiEffect[] } {
  const prompt = state.clonePrompt;
  if (!prompt) {
    return { state: { ...state, mode: "list" }, effects: [] };
  }

  const name = input.name;

  if (name === "escape") {
    return {
      state: {
        ...state,
        mode: "list",
        clonePrompt: undefined,
        statusMessage: undefined,
      },
      effects: [],
    };
  }

  if (name === "j" || name === "down") {
    const nextIndex = Math.min(prompt.selectedIndex + 1, prompt.destinations.length - 1);
    return {
      state: {
        ...state,
        clonePrompt: { ...prompt, selectedIndex: nextIndex },
      },
      effects: [],
    };
  }

  if (name === "k" || name === "up") {
    const nextIndex = Math.max(prompt.selectedIndex - 1, 0);
    return {
      state: {
        ...state,
        clonePrompt: { ...prompt, selectedIndex: nextIndex },
      },
      effects: [],
    };
  }

  if (name === "return") {
    const destination = prompt.destinations[prompt.selectedIndex];
    if (!destination) {
      return {
        state: {
          ...state,
          mode: "list",
          clonePrompt: undefined,
          statusMessage: "No destination selected.",
        },
        effects: [],
      };
    }
    return {
      state: { ...state, clonePrompt: undefined },
      effects: [{ type: "clone", source: prompt.sourceSession, destination }],
    };
  }

  return { state, effects: [] };
}

function buildToggleOptions(entries: AgentEntry[]): {
  agentOptions: AgentKind[];
  aliasOptions: string[];
  opencodeDestinations: string[];
} {
  const enabled = entries.filter((entry) => entry.enabled);
  const agentSet = new Set<AgentKind>();
  const aliasSet = new Set<string>();
  const opencodeSet = new Set<string>();

  for (const entry of enabled) {
    agentSet.add(entry.agent);
    if (entry.agent === "opencode") {
      opencodeSet.add(entry.alias);
    }
  }

  const sortedEntries = enabled.slice().sort(compareEntries);
  for (const entry of sortedEntries) {
    aliasSet.add(entry.alias);
  }

  return {
    agentOptions: Array.from(agentSet).sort(compareAgents),
    aliasOptions: Array.from(aliasSet),
    opencodeDestinations: Array.from(opencodeSet),
  };
}

function compareEntries(a: AgentEntry, b: AgentEntry): number {
  const agentDelta = AGENT_ORDER[a.agent] - AGENT_ORDER[b.agent];
  if (agentDelta !== 0) return agentDelta;
  return a.alias.localeCompare(b.alias);
}

function compareAgents(a: AgentKind, b: AgentKind): number {
  return AGENT_ORDER[a] - AGENT_ORDER[b];
}

function cycleValue<T extends string>(current: T, options: T[]): T {
  const index = options.indexOf(current);
  if (index === -1) {
    return options[0];
  }
  return options[(index + 1) % options.length];
}

function recomputeFiltered(state: TuiListState, preserveScrollOnMatch: boolean): TuiListState {
  const filtered = applyFilters(state.allSessions, state.filter).sort(compareSessions);
  const previousKey = state.selectedKey;
  const previousIndex = state.selectionIndex ?? 0;
  const foundIndex =
    previousKey === null
      ? -1
      : filtered.findIndex((session) => sessionKey(session) === previousKey);

  let selectionIndex: number | null = null;
  let selectedKey: string | null = null;
  let scrollOffset = state.scrollOffset;

  if (filtered.length > 0) {
    if (foundIndex >= 0) {
      selectionIndex = foundIndex;
      selectedKey = previousKey;
    } else {
      selectionIndex = Math.min(previousIndex, filtered.length - 1);
      selectedKey = sessionKey(filtered[selectionIndex]);
    }

    scrollOffset = normalizeScrollOffset(
      scrollOffset,
      selectionIndex,
      state.viewportHeight
    );

    if (foundIndex < 0 || !preserveScrollOnMatch) {
      scrollOffset = ensureSelectionVisible(
        scrollOffset,
        selectionIndex,
        state.viewportHeight
      );
    }
  } else {
    selectionIndex = null;
    selectedKey = null;
    scrollOffset = 0;
  }

  return {
    ...state,
    filteredSessions: filtered,
    selectionIndex,
    selectedKey,
    scrollOffset,
  };
}

function moveSelection(state: TuiListState, delta: number): TuiListState {
  if (state.filteredSessions.length === 0) {
    return state;
  }

  const currentIndex = state.selectionIndex ?? 0;
  const maxIndex = state.filteredSessions.length - 1;
  const nextIndex = clamp(currentIndex + delta, 0, maxIndex);

  if (nextIndex === currentIndex && state.selectionIndex !== null) {
    return state;
  }

  const scrollOffset = ensureSelectionVisible(
    state.scrollOffset,
    nextIndex,
    state.viewportHeight
  );

  return {
    ...state,
    selectionIndex: nextIndex,
    selectedKey: sessionKey(state.filteredSessions[nextIndex]),
    scrollOffset,
  };
}

function jumpSelection(state: TuiListState, target: 0 | "end"): TuiListState {
  if (state.filteredSessions.length === 0) {
    return state;
  }

  const nextIndex = target === "end" ? state.filteredSessions.length - 1 : 0;
  const scrollOffset = ensureSelectionVisible(
    state.scrollOffset,
    nextIndex,
    state.viewportHeight
  );

  return {
    ...state,
    selectionIndex: nextIndex,
    selectedKey: sessionKey(state.filteredSessions[nextIndex]),
    scrollOffset,
  };
}

function applyFilters(
  sessions: SessionSummary[],
  filter: TuiListState["filter"]
): SessionSummary[] {
  const agent = filter.agent === "all" ? undefined : filter.agent;
  const alias = filter.alias === "all" ? undefined : filter.alias;
  const normalizedQuery = filter.query.trim().toLowerCase();
  const hasQuery = normalizedQuery.length > 0;

  return sessions.filter((session) => {
    if (agent && session.agent !== agent) return false;
    if (alias && session.alias !== alias) return false;
    if (!hasQuery) return true;
    const needle = normalizedQuery;
    const title = session.title.trim().length > 0 ? session.title : session.id;
    return (
      session.id.toLowerCase().includes(needle) ||
      title.toLowerCase().includes(needle)
    );
  });
}

function compareSessions(a: SessionSummary, b: SessionSummary): number {
  const timeA = Date.parse(a.updated_at);
  const timeB = Date.parse(b.updated_at);
  if (timeA !== timeB) {
    return timeB - timeA;
  }

  const agentDelta = AGENT_ORDER[a.agent] - AGENT_ORDER[b.agent];
  if (agentDelta !== 0) return agentDelta;

  return a.id.localeCompare(b.id);
}

function sessionKey(session: SessionSummary): string {
  return `${session.agent}:${session.alias}:${session.id}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeScrollOffset(
  scrollOffset: number,
  selectionIndex: number,
  viewportHeight: number
): number {
  const maxOffset = Math.max(0, selectionIndex - viewportHeight + 1);
  if (scrollOffset > maxOffset) {
    return maxOffset;
  }
  if (scrollOffset < 0) {
    return 0;
  }
  return scrollOffset;
}

function ensureSelectionVisible(
  scrollOffset: number,
  selectionIndex: number,
  viewportHeight: number
): number {
  if (viewportHeight <= 0) {
    return scrollOffset;
  }
  if (selectionIndex < scrollOffset) {
    return selectionIndex;
  }
  if (selectionIndex >= scrollOffset + viewportHeight) {
    return selectionIndex - viewportHeight + 1;
  }
  return scrollOffset;
}

function formatErrors(errors: SessionListResult["errors"]): string {
  if (errors.length === 0) {
    return "";
  }
  return errors
    .map((error) => {
      const label = `[${error.agent}:${error.alias}]`;
      if (error.message.includes(label)) {
        return error.message;
      }
      return `${label} ${error.message}`;
    })
    .join(" | ");
}

function getTextInput(name: string, sequence?: string): string | null {
  if (sequence && sequence.length === 1 && sequence !== "\u0000") {
    return sequence;
  }
  if (name.length === 1) {
    return name;
  }
  return null;
}
