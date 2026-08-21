#!/bin/bash
# Upstream pi tracking (chapter 8 policy).
# Checks whether @earendil-works/* has newer releases than our pins and, when
# PI_RUN_CONTRACT_TESTS=1, runs our contract suites against the new version in
# a throwaway install. Weekly CI job + on-demand.
set -uo pipefail
cd "$(dirname "$0")/.."

echo "== pinned versions =="
node -e "
const pkg = require('./package.json');
for (const [name, ver] of Object.entries(pkg.dependencies)) {
  if (name.startsWith('@earendil-works/')) console.log(name, ver);
}
"

echo
echo "== latest published =="
OUTDATED=$(npm outdated @earendil-works/pi-coding-agent @earendil-works/pi-ai @earendil-works/pi-agent-core @earendil-works/pi-client @earendil-works/pi-protocol 2>/dev/null || true)
if [ -z "$OUTDATED" ]; then
  echo "all pi packages up to date"
else
  echo "$OUTDATED"
  echo
  echo "ACTION: bump pins, then run the contract battery:"
  echo "  npm install --save-exact @earendil-works/pi-coding-agent@<new>"
  echo "  npm run typecheck && npm test && npm run e2e"
  echo "Changelog diff: https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md"
  if [ "${PI_RUN_CONTRACT_TESTS:-0}" = "1" ]; then
    echo "PI_RUN_CONTRACT_TESTS=1 — running contract battery against latest..."
    npm install --save-exact --ignore-scripts @earendil-works/pi-coding-agent@latest
    node node_modules/electron/install.js >/dev/null 2>&1
    npm run typecheck && npm test && npm run e2e
  fi
fi
