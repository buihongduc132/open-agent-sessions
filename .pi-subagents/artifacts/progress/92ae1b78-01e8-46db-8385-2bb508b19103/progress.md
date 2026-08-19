# Scout Progress

## Status: COMPLETE

Pi session JSONL schema fully mapped. Context brief written to output path.

## Findings Summary
- 9 block types identified
- toolCall → toolResult linking via `toolCall.id` === `toolResult.toolCallId`
- No duration field in JSONL; must compute from timestamp deltas
- Dir encoding: `--` + `cwd.slice(1).replace(/\//g, '-')` + `--`
- Bash command at `message.content[i].arguments.command`
