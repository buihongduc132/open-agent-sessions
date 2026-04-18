# references/rules.md
# =============================================================================
# pre-commit-guard Rule Registry — open-agent-sessions
#
# HOW TO ADD A NEW RULE:
#   1. Add a new ### R-XX block below (follow the format exactly)
#   2. severity: fail  → commits are BLOCKED if triggered
#      severity: warn   → a warning is printed; commit proceeds
#   3. message: one-line description shown in hook output
#   4. check:  bash snippet; stdout = violation detail; empty = pass
#   5. The pre-commit-guard hook auto-parses this file — no other changes needed
#
# PATTERN FOR DUPLICATION RULES:
#   These rules use ast-grep to detect code duplication patterns.
#   See: ast-grep/rules/dry-rules.yml for the full pattern definitions.
#
#   severity: warn   (never fail — DRY is a guideline, not a law)
#
# =============================================================================

### R-01
severity: fail
message: hook-executable
check: [ -x ".git/hooks/pre-commit" ] && echo OK || echo "not executable: chmod +x .git/hooks/pre-commit"

### R-02
severity: fail
message: no-env-files
check: git diff --cached --name-only | grep -E '\.env(\.|$)' | head -3 || true

### R-03
severity: warn
message: no-binary-files
check: git diff --cached --name-only | xargs -I{} file {} 2>/dev/null | grep -v 'text' | grep -v 'empty' | cut -d: -f1 | head -5 || true

### R-04
severity: warn
message: ast-grep-dry-warn
check: bash scripts/pre-commit-ast-dry.sh warn 2>/dev/null | head -20 || true
note: See ast-grep/rules/dry-rules.yml for full DRY pattern definitions.

### R-05
severity: warn
message: no-direct-readFileSync-utf8
check: |
  git diff --cached --name-only -- '*.ts' \
    | xargs grep -Hn 'readFileSync.*"utf-8"' 2>/dev/null \
    | grep -v 'fs-utils' \
    | grep -v 'src/config' \
    | grep -v '\.test\.ts' \
    | head -5 || true
rationale: |
  Inline readFileSync(..., "utf8") should use fs-utils.ts helpers:
    readJsonFile(path)     — reads + parses a JSON file, returns null on error
    readTextFile(path)     — reads a text file, returns null on error
  Exception: config/load.ts and adapters/acpx.ts (own format), bin/oas (CLI).
  DO NOT add "|| true" suppression — violations should be visible.

### R-06
severity: warn
message: no-direct-readdirSync-json-filter
check: |
  git diff --cached --name-only -- '*.ts' \
    | xargs grep -Hn 'readdirSync.*\.endsWith.*json' 2>/dev/null \
    | grep -v 'fs-utils' \
    | grep -v '\.test\.ts' \
    | head -5 || true
rationale: |
  Inline readdirSync + filter(".json") should use fs-utils.ts helpers:
    listJsonFiles(dir)    — lists *.json files, returns [] on error
  Exception: adapters/acpx.ts uses its own JSON schema (AcpxSession, not generic JSON).

### R-07
severity: warn
message: no-direct-statSync-isFile-guard
check: |
  git diff --cached --name-only -- '*.ts' \
    | xargs grep -Hn 'statSync' 2>/dev/null \
    | grep -v 'fs-utils' \
    | grep -v 'safeStat' \
    | grep -v '\.test\.ts' \
    | grep -v 'opencode.ts' \
    | head -5 || true
rationale: |
  Inline statSync + isFile/isDirectory guards should use fs-utils.ts helpers:
    safeStat(path)        — returns null on error instead of throwing
    assertFile(path)      — throws ENOENT if not a file (for validation paths)
  Exception: opencode.ts:244-252 (retry loop around Database open — retry-specific logic).

### R-08
severity: warn
message: no-inline-date-parse-sort
check: |
  git diff --cached --name-only -- '*.ts' \
    | xargs grep -Hn 'Date\.parse' 2>/dev/null \
    | grep -v 'fs-utils' \
    | grep -v '\.test\.ts' \
    | grep -v 'normalize' \
    | head -5 || true
rationale: |
  Inline Date.parse comparisons should use fs-utils.ts:
    minIso(a, b)  — returns the earlier ISO timestamp
    maxIso(a, b)  — returns the later ISO timestamp
    sortByIso(arr, keyFn) — sorts array by ISO timestamp (keyFn optional)
  Exception: core/normalize.ts (timestamp normalization), TUI rendering.

### R-09
severity: warn
message: no-inline-toLowerCase-includes
check: |
  git diff --cached --name-only -- "*.ts" \
    | xargs grep -Hn "\.toLowerCase()\.includes(" 2>/dev/null \
    | grep -v "fs-utils" | grep -v "\.test\.ts" | grep -v "planner" | grep -v "src/cli" \
    | head -5 || true
rationale: |
  Repeated toLowerCase().includes() should use fs-utils.ts helpers:
    containsIgnoreCase(filePath, needle)  — reads file + does case-insensitive match
    matchesIgnoreCase(text, pattern)       — in-memory case-insensitive match
  Exception: core/search/ (query normalization), planner.ts (query parsing),
             TUI/list-model.ts (filter rendering — output-only).

### R-10
severity: warn
message: no-inline-jsonl-line-split
check: |
  git diff --cached --name-only -- "src/adapters/*.ts" \
    | xargs grep -Hn "split.*r.?n" 2>/dev/null \
    | grep -v "jsonl-utils" | grep -v "\.test\.ts" \
    | head -5 || true
rationale: |
  JSONL files are split by /\r?\n/ in multiple adapters. Extract to:
    src/adapters/jsonl-utils.ts: splitJsonlLines(content: string): string[]
  This handles the \r?\n normalization consistently. Add to fs-utils.ts or a new
  jsonl-utils.ts in adapters/.
  Exception: bin/oas (CLI), src/config/load.ts (own parser), test files.

### R-11
severity: warn
message: no-inline-content-extraction
check: |
  git diff --cached --name-only -- "src/adapters/*.ts" \
    | xargs grep -Hn "extractContentText\|extractContentParts" 2>/dev/null \
    | grep -v "content-utils" | grep -v "\.test\.ts" \
    | head -5 || true
rationale: |
  Content extraction from nested objects (string/array/object) is duplicated
  between codex.ts and claude.ts (~150 lines). Extract to:
    src/adapters/content-utils.ts: extractContentText(), extractContentParts()
  These handle the complex nested content traversal once, not in each adapter.

### R-12
severity: warn
message: no-duplicate-expandTilde-in-config
check: |
  git diff --cached --name-only -- "src/config/load.ts" \
    | xargs grep -Hn "expandTilde\|homedir()\|pathValue.startsWith" 2>/dev/null \
    | grep -v "from.*fs-utils" \
    | head -5 || true
rationale: |
  config/load.ts has its own expandTilde() implementation (lines 86-102)
  that duplicates fs-utils.ts:expandTilde(). Import from fs-utils.ts instead.
  This was noted in the refactoring review but not yet deduped.

### R-13
severity: warn
message: no-duplicate-label-construction
check: |
  git diff --cached --name-only -- "src/adapters/*.ts" \
    | xargs grep -Hn "\`\[\$\{entry\.agent\}" 2>/dev/null \
    | grep -v "createLabel" | grep -v "\.test\.ts" \
    | head -5 || true
rationale: |
  Label construction \`${entry.agent}:${entry.alias}\` is repeated in opencode.ts,
  codex.ts, claude.ts, acpx.ts. Extract to:
    src/adapters/label.ts: createLabel(entry: AgentEntry): string
  This ensures consistent error message formatting across all adapters.

# =============================================================================
# ADDING NEW ADAPTER RULES
#
# When adding a new adapter (e.g. cursor.ts, zed.ts, aider.ts), add a rule
# that verifies the new adapter uses shared backends:
#
# ### R-XX
# severity: warn
# message: adapter-NAME-uses-shared-backend
# check: git diff --cached --name-only -- 'src/adapters/NAME.ts' | xargs grep -Hn 'readFileSync\|Database\|readdirSync' 2>/dev/null | grep -v 'from.*fs-utils' | grep -v 'from.*backends' | head -3 || true
# rationale: |
#   NEW_ADAPTER must use StorageBackend helpers from backends/ or fs-utils.ts.
#   Direct filesystem calls belong in the backend layer, not the adapter.
#
# =============================================================================
