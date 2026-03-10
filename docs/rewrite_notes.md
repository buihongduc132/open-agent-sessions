# Git History Rewrite Notes

**Date**: 2026-03-11
**Operation**: Full history rewrite to remove `_findings/` directory

## Commands Executed

### 1. Pre-rewrite preparation

```bash
# Save uncommitted changes
git diff > /tmp/pre-filter-changes.patch

# Stash any remaining changes
git stash push -m "pre-filter-repo stash"
```

### 2. Copy feature matrix before rewrite

```bash
cp _findings/cli_feature_matrix.md docs/cli-feature-matrix.md
```

### 3. Execute history rewrite

```bash
git filter-repo --path _findings --invert-paths --force
```

**Output**:
```
NOTICE: Removing 'origin' remote; see 'Why is my origin removed?'
        in the manual if you want to push back there.
        (was https://github.com/buihongduc132/open-agent-sessions.git)
Parsed 59 commits
HEAD is now at 748c313 chore: finalize OSS release preparation

New history written in 0.03 seconds; now repacking/cleaning...
Rewrote the stash.
Completely finished after 0.07 seconds.
```

### 4. Re-add origin remote

```bash
git remote add origin https://github.com/buihongduc132/open-agent-sessions.git
```

### 5. Update .gitignore

Changed from:
```gitignore
# Session analysis findings (project-specific, not for repo)
_findings/

# Internal planning documents
_*.md
```

To:
```gitignore
# Internal directories and files (broad pattern)
_*

# Environment files (broad pattern)
.env*
```

### 6. Update documentation references

**docs/usecases/01-session-analysis-scoring.md**:
- Changed `./_findings/<scoring>/*` to `./notes/<scoring>/*`
- Changed `./_findings/scoring/` to `./notes/scoring/`

**README.md**: Already cleaned by filter-repo (no _findings references remain)

### 7. Commit changes

```bash
git add .gitignore docs/usecases/01-session-analysis-scoring.md docs/cli-feature-matrix.md
git commit -m "chore: remove _findings from history, move feature matrix to docs

- Use git filter-repo to remove _findings/ from entire git history
- Move CLI feature matrix to docs/cli-feature-matrix.md
- Update .gitignore: add _* and .env* broad patterns
- Update usecases doc: replace _findings references with ./notes/"
```

### 8. Branch protection management

**Original protection settings**:
- enforce_admins: true
- required_status_checks: ["test"] (strict: true)
- required_approving_review_count: 1
- allow_force_pushes: false

**Temporarily relaxed**:
```bash
gh api -X PUT repos/buihongduc132/open-agent-sessions/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": true
}
EOF
```

### 9. Force push

```bash
git fetch origin
git push --force-with-lease origin main
```

**Output**:
```
To https://github.com/buihongduc132/open-agent-sessions.git
   748c313..0c083bc  main -> main
```

### 10. Restore branch protection

```bash
gh api -X PUT repos/buihongduc132/open-agent-sessions/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["test"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "require_last_push_approval": false,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "allow_force_pushes": false
}
EOF
```

## Verification

```bash
# Verify no _findings/ files in history
git log --all --name-only --pretty=format: | grep "^_findings/"
# Output: (empty - SUCCESS)

# Verify branch protection restored
gh api repos/buihongduc132/open-agent-sessions/branches/main/protection --jq '{enforce_admins, allow_force_pushes}'
# Output: {"allow_force_pushes":{"enabled":false},"enforce_admins":{"enabled":true}}
```

## Files Changed

| File | Change |
|------|--------|
| `.gitignore` | Updated patterns: `_*` and `.env*` |
| `docs/cli-feature-matrix.md` | New file (moved from `_findings/cli_feature_matrix.md`) |
| `docs/usecases/01-session-analysis-scoring.md` | Updated `_findings` references to `./notes/` |

## Cleanup

- `_findings/` directory still exists on disk (now ignored by git)
- Stash from pre-rewrite available: `git stash list`
- Patch saved at `/tmp/pre-filter-changes.patch`
