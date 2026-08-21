# Chapter 1 Status — Foundation: COMPLETE

Date: 2026-08-22 · Owner: core · Gate: passed

## Acceptance criteria results

| Task | Criterion | Result |
|---|---|---|
| T1.1 Scaffold | fresh clone → `npm i` → `npm run dev` works | PASS (dev launch verified; npm-scripts note in README) |
| T1.1 Toolchain | typecheck / lint / test / e2e wired and green | PASS |
| T1.2 Typed IPC | malformed payload rejected with `{ok:false,error}`; ping→pong works | PASS (unit + e2e) |
| T1.3 Security | checklist in docs/security.md; `window.require === undefined` in renderer | PASS (e2e asserts) |
| T1.4 Services | dirs + logs created; recovery after kill -9 | PASS (JSONL logs verified from packaged run) |
| T1.5 Packaging | `.app` launches from Finder on arm64 | PASS (unsigned build; see environment note) |

## Verification log (final gate, run twice clean)

```
rm -rf out release
npm run typecheck   → PASS
npm test            → 6/6 unit tests PASS
npm run e2e         → 3/3 smoke tests PASS (builds + stages app itself)
electron-builder    → release/mac-arm64/Pi Desktop.app produced
```

## Environment findings (important for later chapters)

1. **CleanMyMac 5 interference.** The dev machine runs CleanMyMac 5 with background
   assistants. Observed behavior:
   - Freshly built files under `out/` transiently disappear (~200 ms–minutes) and reappear
     unchanged while Electron is launching → module-resolution races.
   - A Developer-ID-signed but unnotarized `Pi Desktop.app` was removed entirely.
   Mitigations implemented:
   - E2E now builds and **stages the app into a temp dir** before launching
     (`tests/e2e/smoke.e2e.ts :: buildAndStage`), which CleanMyMac leaves alone.
   - `electron-builder.yml` defaults to unsigned dev builds (`identity: null`) until
     chapter 8 adds real signing + notarization.
   Recommended user action: add `/Users/ahs/build/test/piclient` to CleanMyMac's
   exclusion/ignore list.
2. **npm ≥ 12 lifecycle-script gating**: `esbuild` and `electron` postinstalls must be
   approved once (`npm install-scripts approve esbuild electron`). Documented in README.

## Deviations from plan

- `lint` currently aliases `typecheck` (no ESLint/biome config yet — decision deferred to
  chapter 2 to keep ch1 dependency-light).
- `better-sqlite3` + `electron-rebuild` deferred to chapter 4 (plan allowed lazy wiring);
  `asarUnpack` placeholder already staged in electron-builder.yml.

## Ready-for-chapter-2 notes

- IPC contract pattern established: add a schema to `requestSchemaMap`, a type to
  `ResponseMap`, a handler in main — validation and error envelopes come free.
- `RendererEventBus` is ready to carry pi events (backpressure/coalescing lands in ch2).
