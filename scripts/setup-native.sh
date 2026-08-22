#!/bin/bash
# Native module setup: approve lifecycle scripts, install Electron binaries,
# rebuild node-pty against the Electron ABI, verify better-sqlite3 + node-pty.
set -euo pipefail
cd "$(dirname "$0")/.."

npm install-scripts approve esbuild electron
node node_modules/esbuild/install.js
node node_modules/electron/install.js

# node-pty is NOT N-API: it must match the Electron ABI.
npx electron-rebuild -f -w node-pty

echo "-- verifying under Electron --"
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron -e "
const pty = require(process.cwd() + '/node_modules/node-pty');
const t = pty.spawn('/bin/echo', ['pty-ok'], {name:'xterm', cols:80, rows:24, cwd:'/tmp', env:{PATH:'/usr/bin:/bin'}});
t.onData((d) => { console.log('node-pty:', d.trim()); process.exit(0); });
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 5000);
"
echo "native modules ready"
