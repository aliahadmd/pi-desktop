# Chapter 8 Status — Hardening & Release: COMPLETE

Date: 2026-08-22 · Owners: qa + core · Gate: passed

## What was built

**Security hardening**
```
tests/unit/security-fuzz.test.ts   Adversarial IPC corpus (proto-pollution, huge
                                   payloads, injection shapes, symbols, NaN/Inf,
                                   non-serializables): router must always return
                                   structured results, never hang, never leak stacks.
                                   Found+fixed a real crash: JSON.stringify(Symbol())
                                   → undefined crashed truncate().
scripts/check-secrets.sh           Credential-pattern scan (Anthropic/OpenAI/AWS/
                                   Google/GitHub/Slack/PEM) over tracked files.
npm overrides                      linkify-it forced to ^6.1.0 (quadratic-DoS advisory
                                   GHSA-22p9-wv53-3rq4 via ansi-to-react) → audit clean.
docs/SECURITY.md                   Threat model, boundaries table, secrets handling,
                                   telemetry stance (NONE), CI checks, known limits.
docs/PRIVACY.md                    Exact network-call inventory; everything else local.
```

**Release engineering**
```
src/main/updater.ts                electron-updater: check on launch + every 6h,
                                   auto-download, install-on-quit, silent-failure;
                                   disabled in dev builds. Feed = GitHub Releases
                                   (electron-builder publish block).
sidecar/run.py + PyInstaller       Onefile sidecar binary (17.9 MB), smoke-tested
                                   (serves /health). Wired into manager resolution:
                                   env override → packaged Resources binary → dev uvicorn.
electron-builder.yml               extraResources for sidecar binary; asarUnpack for
                                   node-pty/better-sqlite3; publish → GitHub Releases;
                                   pidesktop:// protocol registered.
.github/workflows/ci.yml           macos-14: secrets scan, typecheck, unit, e2e,
                                   sidecar pytest+mypy, dependency audits, build artifact.
.github/workflows/release.yml      Tag-driven: cert import → verify tests → build
                                   sidecar → sign → notarize (APPLE_* secrets) → publish.
scripts/check-pi-updates.sh        Upstream pi pin tracking + optional contract battery
                                   (PI_RUN_CONTRACT_TESTS=1).
docs/RELEASE.md                    Step-by-step release checklist with rollback plan.
docs/troubleshooting.md            Sidecar, keychain, sessions, search, terminal, logs.
```

## Verification log (final v0.1.0 gate)

```
npm run typecheck        PASS
npm test                 46/46 PASS (incl. fuzz corpus, fs security)
npm run e2e              30/30 PASS (incl. golden path: onboarding-skip → UI session
                         create → prompt streams through real RPC protocol → settle)
./scripts/check-secrets.sh   clean
npx electron-builder     Pi Desktop.app produced
cd sidecar               11 pytest PASS · mypy strict clean · pip-audit clean
npm audit --omit=dev     0 vulnerabilities
```

## Golden-path e2e (new)

Drives the complete user journey without a real LLM: onboarding overlay appears
(no auth configured) → skip → "+ RPC" → stubbed folder picker → session opens →
prompt typed in composer → streamed reply assembled from deltas in transcript →
second prompt after settle. Uses the scripted fake responder speaking the real
RPC protocol over the full Electron IPC stack.

## Release posture

- **Signing/notarization config is wired** (release.yml + electron-builder env) but
  requires repo secrets to execute; unsigned local builds remain the default
  (signed-unnotarized bundles were observed being removed by endpoint software —
  see chapter1-status).
- **Auto-update activates only in packaged builds** with a live GitHub Releases feed.
- **Telemetry: none**, by explicit decision, documented in PRIVACY.md.

## Post-v1 backlog (from plan8)

- RemotePiBackend activation (pi-server over Unix socket / SSH tunnel)
- Multi-window support; VS Code extension sharing the RPC layer
- Embedding-based semantic session search (sidecar)
- Windows/Linux builds (architecture permits)
