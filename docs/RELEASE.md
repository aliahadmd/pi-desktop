# Release Checklist (v1.x)

Owner: qa · Every step is a hard gate unless explicitly waived by the lead.

## 0. Preconditions

- [ ] All chapters' status docs present and gates passed
- [ ] `main` CI green on the release commit
- [ ] Changelogs updated (`docs/chapter*-status.md` + GitHub release notes draft)
- [ ] Version bumped in `package.json` (single-source; electron-builder inherits)

## 1. Full local verification

```bash
rm -rf out release
npm ci --ignore-scripts
npm install-scripts approve esbuild electron
node node_modules/esbuild/install.js && node node_modules/electron/install.js
npx electron-rebuild -f -w node-pty
npm run typecheck && npm test && npm run e2e
cd sidecar && uv sync && uv run pytest -q && uv run mypy app/ && cd ..
./scripts/check-secrets.sh
npm audit --omit=dev          # must be clean
cd sidecar && uv run pip-audit --skip-editable   # must be clean
```

## 2. Build sidecar binary

```bash
cd sidecar
uv run pyinstaller --onefile --name pi-desktop-sidecar run.py \
  --hidden-import uvicorn.logging --hidden-import uvicorn.loops.auto \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.websockets.auto \
  --hidden-import uvicorn.lifespan.on \
  --hidden-import app.main --collect-submodules app
# smoke:
PI_DESKTOP_TOKEN=x ./dist/pi-desktop-sidecar --port 9899 &
curl -s http://127.0.0.1:9899/health && kill %1
```

## 3. Package, sign, notarize

```bash
npm run dist:mac:dmg
```

electron-builder reads signing/notarization config from env (CI) or keychain.
**Never ship a Developer-ID-signed but unnotarized build** — such builds were
observed being removed by endpoint-security software.

Manual checks on a clean machine:
- [ ] Gatekeeper opens the app without friction
- [ ] First-run onboarding appears; API key round-trip via Keychain works
- [ ] Real prompt streams; tool calls render; diff review works
- [ ] Sidecar badge reaches healthy; FTS search returns hits with snippets
- [ ] Terminal opens and echoes; closes without orphan processes
- [ ] Notifications fire when window unfocused
- [ ] Restart restores window bounds; sessions browser lists history

## 4. Update-path test

- Install previous release → launch → verify auto-update downloads and installs
  the new version on quit (or document feed not-yet-live for first release).

## 5. Publish

- [ ] Tag `vX.Y.Z` pushed → `release.yml` builds signed+notarized dmg/zip
- [ ] SHA256SUMS attached to the GitHub release
- [ ] Release notes: highlights, known issues, upgrade notes
- [ ] Announce; archive artifacts per retention policy

## Rollback

If a release is broken: delete the GitHub release draft (auto-update serves
only published releases), fix forward with a patch bump. The app's About panel
records the exact pi package version for support.
