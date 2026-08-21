# Chapter 2 Status — Pi Integration Core: COMPLETE

Date: 2026-08-22 · Owner: core · Gate: passed

## What was built

```
src/main/pi/
  backend.ts        IPiBackend interface + shared helpers (JSON-safe serialization)
  sdk-backend.ts    SdkPiBackend — in-process SDK (default); full event mapping
  rpc-backend.ts    RpcPiBackend — `pi --mode rpc` subprocess; strict JSONL framing,
                    request correlation, timeouts, crash detection, extension UI
                    sub-protocol (dialogs + fire-and-forget)
  jsonl-reader.ts   LF-only line splitter (U+2028/U+2029 safe; readline avoided per spec)
  service.ts        PiService: session registry (uuid → backend), all session.* IPC channels
  extension-ui.ts   ExtensionUIContext adapter: SDK-mode dialogs forwarded to renderer
  remote-backend.ts pi-server/pi-client stub (throws NotYetImplemented)
src/shared/pi.ts    JSON-safe projections of pi types: events, requests, responses
```

## Verification log

```
npm run typecheck        PASS (node + web configs, strict + exactOptionalPropertyTypes)
npm test                 17/17 unit tests PASS
  - ipc-router (6): validation, unknown channel, error envelopes
  - jsonl-reader (6): LF-only framing, \r strip, chunk boundaries, flush
  - rpc-backend (5): contract tests vs tests/fixtures/fake-pi.mjs scripted responder:
    prompt streaming with delta reassembly, state parsing, commands, failure
    surfacing, extension-UI dialog round-trip
npm run e2e              11/11 PASS, including REAL pi integration over the full stack:
  - RPC mode: session.create(--no-session) → real pi subprocess spawned via
    Electron run-as-node + bundled cli.js → live get_state / get_commands → close
  - SDK mode: in-process createAgentSession (in-memory) → live state → close
electron-builder         release/mac-arm64/Pi Desktop.app produced
```

## Key implementation notes

1. **pi is a runtime dependency** (`@earendil-works/pi-coding-agent@0.84.2`, exact pin).
   It was briefly in devDependencies, which made electron-vite bundle it into main and
   break on `__dirname` under ESM. externalizeDepsPlugin only externalizes `dependencies`.
2. **RPC binary resolution**: `PI_DESKTOP_PI_PATH` env (tests point at fake-pi.mjs) →
   bundled `dist/cli.js` run with `ELECTRON_RUN_AS_NODE=1`. No Node `readline` anywhere.
3. **Session ids are app-generated UUIDs**; pi's own sessionId is data. Registry maps
   id → backend instance; closing disposes and reaps subprocesses (SIGTERM→SIGKILL).
4. **Events cross IPC as `{type:"pi_event", sessionId, event}`** — JSON-safe projections;
   pi class instances never cross the boundary. Delta coalescing deferred to ch3 UI work.
5. **Ephemeral sessions** (`noSession`) map to `--no-session` (RPC) and
   `SessionManager.inMemory` (SDK) — used by e2e to avoid touching user data.
6. **Extension dialogs**: RPC mode answers `extension_ui_response` natively; SDK mode
   implements pi's `ExtensionUIContext` with degraded TUI parity (same semantics as
   pi's own RPC mode). Renderer answers via `session.respond_ui`.

## Known limitations (deferred by design)

- Prompting requires provider auth configured in `~/.pi/agent/auth.json` or env vars —
  key management UI lands in chapter 6.
- SDK-mode `getCommands()` currently lists prompt templates + skills only; extension
  commands arrive through the full command registry in chapter 7's commands browser.
- `RpcPiBackend.getState()` cannot report isRetrying/isBashRunning (not exposed by
  pi's get_state) — reported as false; SDK mode reports them accurately.
- Backpressure/delta coalescing for very fast streams lands with chapter 3's store.

## Ready-for-chapter-3/4 notes

- The renderer debug console (`PiConsole.tsx`) is throwaway; chapter 3 replaces it with
  the virtualized transcript fed by `pi_event` envelopes.
- `session.list` already returns pi SessionManager metadata — chapter 4's indexer
  builds directly on it.
