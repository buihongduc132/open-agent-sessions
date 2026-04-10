#!/usr/bin/env bash
#
# check-no-secrets.sh
# Scans source files for accidentally committed credentials/secrets.
# Exits non-zero if anything suspicious is found.
#
# Usage: bash scripts/check-no-secrets.sh

set -euo pipefail

# Pattern matches assignments like: password = "abc123", api_key: "xyz..."
# that contain plausible secret values (8+ base64-like chars)
SECRET_PATTERN='(password|secret|api[_-]?key|token|credential|private[_-]?key)\s*[:=]\s*["\x27][a-zA-Z0-9+/]{8,}["\x27]'

echo "=== Scanning for credentials / secrets ==="

# Scan src/, bin/, test/ only — .git/ is never relevant
FOUND=$(grep -r -i -E "$SECRET_PATTERN" \
  --include="*.ts" \
  --include="*.js" \
  --include="*.json" \
  --include="*.yaml" \
  --include="*.yml" \
  src/ bin/ test/ \
  2>/dev/null || true)

if [ -n "$FOUND" ]; then
  echo "SECRETS DETECTED — aborting"
  echo "$FOUND"
  exit 1
fi

echo "No secrets detected ✓"
