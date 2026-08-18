# References

> Sources consulted during this explore session.

## Source files

- `src/cli/read.ts` — read command, USAGE string, `parseSelectionOptions`, `runReadCommand` format dispatch, `ReadOptions`/`ReadService` types. The primary change target.
- `src/cli/formatters/text.ts` (354 lines) — `formatSessionDetail`, `formatMessage`, `formatPart` (the exact functions where verbosity lives). `--tools` precedent lives here.
- `src/cli/sessions.ts` — sessions list command, `parseTimeRange` (24h default), `formatSessionRow`.
- `src/cli/detail.ts` — metadata-only detail command; has its OWN `formatDetail` (separate from `formatSessionDetail`); NOT a target.
- `src/cli/utils/config.ts` — `resolveConfig`, `configPath`/`loadConfig` plumbing.
- `src/core/types.ts` — `SessionReadMode` (last_message | all_no_tools | all_with_tools), `MessageSelectionMode` (first | last | all | range | user-only), `SessionReadOptions`.
- `src/core/export.ts` (292 lines) — `toCsf` (Canonical Session Format, machine format), `toMarkdown`, `toText` — all include reasoning+tools by default, untouched by the change.
- `src/core/registry.ts` — `detailCache` LRU(50), `ensureUniqueAliases`, `buildHandle` (wraps factory errors), eager adapter construction → one broken adapter kills the whole CLI.
- `src/adapters/zcode.ts:134` — `throw new Error(\`${label} database not found: ${resolvedPath}\`)` at adapter construction.
- `src/adapters/pi.ts:318-345` — path resolution: `defaultPath = ~/.pi/sessions`, `resolvePath(configured ?? defaultPath, configDir)`, throws if missing.
- `bin/oas` (1093 lines) — CLI entry, service creation (`createReadService`, `createAllAgentFactories`), `handleSessionListSubcommand`, deprecated shims (`list`, `read`, `detail`, `search`, `clone`, `export`, `similar`).
- `oas.config.yaml` — project config (opencode/codex/hermes/zcode/gemini/antigravity/pi×2).
- `package.json` — bin entry `"oas": "./bin/oas"`, scripts, exports map.
- `test/cli-text-formatter.test.ts` — 30 assertions on verbose output.
- `test/cli-read-coverage.test.ts` — 25 assertions on verbose output.
- `test/cli-read-composable.test.ts` — 26 assertions on verbose output.
- `test/cli-gaps-edge-cases-2.test.ts` — 4 assertions on verbose output.
- `~/.omp/agent/sessions/` — pi (oh-my-pi) session storage (probed for real data).
- `~/.local/share/opencode/opencode.db` — opencode SQLite session store (probed via `bun -e 'SELECT id FROM session ORDER BY time_updated DESC LIMIT 1'`).
- `/tmp/oas.config.yaml.bak` — backup of original config before zcode disable workaround.

## Documents

- `~/.pi/agent/prompts/_references/10-ospx-explore/search-strategies.md` — explore-mode search playbook (quality threshold >100★, scenario table, output format).
- `flow/read_options/inventory.yml` — exists (read-options inventory, not directly consulted).
- `flow/mcp/inventory.yml` — exists (not directly consulted).
- `docs/oas-cli-testing-report.md` — grep hit for `oas session read` references.
- `README.md` — grep hit for `oas session read`/`ln` usage examples.
- `gptme/issues/1999` — "fix(server): hide reasoning blocks from visible output" (VisibleOutputSanitizer, REVERTED by #2001).
- `gptme/issues/2001` — revert of #1999: reasoning blocks should reach webui; terminal preserves full content in log.
- `gptme/issues/2807` — "hide injected agent-instructions from conversation view"; `hide=True` display-only flag pattern.
- `gptme/docs/commands.html` — `/log` shows visible messages only; `/log --hidden` includes hidden.
- `gptme/docs/cli.html` — `--show-hidden`, `--reasoning` CLI flags.

## Code patterns

- **`--tools` precedent** (in `src/cli/formatters/text.ts` `formatPart`): tool parts hidden by default, opt-in via `options?.showTools`. Identical pattern to be applied for reasoning.
- **Display-layer filtering, data-path untouched** (gptme lesson from #1999→#2001 revert): never strip at serialization/adapter layer; filter only at the formatter that renders for humans.
- **Eager adapter registry build** (in `src/core/registry.ts` `buildHandle`): one adapter factory throw = entire CLI dead. OT4 documents the zcode manifestation.
- **`SessionReadMode` vs `MessageSelectionMode`** (in `src/core/types.ts`): two orthogonal axes — tool visibility at adapter level, message selection at query level. Change is purely at `formatPart` display layer; neither axis needs to move.
