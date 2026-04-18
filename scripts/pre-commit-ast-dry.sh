#!/usr/bin/env bash
# =============================================================================
# pre-commit-ast-dry.sh
#
# Runs ast-grep DRY rules on staged TypeScript files.
# Called by pre-commit-guard (R-04).
#
# Usage:
#   bash scripts/pre-commit-ast-dry.sh        # show all violations
#   bash scripts/pre-commit-ast-dry.sh warn    # show only WARN level
#   bash scripts/pre-commit-ast-dry.sh fail    # show only FAIL level
#
# Exit codes:
#   0 = no violations found, or WARN-only mode with no failures
#   1 = FAIL-level violations found
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

MODE="${1:-all}"

RULES_FILE="$REPO_DIR/ast-grep/rules/dry-rules.yml"

# No rules file = nothing to check
if [ ! -f "$RULES_FILE" ]; then
  echo "(no dry-rules.yml found — skipping)"
  exit 0
fi

# ast-grep not installed = graceful skip
if ! command -v ast-grep >/dev/null 2>&1; then
  echo "(ast-grep not found — install with: cargo install ast-grep)"
  exit 0
fi

# Get list of staged .ts files
STAGED_FILES=$(git --no-pager diff --cached --name-only -- "*.ts" | xargs -I{} echo "$REPO_DIR/{}" 2>/dev/null || true)

if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

echo "=== ast-grep DRY scan on staged files ==="

VIOLATIONS=0

scan_rule() {
  local rule_id="$1"
  local message="$2"
  local pattern="$3"
  local severity="$4"

  # Skip fail-level in warn mode
  if [ "$MODE" = "warn" ] && [ "$severity" = "FAIL" ]; then
    return 0
  fi

  # Build ast-grep command
  local result
  result=$(ast-grep search --pattern "$pattern" --lang TypeScript --json 2>/dev/null \
    $STAGED_FILES 2>/dev/null | head -20 || true)

  if [ -n "$result" ]; then
    local icon="WARN"
    if [ "$severity" = "FAIL" ]; then
      icon="FAIL"
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
    echo "  $icon $rule_id"
    echo "    $message" | head -3 | sed 's/^/      /'
    local count=$(echo "$result" | grep -c "ruleId" 2>/dev/null || echo "1")
    echo "    ($count occurrence(s) in staged files)"
    echo ""
  fi
}

# Read rules from dry-rules.yml and scan
# Format: rule_id|severity|message (pipe-delimited for shell parsing)
grep -A3 "id: DRY-" "$RULES_FILE" 2>/dev/null | while IFS= read -r line; do
  case "$line" in
    "    message:"*)
      # Extract message (may span multiple lines)
      msg=$(echo "$line" | sed 's/.*message: *//')
      ;;
    "    severity: WARN"*|"    severity: FAIL"*)
      sev=$(echo "$line" | awk '{print $2}')
      ;;
    "    ruleShorthand:"*)
      # Pattern is on this or next line
      pattern=$(echo "$line" | sed 's/.*ruleShorthand: *//')
      ;;
    "- id: DRY-"*)
      id=$(echo "$line" | sed 's/.*- id: *//' | tr -d ' ')
      ;;
  esac
done

# Simpler approach: run ast-grep scan with --config and filter output
if [ -f "$RULES_FILE" ]; then
  SCAN_OUTPUT=$(ast-grep scan --config "$RULES_FILE" --lang TypeScript \
    $STAGED_FILES --json 2>/dev/null | head -100 || true)

  if [ -n "$SCAN_OUTPUT" ]; then
    VIOLATIONS=$((VIOLATIONS + 1))
    echo "$SCAN_OUTPUT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if isinstance(data, list):
        for item in data[:10]:
            print(f\"  WARN {item.get('ruleId', 'unknown')}\")
            loc = item.get('range', {})
            print(f\"    {item.get('file', '?')}:{loc.get('start', {}).get('line', '?')}\")
            print(f\"    {item.get('message', '')[:100]}\")
    elif isinstance(data, dict):
        results = data.get('results', data.get('results', []))
        for item in results[:10]:
            print(f\"  WARN {item.get('ruleId', 'unknown')}\")
            loc = item.get('range', {})
            print(f\"    {item.get('file', '?')}:{loc.get('start', {}).get('line', '?')}\")
except: pass
" 2>/dev/null || true
  else
    echo "  ✓ ast-grep DRY scan: no violations"
  fi
fi

echo "─────────────────────────────────────────────────────────────"

if [ "$VIOLATIONS" -gt 0 ]; then
  echo "  → Run 'ast-grep scan --config ast-grep/rules/dry-rules.yml src/' for full output"
  echo "  → Use fs-utils.ts helpers: readJsonFile, listJsonFiles, safeStat, minIso, maxIso"
  echo "  → See references/rules.md §R-05 through §R-09"
  [ "$MODE" = "fail" ] && exit 1 || exit 0
else
  echo "  ✓ ast-grep DRY scan passed"
  exit 0
fi