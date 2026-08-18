# Explore Turn 2 — formatter internals + CLI dispatch

> Date: 2026-08-19
> Phase: deep code read (formatter, sessions cmd, bin dispatch, export module)
> Status: complete (investigation only, no prose this turn)

## User message

> **[user]** (verbatim — trust chain L1)
>
> continue

## Assistant investigation (tool work — no prose this turn)

### `src/cli/sessions.ts` (full read)

USAGE verbatim:

```
Usage: oas sessions [options]

Options:
  --last DURATION     Last duration (e.g., 4h, 2d, 1w)
  --since TIMESTAMP   Start time (ISO-8601 format)
  --until TIMESTAMP   End time (ISO-8601 format)
  --limit N           Maximum results (default: 50, 0 = all)
  --format FORMAT     Output format: text (default) or json

Time formats:
  --last 4h           Last 4 hours
  --last 2d           Last 2 days
  --last 1w           Last 1 week
  --since 2026-03-05T14:00:00Z
  --until 2026-03-08T00:00:00Z

Default: last 24h, limit 50, text format
```

Facts: `SessionsOptions` has `full?`, `showAlias?` flags; rows via `formatSessionRow(s, {full, showAlias})`; parseTimeRange defaults to 24h window when no time filters AND no explicit `--limit`.

### `src/cli/formatters/text.ts` (full 354-line read) — THE change target

Key functions verbatim:

```typescript
export interface TextFormatterOptions {
  showTools?: boolean;
}

export function formatSessionDetail(
  detail: SessionDetail,
  target: ReadQuery,
  options?: TextFormatterOptions
): string {
  const lines: string[] = [];

  // Header
  const title = normalizeTitle(detail.title, detail.id);
  const agentAlias = `[${detail.agent}:${detail.alias}]`;
  lines.push(`Session ${agentAlias}`);
  lines.push(`id: ${detail.id}`);
  lines.push(`title: ${title}`);
  if (detail.parentSessionId !== undefined) {
    lines.push(`parent: ${detail.parentSessionId}`);
  }
  lines.push(`created_at: ${formatLocalTimestamp(detail.created_at)}`);
  lines.push(`updated_at: ${formatLocalTimestamp(detail.updated_at)}`);
  lines.push(`message_count: ${detail.message_count}`);
  lines.push(`storage: ${detail.storage}`);
  lines.push("");

  // Warning (if any)
  if (detail.warning) {
    lines.push(`Warning: ${detail.warning}`);
    lines.push("");
  }

  // Messages - show only if there are messages
  const messages = detail.messages ?? [];
  if (messages.length > 0) {
    lines.push(`Messages (${messages.length}):`);
    lines.push("---");
    for (const message of messages) {
      lines.push(...formatMessage(message, options));
      lines.push("---");
    }
  }
  // If no messages, show metadata only (no "No messages." text)

  return lines.join("\n");
}
```

```typescript
export function formatMessage(
  message: SessionMessage,
  options?: TextFormatterOptions
): string[] {
  const lines: string[] = [];
  const roleBadge = formatRoleBadge(message.role);
  const timestamp = formatLocalTimestamp(message.created_at);

  // Build agent/model suffix
  let agentModel = "";
  if (message.agent || message.modelID) {
    const agent = message.agent || "";
    const model = message.modelID || "";
    agentModel = ` (${agent}/${model})`;
  }

  // Format: "> USER (agent/model) @ timestamp"
  const metadata = formatMetadata(`${agentModel} @ ${timestamp}`);
  lines.push(`${roleBadge}${metadata}`);
  lines.push("");

  for (const part of message.parts) {
    lines.push(...formatPart(part, options));
  }

  return lines;
}
```

```typescript
export function formatPart(
  part: SessionPart,
  options?: TextFormatterOptions
): string[] {
  if (part.type === "text") {
    const text = (part as { text: string }).text.trim();
    return text.split("\n").map((line) => `  ${line}`);
  }

  if (part.type === "tool") {
    const toolPart = part as { tool: string; state: Record<string, unknown> };
    
    // By default, hide tool messages unless showTools is true
    if (!options?.showTools) {
      return [];
    }
    
    // Show tool name and status when --tools flag is used
    const status = toolPart.state?.status ?? "unknown";
    return [`  [tool: ${toolPart.tool} - ${status}]`];
  }

  if (part.type === "reasoning") {
    const reasoningPart = part as { text: string };
    return [`  [reasoning]`, ...reasoningPart.text.trim().split("\n").map((l) => `    ${l}`)];
  }

  // Unknown part type
  return [`  [${part.type}]`];
}
```

**Structural observation (drives everything later):** tool parts already follow hide-by-default + `--tools` opt-in at the FORMATTER layer. Reasoning parts have NO such gate — always rendered in full. This is the exact precedent for the requested change.

Also in text.ts: `formatSessionRow` (list rows: `[agent:alias] [sub]|[main] title (id)`, 100-char truncate unless `full`), `formatSessionRowSimple` (used by search/children/tree), `formatErrors`, `formatRelativeTime`, `formatLocalTimestamp`, `truncateId`, `truncateText`. `formatSessionDetailJson` delegates to `formatMessagesJson` with `{includeTools: options?.showTools}`.

### `bin/oas` dispatch (lines 955–1093 + 880–955)

- `main()` routes: `session` → `handleSessionCommand`; `config`, `onboard` (shells to `bd onboard`), `tui`; then DEPRECATED SHIMS: `list|recent` → `session list`, `sessions` → sessions handler, `list-new`, `find|show` → detail, `detail`, `read` → `handleReadCommand`, `search`, `clone`, `export`, `similar`. Each shim prints a deprecation notice.
- `handleSessionListSubcommand`: `--limit` validation; time-range flags (`--last/--since/--until`) → sessions handler, else → list handler with `--agent/--alias/--q/--roots-only/--sub-only/--children-of` + positional limit N; bare `oas session` = `session list` default.
- Help text shows the surface: `session read <id>`, `oas session read abc123 --last 20`, etc.
- Service creation in bin/oas: `createReadService` finds adapter by (agent, alias) in registry → `adapter.getSessionDetail(query.id, options)`. Adapter factories: opencode/codex/claude/hermes/gemini/antigravity/pi/zcode.

### `~/.pi/agent/prompts/_references/10-ospx-explore/search-strategies.md` (read per cmd mandate)

Playbook highlights applied later: >100-star repo threshold only; prefer recent/active; read issues + fix commits not README marketing; cross-reference ≥2 sources; output format = What exists / What to cherry-pick / What to avoid / Recommendation. Scenario 2 (pattern/best-practice) fits this explore.

### `src/core/export.ts` (part 1: lines 1–120)

`toCsf()` — Canonical Session Format: `{version:"1.0", source:{agent,alias,session_id,title,created_at,updated_at,message_count}, messages:[CsfMessage], clone?, exported_at, parent_session_id?}`. `CsfMessage = {id, role, created_at, modelID?, agent?, parts:[CsfPart]}` — parts passed through as-is (`toCsfPart` = identity cast). CSF is a MACHINE format — cross-agent transfer.

## Status at end of turn 2

Formatter layer fully mapped: header (8 lines) + badge format + part-type rendering; `--tools` precedent identified at formatter layer. Dispatch + shims mapped. → Turn 3 covers export.ts rest, core types, test inventory, and first live runs (hits zcode wall).
