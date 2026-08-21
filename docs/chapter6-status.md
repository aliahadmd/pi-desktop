# Chapter 6 Status — Models, Auth & Settings: COMPLETE

Date: 2026-08-22 · Owners: ui + core · Gate: passed

## What was built

```
src/main/pi/auth.ts       AuthService — THE shared app-level ModelRuntime:
  - provider listing with live auth status (checkAuth/hasConfiguredAuth/OAuth flags)
  - full model catalog (context, pricing, reasoning flags)
  - API keys: safeStorage (Keychain) → encrypted blob in app_settings;
    re-applied to the runtime on every boot (pi's setRuntimeApiKey is
    runtime-scoped and never persisted by pi)
  - interactive login flows: AuthInteraction prompts/notify routed to the
    renderer as auth_prompt/auth_notify events; auth_url auto-opens browser
  - pi settings editor: typed setters through pi's SettingsManager (global)
src/renderer/src/pages/
  ModelsPage.tsx          provider list + auth status, key entry/removal,
                          OAuth login/logout, model table with pricing,
                          "Set default" (writes defaultModelAndProvider)
  SettingsPage.tsx        typed form: default provider/model/thinking level,
                          hide thinking, auto-compaction, auto-retry
  Onboarding.tsx          first-run overlay when no provider auth is configured
```

Wiring: `PiService.setSharedRuntime()` → every new SDK session uses the shared
runtime (keys apply across sessions). Deep link `pidesktop://` registered
(electron-builder protocols + `setAsDefaultProtocolClient`, `open-url` captured).

## Verification log

```
npm run typecheck   PASS
npm test            35/35 PASS
npm run e2e         24/24 PASS — new: auth.providers (real ModelRuntime w/ network
                    refresh), model catalog, api-key set→providers→remove round-trip,
                    pi settings read/write/restore, Models + Settings pages render
electron-builder    Pi Desktop.app produced
sidecar             11 pytest + mypy still green
```

## Key implementation notes

1. **Shared runtime is the whole point**: before ch6, each SDK session created its
   own ModelRuntime; API keys would not propagate. Now AuthService owns the runtime
   and SdkPiBackend receives it via BackendOptions.
2. **Key storage**: safeStorage.encryptString → base64 in app_settings key
   `auth.apiKeys`; decrypted only in the main process, re-applied at boot.
   `auth.remove_key` also calls pi's removeRuntimeApiKey.
3. **Login flows**: `auth.login {providerId, authType}` starts pi's `runtime.login`;
   prompts (text/secret/select/manual_code) become renderer modals keyed by loginId;
   `auth_url` events open the system browser automatically. Deep link registered for
   providers that redirect to `pidesktop://oauth/callback`.
4. **Pi settings**: only whitelisted keys are writable (defaultProvider/defaultModel/
   defaultThinkingLevel/hideThinkingBlock/compactionEnabled/retryEnabled) — writes go
   through pi's SettingsManager + flush(), never raw file edits.
5. **Onboarding** triggers when `auth.providers` shows zero configured providers;
   skippable.

## Deferred

- OAuth callback server automation for providers that redirect to custom schemes
  (manual code paste covers all flows today).
- Per-project settings editing (global only in v1, per plan).
- Keychain Touch-ID gate on key reveal/copy (ch7/8 polish).
