# Troubleshooting

## The sidecar badge says "degraded" (search/analytics unavailable)

The Python sidecar enables full-text search and analytics. Without it the app
falls back to basic search automatically.

1. One-time setup: `cd sidecar && uv sync`
2. Restart Pi Desktop.
3. Check logs: `~/Library/Application Support/pi-desktop/logs/*.log` for
   `sidecar` lines.
4. Dev mode requires `sidecar/.venv/bin/uvicorn`; packaged apps bundle the
   binary in `Resources/sidecar/`.

## API keys

- **"secure storage unavailable"** — the macOS Keychain refused access. Unlock
  your keychain or check Keychain Access for denied entries for "Pi Desktop".
- Keys are stored Keychain-encrypted; if decryption fails after a macOS
  restore, re-enter keys in Models (they are never synced).

## Sessions don't appear in the browser

- The indexer runs at boot and every 5 minutes; force it with **Refresh** on
  the Sessions page.
- Sessions live in `~/.pi/agent/sessions/`. The app never writes there except
  through pi itself.

## Search returns nothing

- FTS search needs the sidecar healthy (see above). Basic search still works.
- Special characters are handled, but extremely short terms (< 2 chars) may
  match too much or nothing.

## The app was deleted / won't open after build

If you build locally with a Developer ID signature but without notarization,
some endpoint-security tools (e.g. CleanMyMac) may remove the bundle. Either
exclude the project folder from such tools or build unsigned
(`CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --dir`).

## Terminal panel is blank

- The terminal spawns `$SHELL` in the project root. If your shell profile
  prints errors, they appear in the panel itself.
- If the panel is empty and unresponsive, toggle it closed/open; each toggle
  spawns a fresh PTY.

## Terminal shows "[terminal failed to start: Error: posix_spawnp failed.]"

node-pty 1.1.0 publishes its macOS prebuilds with `spawn-helper` at mode 644 —
no execute bit (microsoft/node-pty#850, fixed upstream only in the 1.2.0
betas). node-pty runs that helper to launch your shell, so the spawn fails
with this message. It is **not** an Electron ABI mismatch, and rebuilding
native modules is not the fix.

Pi Desktop repairs the bit automatically at startup and retries once if a
spawn still fails, so this should self-heal. If you see it anyway:

```bash
npm run fix:pty     # chmod 755 the bundled spawn-helper
```

Then reopen the terminal panel. To confirm the underlying cause:

```bash
ls -l node_modules/node-pty/prebuilds/darwin-*/spawn-helper
# -rw-r--r--  → broken;  -rwxr-xr-x  → correct
```

Packaged builds are covered by the `afterPack` hook in
`build/after-pack.cjs`, which restores the bit inside the `.app` bundle.

## Logs

Everything is logged as JSON lines under
`~/Library/Application Support/pi-desktop/logs/` (14-day retention). Renderer
console output is forwarded there too. No prompts or API keys are logged.

## Reset the app

Quit, then remove `~/Library/Application Support/pi-desktop/` (settings, index,
logs — NOT your pi sessions, which live in `~/.pi/agent/sessions/`).
