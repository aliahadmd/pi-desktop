# Chapter 7 Status — Workspace & Power Features: COMPLETE

Date: 2026-08-22 · Owners: ui + core · Gate: passed

## What was built

**Main process**
```
src/main/fs-bridge.ts      Read-only file bridge scoped to registered project roots:
                           realpath-canonicalized containment checks (symlink escapes
                           rejected), deny-list (node_modules/.git/...), hidden files
                           filtered except .pi, 1 MB read cap, traversal-safe
src/main/pty-service.ts    node-pty terminals on dedicated ipcMain channels (high-
                           frequency streaming), SHELL-scoped to session cwd
resources/extensions/
  pi-desktop-approve.ts    Bundled approval extension (public pi extension API only):
                           hooks tool_call for bash/edit/write → ctx.ui.confirm →
                           routed through the existing dialog bridge; denial blocks
                           with a reason the model sees
index.ts additions         Tray (template icon, live session count, Open/Quit),
                           native macOS menu (Edit roles, View zoom/devtools, Help),
                           completion notifications when unfocused (click focuses),
                           PI_DESKTOP_TEST_PICK_DIR test hook for folder picker
```

**Renderer**
```
components/workspace/
  Dock.tsx                 File explorer (lazy tree, file preview), review queue
                           (edit/write diffs + copy patch), commands browser
                           (grouped by source, click inserts /command)
  TerminalPanel.tsx        xterm.js + FitAddon over the pty channels, ResizeObserver
pages/ChatPage.tsx         Right dock (Files/Review/Commands tabs) + bottom terminal,
                           composer accepts inserted /commands
```

## Verification log

```
npm run typecheck   PASS
npm test            42/42 PASS — new: 7 FileBridge security tests
                    (traversal, sibling-prefix, symlinked escapes, deny-list)
npm run e2e         27/27 PASS — new: real UI session flow (+ RPC → stubbed picker),
                    dock tabs, explorer cwd header, terminal toggle with xterm mount
electron-builder    Pi Desktop.app produced (node-pty + better-sqlite3 asarUnpacked)
sidecar             11 pytest + mypy still green
```

## Key implementation notes

1. **node-pty rebuilt for Electron ABI** via @electron/rebuild; verified working under
   both plain Node and Electron run-as-node. asarUnpack configured.
2. **Approval extension uses only public pi extension APIs** (`pi.on("tool_call")` +
   `ctx.ui.confirm`) — no fork; loaded via `additionalExtensionPaths` when enabled.
   Candidate for upstream contribution.
3. **Symlink escape fixed during testing**: path.resolve alone misses symlinked paths;
   `assertRealScoped()` canonicalizes via fs.realpath (roots too — macOS /tmp →
   /private/tmp) before every real access; missing paths still rejected when the
   virtual path is outside.
4. **Multi-observer PiService hooks**: addHooks() now fans out to store, notifications,
   and root registration independently.
5. **Test hook**: PI_DESKTOP_TEST_PICK_DIR makes the folder picker return a fixed path,
   letting e2e drive the real session-creation UI flow without native dialogs.

## Deferred (per plan)

- Diff "Open in editor" (VS Code / $EDITOR) — copy-patch ships today.
- Confirm-before-apply toggle UI (extension loads when setting enabled; settings UI
  toggle lands in chapter 8's settings hardening).
- Session tree visualizer (get_tree) — post-v1 backlog with remote sessions.
```
