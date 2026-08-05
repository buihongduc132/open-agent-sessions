/**
 * zcode event_id derivation: tool_usage.id (SQLite PK, stable).
 *
 * @file src/extract/zcode.ts
 */
export function deriveZcodeEventId(toolUsageId: string): string {
  return toolUsageId;
}
