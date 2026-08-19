# Pi Session JSONL Schema — Context Brief

## 1. Directory Encoding (CWD → dir name)

**Pattern**: `--` + `cwd.slice(1).replace(/\//g, '-')` + `--`

```
/home/bhd/Documents/Projects/bhd/open-agent-sessions
→ --home-bhd-Documents-Projects-bhd-open-agent-sessions--
```

- Strip leading `/`, replace all remaining `/` with `-`, wrap with `--` prefix and `--` suffix
- Dots preserved as-is (`.worktrees/` → `-.worktrees-`)
- Special file at root: `deploy-session.jsonl` (not in a CWD dir)

## 2. Session Filename Pattern

```
<ISO-timestamp>_<uuid>.jsonl
2026-07-24T07-45-55-493Z_019f9316-8925-7f9e-a23a-c31c751e845e.jsonl
```

- Timestamp uses `-` instead of `:` for filesystem safety
- UUID is the session ID (matches `session.id` field inside the JSONL)
- Companion directory with same basename (no `.jsonl`) holds hex-named attachment subdirs

## 3. All Block Types Found

| `type` value | Description |
|---|---|
| `session` | First line. Session metadata (cwd, parentSession, version) |
| `model_change` | Model/provider switch |
| `thinking_level_change` | Thinking level adjustment |
| `session_info` | Session name/alias |
| `message` | Core conversation (role: `assistant`, `user`, `toolResult`) |
| `custom` | Extension events (customType: `extmgr-auto-update`, `intercom_sent`, `pi-goal-focus`, `pi-goal-state`, `session-title-interval-state`) |
| `custom_message` | Extension-injected messages (customType: `subagent_control_notice`) |
| `branch_summary` | Summary of a divergent branch exploration |
| `compaction` | Context compaction event with summary text |

## 4. Message Envelope (all roles)

```json
{
  "type": "message",
  "id": "6f288677",           // 8-char hex ID
  "parentId": "afd918e1",     // 8-char hex, forms chain
  "timestamp": "2026-07-24T03:27:03.749Z",
  "message": { ... }          // role-specific payload
}
```

## 5. Assistant Message Shape

```json
{
  "role": "assistant",
  "content": [
    { "type": "thinking", "thinking": "...", "thinkingSignature": "reasoning_content" },
    { "type": "text", "text": "..." },
    { "type": "toolCall", "id": "call_xxx", "name": "bash", "arguments": { "command": "..." } }
  ],
  "api": "openai-completions",
  "provider": "bhd-litellm",
  "model": "role-smart",
  "usage": {
    "input": 48932, "output": 124,
    "cacheRead": 24256, "cacheWrite": 0,
    "reasoning": 75, "totalTokens": 73312,
    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 }
  },
  "stopReason": "toolUse",
  "timestamp": 1784863569826,
  "responseId": "20260724112611e165a121b2ea4a15"
}
```

### Content block types (inside `content[]`):
- `thinking` — `{ type, thinking, thinkingSignature }`
- `text` — `{ type, text }`
- `toolCall` — `{ type, id, name, arguments }`

## 6. Bash toolCall Block Structure

```json
{
  "type": "toolCall",
  "id": "call_32caa6a54665434ebbc91100",
  "name": "bash",
  "arguments": {
    "command": "cat ~/.pi/agent/session-activity-cache.json 2>/dev/null | python3 -c \"...\" 2>&1 | head -80"
  }
}
```

**Path to command**: `message.content[i].arguments.command`

### 3 bash toolCall samples:

**Sample 1** (complex multiline):
```json
{ "type": "toolCall", "id": "call_32caa6a54665434ebbc91100", "name": "bash",
  "arguments": { "command": "cat ~/.pi/agent/session-activity-cache.json 2>/dev/null | python3 -c \"\nimport json, sys\ndata = json.load(sys.stdin)\nprint(f'Version: {data.get(\\\"version\\\")}')\n...\" 2>&1 | head -80" } }
```

**Sample 2** (simple):
```json
{ "type": "toolCall", "id": "call_f47be12f8ad4477e8f2de686", "name": "bash",
  "arguments": { "command": "openspec list --json 2>&1 | head -30" } }
```

**Sample 3** (chained):
```json
{ "type": "toolCall", "id": "call_f191384ca3464a8c90968971", "name": "bash",
  "arguments": { "command": "ls -la ../open-agent-session/ 2>/dev/null && echo \"---\" && find ../open-agent-session -maxdepth 3 -type f -name \"*.ts\" -o -name \"*.json\" -o -name \"*.md\" 2>/dev/null | head -80" } }
```

## 7. toolResult Block Structure (role = "toolResult")

Tool results are **separate message entries** with `role: "toolResult"`, NOT inline content blocks.

```json
{
  "type": "message",
  "id": "e38d3f73",
  "parentId": "6f288677",
  "timestamp": "2026-07-24T03:27:03.899Z",
  "message": {
    "role": "toolResult",
    "toolCallId": "call_f33d188c141c4538848a51c2",
    "toolName": "fffind",
    "content": [
      { "type": "text", "text": "file1.ts\nfile2.ts\n..." }
    ],
    "details": null,
    "isError": false,
    "timestamp": 1784863623820
  }
}
```

### toolResult fields:
| Field | Type | Description |
|---|---|---|
| `role` | `"toolResult"` | Always this role |
| `toolCallId` | string | Links to `toolCall.id` |
| `toolName` | string | Tool name (`bash`, `read`, `fffind`, etc.) |
| `content` | `Array<{type: "text", text: string}>` | Output text |
| `details` | `object \| null` | Tool-specific metadata (e.g., `{totalMatched, totalFiles, pageIndex, hasMore}` for find; `null` for bash; `{}` for bash errors) |
| `isError` | boolean | Error flag |
| `timestamp` | number | Unix ms timestamp |

## 8. Duration / Error Info

**No duration field exists in JSONL.** Key findings:
- `details` is `null` for successful bash calls
- `details` is `{}` for failed bash calls (no error message in details)
- `isError: true` signals failure; error text appears in `content[0].text` (e.g., "Command exited with code 2")
- No timing/duration metadata stored anywhere in the JSONL
- Duration would need to be computed from timestamp deltas between toolCall message and toolResult message

## 9. User Message Shape

```json
{
  "type": "message",
  "id": "afd918e1",
  "parentId": "77c0d004",
  "timestamp": "2026-07-24T03:26:04.694Z",
  "message": {
    "role": "user",
    "content": [{ "type": "text", "text": "..." }],
    "timestamp": 1784863563351
  }
}
```

## 10. Session Block (first line)

```json
{
  "type": "session",
  "version": 3,
  "id": "019f9316-8925-7f9e-a23a-c31c751e845e",
  "timestamp": "2026-07-24T07:45:55.493Z",
  "cwd": "/home/bhd/Documents/Projects/bhd/open-agent-sessions",
  "parentSession": "/home/bhd/.pi/agent/sessions/--home-bhd-Documents-Projects-bhd-pi-plugins--/2026-07-24T03-21-43-264Z_019f9224-a660-77ca-851f-d06ab0920e85.jsonl"
}
```

## 11. Other Notable Blocks

**model_change**: `{ type, id, parentId, timestamp, provider, modelId }`
**thinking_level_change**: `{ type, id, parentId, timestamp, thinkingLevel }`
**session_info**: `{ type, id, parentId, timestamp, name }` where name = `dir_e_bhd_Documents_Projects_bhd_open-agent-sessions_6d412bf9`
**compaction**: `{ type, id, parentId, timestamp, summary }` — summary is a markdown text of compacted conversation
**branch_summary**: `{ type, id, parentId, timestamp, fromId, summary, details, fromHook }`

## 12. Parser Implementation Notes

- **Linking toolCall → toolResult**: match `toolCall.id` === `toolResult.toolCallId`
- **Duration calc**: `toolResult.timestamp - toolCall.message.timestamp` (both available; toolResult has unix-ms `timestamp`, toolCall is inside assistant message with ISO `timestamp`)
- **Bash command extraction**: iterate `message.content[]`, filter `type === "toolCall"` && `name === "bash"`, read `arguments.command`
- **Error detection**: check `toolResult.isError` boolean
- **Chain reconstruction**: `id` → `parentId` linked list across all entries
- **Attachment dirs**: hex-named subdirs alongside JSONL contain tool output artifacts (run-0, etc.)
