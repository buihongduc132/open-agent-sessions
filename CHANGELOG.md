# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- `oas export` turn-based file export (`--dir`): `--type split_turn|consolidate` (default split_turn, one file per turn), `--prefix` (default `YYYY-MM-DD`), relative turn bounds `--from-relative/--to-relative` (pandas model: `0` = current, `-1` = previous), absolute `--from/--to`, `--with-tools/--with-thinking/--with-*` part inclusion, `--dry-run` preview (first/last 200 chars + tool stats per turn, no disk writes), `--force` collision override, atomic writes, all-or-nothing preflight, alias-scan targeting, exit codes `2` (usage/conflicts) and `3` (dir-mode runtime errors). New modules: `src/core/turns.ts` (turn engine), `src/core/export-sink.ts` (atomic file sink seam), `src/cli/export-options.ts` (flag registry), `src/cli/export-dir.ts` (orchestration). Formatter hardening: YAML-safe frontmatter, dynamic fences, injection escaping, 64KB per-part cap (csf lossless).

### Fixed

- pi adapter `getSessionDetail` returns `null` on not-found (was throw) — aligns with Adapter contract; `Adapter`/registry signatures widened to `SessionDetail | null`.
- export flag parser: value-taking flags consume the next token even when it starts with `-`/`--` (real pi session ids are `--`-prefixed).

### Grok CLI adapter (`src/adapters/grok.ts`): list, time-range, search, tool search, and session detail from `~/.grok/sessions` (or `$GROK_HOME/sessions`). Parses `summary.json` + `chat_history.jsonl` including user text, assistant text, reasoning, and tool calls.

## [0.1.0] - 2026-03-02

### Added

- Initial release of open-agent-sessions
- YAML configuration loading and validation
- Adapter registry with duplicate detection
- SessionSummary normalization across adapters
- OpenCode adapter with SQLite database support
- OpenCode adapter with JSONL file support
- Basic list operations across multiple agents
- Comprehensive test suite (100+ tests passing)

### Features

- Multi-agent architecture (OpenCode implemented, Codex and Claude planned)
- Flexible storage modes (auto, db, jsonl)
- Type-safe TypeScript implementation
- Programmatic adapter API for library usage
- Test-driven development approach

### Documentation

- Complete README with usage examples
- Contributing guidelines with TDD philosophy
- Security policy and best practices
- Code of Conduct (Contributor Covenant 2.0)

[0.1.0]: https://github.com/buihongduc132/open-agent-sessions/releases/tag/v0.1.0
