/**
 * LD3 (f) — --follow mode: diff consecutive runs.
 *
 * Compares two result sets by event_id; returns added + removed.
 *
 * @file src/query/follow.ts
 */

export interface FollowDiff<T> {
  added: T[];
  removed: T[];
}

/**
 * Diff two runs. `added` = in run2 not in run1; `removed` = vice versa.
 * T must have an `event_id` field for identity.
 */
export function diffFollow<T extends { event_id: string }>(
  run1: T[],
  run2: T[],
): FollowDiff<T> {
  const ids1 = new Set(run1.map((r) => r.event_id));
  const ids2 = new Set(run2.map((r) => r.event_id));
  const added = run2.filter((r) => !ids1.has(r.event_id));
  const removed = run1.filter((r) => !ids2.has(r.event_id));
  return { added, removed };
}
