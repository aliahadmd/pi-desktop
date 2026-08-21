#!/bin/bash
# Secrets audit — fails when potential credentials are committed.
# Run in CI and pre-release. See docs/SECURITY.md.
set -uo pipefail
cd "$(dirname "$0")/.."

PATTERNS=(
  "sk-ant-[A-Za-z0-9_-]{20,}"          # Anthropic keys
  "sk-proj-[A-Za-z0-9_-]{20,}"         # OpenAI project keys
  "sk-[A-Za-z0-9]{40,}"                # generic OpenAI-style
  "AKIA[0-9A-Z]{16}"                   # AWS access key id
  "AIza[0-9A-Za-z_-]{35}"              # Google API key
  "ghp_[A-Za-z0-9]{36,}"               # GitHub PAT
  "xox[baprs]-[A-Za-z0-9-]{10,}"       # Slack tokens
  "-----BEGIN (RSA |EC )?PRIVATE KEY-----"
)

FAILED=0
for pattern in "${PATTERNS[@]}"; do
  # Search tracked files only; exclude lockfiles (false positives on hashes) and tests fixtures with obvious dummies.
  HITS=$(git ls-files 2>/dev/null | grep -v -E "(package-lock.json|uv.lock|tests/fixtures)" | xargs grep -lE "$pattern" 2>/dev/null)
  if [ -n "$HITS" ]; then
    echo "SECRET PATTERN HIT ($pattern):"
    echo "$HITS"
    FAILED=1
  fi
done

if [ "$FAILED" -eq 0 ]; then
  echo "secrets check: clean"
fi
exit $FAILED
