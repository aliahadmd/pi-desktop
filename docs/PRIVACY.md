# Privacy — Pi Desktop

**Short version: your code and conversations stay on your Mac except for the
LLM calls you explicitly make.**

## What leaves your machine

| Data | Destination | When |
|---|---|---|
| Prompts, file contents the agent reads, tool results | Your configured LLM provider (Anthropic, OpenAI, …) | Only when you send a prompt |
| Model catalogs | pi.dev catalog endpoint | Periodic refresh (throttled; cached offline) |
| Update checks | GitHub Releases API | On launch + every 6 h (packaged builds) |

Nothing else. Specifically:

- **No telemetry.** No analytics, crash reporting, or usage tracking exists in
  the app. Pi's own telemetry contracts package is not wired up.
- **No conversation sync.** Sessions stay in `~/.pi/agent/sessions/` and our
  local index in `~/Library/Application Support/PiDesktop/`.
- **The Python sidecar never makes network calls.** It binds to `127.0.0.1`
  only, requires a per-boot token, and reads/writes local files.

## What stays on your machine

- Conversations (pi session JSONL files)
- Session index, search index, usage/cost history (single SQLite DB, WAL)
- API keys (Keychain-encrypted blobs via Electron safeStorage)
- OAuth tokens (pi's own `~/.pi/agent/auth.json`)
- Logs (`logs/*.jsonl` under Application Support; contain no prompts or keys —
  verify with any JSON viewer; retention 14 days)

## Third parties

LLM providers see whatever the agent sends them, governed by their own privacy
policies. Pi Desktop adds no intermediary server of its own.
