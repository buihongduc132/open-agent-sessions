/** Shared, read-only session hierarchy and identity resolution. */
import type { AdapterRegistry, SessionSummary } from "./types";
import type { ForkChainNode } from "./subagents";
import { AGENT_ORDER } from "./constants";
import { compareSessions, listSessions } from "./list";

export type SessionFilters = { agent?: string; alias?: string };
export interface SessionIndex {
  byKey: Map<string, SessionSummary>;
  byId: Map<string, SessionSummary[]>;
}

export function sessionKey(s: Pick<SessionSummary, "agent" | "alias" | "id">): string {
  return s.agent + ":" + s.alias + ":" + s.id;
}

const byAgentOrder = (a: SessionSummary, b: SessionSummary) =>
  AGENT_ORDER[a.agent] - AGENT_ORDER[b.agent] ||
  a.alias.localeCompare(b.alias) ||
  a.id.localeCompare(b.id);

export function buildSessionIndex(sessions: SessionSummary[]): SessionIndex {
  const byKey = new Map<string, SessionSummary>();
  for (const s of sessions) {
    const key = sessionKey(s);
    const previous = byKey.get(key);
    if (!previous || compareSessions(s, previous) < 0) {
      byKey.set(key, s);
    }
  }
  const byId = new Map<string, SessionSummary[]>();
  for (const session of byKey.values()) {
    const values = byId.get(session.id) ?? [];
    values.push(session);
    byId.set(session.id, values);
  }
  for (const values of byId.values()) values.sort(byAgentOrder);
  return { byKey, byId };
}

export class AmbiguousSessionError extends Error {
  readonly exitCode = 2;
  constructor(id: string, candidates: SessionSummary[]) {
    super("Ambiguous session ID " + id + ". Specify agent:alias:id. Candidates: " +
      candidates.map(sessionKey).join(", "));
    this.name = "AmbiguousSessionError";
  }
}

export function resolveSessionRef(
  index: SessionIndex, spec: string, filters: SessionFilters = {},
): SessionSummary | null {
  if (!spec) return null;
  const matchesFilter = (s: SessionSummary) =>
    (!filters.agent || s.agent === filters.agent) &&
    (!filters.alias || s.alias === filters.alias);
  const qualified = index.byKey.get(spec);
  if (qualified) return matchesFilter(qualified) ? qualified : null;
  const matches = (index.byId.get(spec) ?? []).filter(matchesFilter);
  if (matches.length > 1) throw new AmbiguousSessionError(spec, matches);
  return matches[0] ?? null;
}

/** Parent links are native, unqualified IDs; prefer the same adapter namespace. */
function resolveParent(index: SessionIndex, child: SessionSummary): SessionSummary | null {
  const parentId = child.parentSessionId;
  if (!parentId) return null;
  const local = index.byKey.get(child.agent + ":" + child.alias + ":" + parentId);
  // A native parent id can equal the child's id across different agents.
  // Never resolve the child as its own parent; prefer another namespace.
  if (local && sessionKey(local) !== sessionKey(child)) return local;
  const globally = (index.byId.get(parentId) ?? [])
    .filter(candidate => sessionKey(candidate) !== sessionKey(child));
  if (globally.length > 1) {
    console.error("Warning: ambiguous parent id " + parentId +
      " for " + sessionKey(child) + "; choosing " + sessionKey(globally[0]));
  }
  return globally[0] ?? null;
}

export function resolveForkChain(
  index: SessionIndex, start: SessionSummary, maxDepth = 100,
): ForkChainNode[] {
  const chain: ForkChainNode[] = [];
  const visited = new Set<string>();
  let current: SessionSummary | null = start;
  const limit = Number.isFinite(maxDepth) ? Math.max(0, Math.floor(maxDepth)) : 100;
  while (current && chain.length < limit) {
    const key = sessionKey(current);
    if (visited.has(key)) break;
    visited.add(key);
    chain.push({
      sessionId: current.id,
      title: current.title,
      agent: current.agent,
      alias: current.alias,
      parentSessionId: current.parentSessionId,
      depth: 0,
    });
    current = resolveParent(index, current);
  }
  chain.reverse();
  chain.forEach((node, depth) => { node.depth = depth; });
  return chain;
}

/** List direct children of one resolved parent (never grandchildren). */
export function listChildren(index: SessionIndex, parentId: string, filters: SessionFilters = {}): SessionSummary[] {
  const parent = resolveSessionRef(index, parentId, filters);
  if (!parent) return [];
  const target = sessionKey(parent);
  return [...index.byKey.values()]
    .filter(child => child.parentSessionId && sessionKey(resolveParent(index, child) ?? child) === target)
    .sort((a, b) => compareSessions(a, b) || byAgentOrder(a, b));
}

async function snapshot(registry: AdapterRegistry): Promise<SessionIndex> {
  const { sessions, errors } = await listSessions(registry, {});
  if (errors.length) {
    // An incomplete read can incorrectly report a missing parent or child.
    throw new Error("Incomplete session scan: " + errors.map(e =>
      "[" + e.agent + ":" + e.alias + "] " + e.message).join("; "));
  }
  return buildSessionIndex(sessions);
}

export function createTreeService(registry: AdapterRegistry, filters: SessionFilters = {}) {
  return async (spec: string): Promise<ForkChainNode[]> => {
    const index = await snapshot(registry);
    const start = resolveSessionRef(index, spec, filters);
    return start ? resolveForkChain(index, start) : [];
  };
}

export function createChildrenService(registry: AdapterRegistry, filters: SessionFilters = {}) {
  return async (spec: string): Promise<SessionSummary[]> =>
    listChildren(await snapshot(registry), spec);
}
