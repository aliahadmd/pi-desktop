# Security Policy — Pi Desktop

## Reporting

Report vulnerabilities privately to the maintainers (GitHub Security Advisory on
this repository). Do not open public issues for security problems.

## Security model

Pi Desktop runs the pi coding agent locally. By design it inherits the file and
process permissions of the user account — **it is not a sandbox**. See
[pi's containerization guide](../pi/packages/coding-agent/docs/containerization.md)
for strong-isolation patterns (micro-VM, Docker, OpenShell).

### Process boundaries

| Boundary | Control |
|---|---|
| Renderer → main | Single typed IPC channel; every payload schema-validated (typebox) at the boundary; structured error envelopes; fuzz-tested (`tests/unit/security-fuzz.test.ts`) |
| Main → renderer | Event envelopes only; no raw objects, no functions cross the bridge |
| Preload | `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; exactly one bridge object exposed |
| Navigation | `will-navigate` locked to dev server (dev only); window.open denied; external links open in system browser via `shell.openExternal` (http/https only from markdown) |
| Permissions | All Chromium permission requests/checks denied |
| Filesystem UI | Explorer/terminal scoped to registered project roots with realpath-canonicalized containment checks (symlink escapes rejected); unit-tested adversarially |
| Sidecar | Loopback-only bind, per-boot token header required; owns only its FTS tables; core tables read-only |

### Secrets handling

- API keys are stored via Electron `safeStorage` (macOS Keychain-backed) as
  encrypted blobs in the local settings database.
  - Decrypted keys exist only in the main process memory.
  - Keys are re-applied to pi's runtime at boot; they are never written to
    pi's `auth.json` by the desktop app unless a future explicit opt-in says so.
  - Keys are never logged, never sent to the renderer unmasked, never included
    in telemetry (there is none).
- OAuth tokens are managed by pi's own credential store (`~/.pi/agent/auth.json`)
  using pi's login/logout flows.

### Telemetry

**None.** The desktop app makes exactly two kinds of network calls:
1. LLM provider traffic (only when you prompt), through pi's providers.
2. Model-catalog refreshes and update checks against pi.dev / GitHub Releases.

The Python sidecar binds to `127.0.0.1` only and requires a per-boot token.

## Automated checks (CI)

- `scripts/check-secrets.sh` — credential-pattern scan of tracked files
- `npm audit --omit=dev` + `pip-audit` — dependency vulnerabilities (must be clean)
- IPC boundary fuzz corpus — router must return structured results for all inputs
- E2E asserts renderer isolation (`window.require/process/module` undefined)

## Known limitations (v1)

- Embedded terminal grants a real shell inside the project root scoping check;
  a user typing in it has full shell permissions by definition.
- Symlinked directories *within* a project that point outside are rejected on
  access (realpath check) — this can surprise monorepos with external links.
- Auto-update feed signature verification depends on electron-updater defaults;
  releases must be signed with the same Developer ID as the installed build.
