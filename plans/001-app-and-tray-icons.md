# Plan 001: Give Pi Desktop a real app icon and a visible tray icon

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 02fbaf0..HEAD -- electron-builder.yml src/main/index.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `02fbaf0`, 2026-08-22

## Why this matters

The packaged app currently ships with **no icon at all** — the `icon:` key in
`electron-builder.yml` is commented out, so macOS falls back to the default
Electron logo in the Dock, Finder, ⌘-Tab, the About panel, and the dmg. The
first thing a user sees is another project's branding.

Separately, the menu-bar (tray) icon is built from an inline base64 PNG whose
compressed image data is **corrupt**: Python's `zlib` refuses to inflate it,
and Core Graphics decodes it leniently into a uniform empty bitmap. Because
`icon.setTemplateImage(true)` tells macOS to derive the glyph from the alpha
channel, an empty bitmap means **the menu-bar item renders as nothing** — the
tray is running, the user just cannot see it.

After this plan: the app has a real icon everywhere macOS shows one, and the
tray shows a crisp glyph in both light and dark menu bars.

## Current state

Files involved:

- `electron-builder.yml` — packaging config; the `mac:` block is where the app
  icon is declared.
- `src/main/index.ts` — `createTray()` around line 397 builds the tray image
  from an inline data URL.

**`electron-builder.yml`, the `mac:` block as it exists today** (note the
commented-out final line):

```yaml
mac:
  category: public.app-category.developer-tools
  hardenedRuntime: true # required for notarization (chapter 8)
  darkModeSupport: true
  identity: null # unsigned dev builds; real signing + notarization lands in chapter 8.
                 # NOTE: Developer-ID-signed-but-unnotarized builds were observed being
                 # removed by local security software on the build machine — do not
                 # distribute anything signed but unnotarized.
  target:
    - target: dmg
      arch:
        - arm64
        - x64
  # icon: build/icon.icns  # add a real icon before first public release
```

There is **no `build/` directory in the repo** — confirm with `ls build`
(expected: "No such file or directory").

**`src/main/index.ts:397-409` as it exists today:**

```ts
function createTray(): void {
	// 16x16 monochrome circle as template image (adapts to menu bar theme).
	const icon = nativeImage.createFromDataURL(
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKklEQVQ4y2NgoBAwYv7/z8DAwMDAwMDAxMDIyMDIyMDIyMAkF1nNAABKZQHBNiMq6gAAAABJRU5ErkJggg=="
	);
	icon.setTemplateImage(true);
	try {
		tray = new Tray(icon);
		updateTray();
	} catch (error) {
		logger?.warn("main", `tray creation failed: ${String(error)}`);
	}
}
```

Repo conventions that apply here:

- TypeScript is **strict**; both `tsconfig.node.json` (main/preload) and
  `tsconfig.web.json` (renderer) must pass with zero errors.
- Tabs for indentation, double quotes for strings — match the surrounding file.
- Main-process logging goes through the module-level `logger` with a subsystem
  string: `logger?.warn("main", "…")`. See `src/main/index.ts` for many uses.
- `electron-builder.yml` uses 2-space YAML indentation.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0, no output after the two npm notice lines |
| Unit tests | `npm test` | exit 0, `53 passed` (or more) |
| Package (dir only, fast) | `npm run dist:mac` | exit 0, produces `release/mac-arm64/Pi Desktop.app` |
| Check icon landed | `ls "release/mac-arm64/Pi Desktop.app/Contents/Resources/icon.icns"` | file exists |

> **Note on `npm run dist:mac`**: the README documents that local cleanup tools
> (CleanMyMac and similar) have been observed deleting freshly built files under
> `out/` and `release/` mid-build. If the packaging step fails with missing
> files, that is the known cause — re-run once. If it fails twice, treat it as
> a STOP condition rather than working around it.

## Scope

**In scope** (the only files you should modify or create):

- `electron-builder.yml` — uncomment and point the `icon:` key
- `src/main/index.ts` — `createTray()` only
- `build/icon.icns` (create)
- `build/icon.png` (create — the 1024×1024 source)
- `resources/tray/tray-icon.png` and `resources/tray/tray-icon@2x.png` (create)
- `scripts/generate-icons.sh` (create)
- `tests/unit/assets.test.ts` (create — this plan's own test file; do not append
  to `tests/unit/regressions.test.ts`)

**Out of scope** (do NOT touch, even though they look related):

- `mac.identity`, `hardenedRuntime`, or anything else in the signing/notarization
  configuration — that is deliberately left unsigned and is handled by
  `docs/RELEASE.md`.
- The `publish:` block — it points at the wrong GitHub owner, which is a real
  bug, but it is tracked separately and changing it here mixes concerns.
- `updateTray()`, `focusMainWindow()`, or the tray context menu — behavior is
  correct, only the image is broken.
- Any renderer file. This plan does not touch the UI.

## Git workflow

- Branch: `advisor/001-app-and-tray-icons`
- Commit style is conventional commits — from `git log`:
  `feat: enhance sidebar with packages section and sound settings`,
  `fix: add hasInstallScript flag for better-sqlite3 dependency`.
  Use `fix: add app icon and repair blank tray icon`.
- Do NOT push or open a PR.

## Steps

### Step 1: Add the icon generator script

Create `scripts/generate-icons.sh`, executable, matching the style of the
existing `scripts/setup-native.sh` (`#!/usr/bin/env bash`, `set -euo pipefail`).

It must:

1. Require `build/icon.png` to exist and be 1024×1024 (fail with a clear message
   otherwise).
2. Build `build/icon.iconset/` with the ten sizes `iconutil` expects
   (16, 32, 128, 256, 512 at 1× and 2×) using `sips -z <h> <w>`.
3. Run `iconutil -c icns build/icon.iconset -o build/icon.icns`.
4. Remove the intermediate `.iconset` directory.

```bash
#!/usr/bin/env bash
# Regenerates build/icon.icns from build/icon.png (1024x1024 source).
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="build/icon.png"
[ -f "$SRC" ] || { echo "error: $SRC not found (need a 1024x1024 PNG)"; exit 1; }

W=$(sips -g pixelWidth "$SRC" | awk '/pixelWidth/{print $2}')
[ "$W" = "1024" ] || { echo "error: $SRC must be 1024x1024, got width $W"; exit 1; }

rm -rf build/icon.iconset
mkdir -p build/icon.iconset
for sz in 16 32 128 256 512; do
  sips -z $sz  $sz  "$SRC" --out "build/icon.iconset/icon_${sz}x${sz}.png"      >/dev/null
  sips -z $((sz*2)) $((sz*2)) "$SRC" --out "build/icon.iconset/icon_${sz}x${sz}@2x.png" >/dev/null
done
iconutil -c icns build/icon.iconset -o build/icon.icns
rm -rf build/icon.iconset
echo "wrote build/icon.icns"
```

**Verify**: `chmod +x scripts/generate-icons.sh && bash -n scripts/generate-icons.sh`
→ exit 0 (syntax check passes).

### Step 2: Obtain the 1024×1024 source artwork

The app icon is a **design decision, not a code decision**. Check whether
`build/icon.png` has already been supplied:

```bash
ls -la build/icon.png 2>&1
```

- **If it exists**: go to step 3.
- **If it does not exist**: **STOP and report.** Ask the operator to supply a
  1024×1024 PNG at `build/icon.png`. Do not generate placeholder artwork, do
  not copy pi's upstream logo (it is a different project's mark and reusing it
  is exactly the problem this plan fixes), and do not download anything.

**Verify**: `sips -g pixelWidth -g pixelHeight build/icon.png` → reports
`pixelWidth: 1024` and `pixelHeight: 1024`.

### Step 3: Generate the icns and wire it into the build

Run the generator, then edit `electron-builder.yml`: replace the commented line

```yaml
  # icon: build/icon.icns  # add a real icon before first public release
```

with

```yaml
  icon: build/icon.icns
```

Keep it at the same 2-space indentation, inside the `mac:` block.

**Verify**:
- `./scripts/generate-icons.sh` → prints `wrote build/icon.icns`
- `file build/icon.icns` → `Mac OS X icon`
- `grep -n "icon: build/icon.icns" electron-builder.yml` → exactly one match,
  not commented out

### Step 4: Replace the corrupt tray image with real files

Create the two tray PNGs. These are **template images**: macOS uses only the
alpha channel and recolors the glyph for light/dark menu bars, so the pixels
must be black with the shape carried entirely in alpha.

Generate them with this script (run it once from the repo root; it does not
need to be committed as a script, but committing the two PNGs is required):

```bash
mkdir -p resources/tray && python3 - <<'PY'
import zlib, struct, math, os

def make_png(size, path):
    rows = bytearray()
    cx = cy = (size - 1) / 2
    r_out, r_in, edge = size * 0.42, size * 0.22, size * 0.09
    for y in range(size):
        rows.append(0)                      # PNG filter type 0
        for x in range(size):
            d = math.hypot(x - cx, y - cy)
            outer = max(0.0, min(1.0, (r_out - d) / edge))
            inner = max(0.0, min(1.0, (d - r_in) / edge))
            rows += bytes((0, 0, 0, int(255 * min(outer, inner))))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
           + chunk(b"IEND", b""))
    open(path, "wb").write(png)
    print("wrote", path, len(png), "bytes")

make_png(16, "resources/tray/tray-icon.png")
make_png(32, "resources/tray/tray-icon@2x.png")
PY
```

This produces a ring glyph that reads clearly at 16px. If the operator later
supplies designed tray artwork, it drops into the same two paths.

**Verify** — the corrupt image failed exactly this check, so it is the
regression test for this step:

```bash
python3 -c "
import zlib,struct
d=open('resources/tray/tray-icon.png','rb').read()
i=8; idat=b''
while i<len(d):
    ln=struct.unpack('>I',d[i:i+4])[0]; t=d[i+4:i+8]
    if t==b'IDAT': idat+=d[i+8:i+8+ln]
    i+=12+ln
print('inflate OK:', len(zlib.decompress(idat)), 'bytes')
"
```
→ prints `inflate OK: 1040 bytes`. (The old inline image raises
`zlib.error: Error -3 … invalid literal/length/distance code` here.)

### Step 5: Load the tray icon from disk instead of the data URL

Rewrite `createTray()` in `src/main/index.ts`. Requirements:

- Resolve the icon path for **both** dev and packaged builds. In dev the file
  sits at `<repo>/resources/tray/tray-icon.png`; in a packaged app,
  `process.resourcesPath` is the `Contents/Resources` directory. Use
  `app.isPackaged` to choose.
- Use `nativeImage.createFromPath()`.
- **Fail loudly, not silently.** The current code swallows a blank image. Check
  `icon.isEmpty()` and log an error if true — that is the exact failure mode
  that hid this bug.
- Keep the existing `setTemplateImage(true)` call and the existing try/catch
  around `new Tray(...)`.

Target shape:

```ts
function createTray(): void {
	// Template image: macOS derives the glyph from the alpha channel and
	// recolors it for light/dark menu bars. @2x is picked up automatically.
	const iconPath = app.isPackaged
		? path.join(process.resourcesPath, "tray", "tray-icon.png")
		: path.join(__dirname, "../../resources/tray/tray-icon.png");
	const icon = nativeImage.createFromPath(iconPath);
	if (icon.isEmpty()) {
		// A blank tray image renders as an invisible menu-bar item — never fail quietly.
		logger?.error("main", `tray icon failed to load from ${iconPath}`);
		return;
	}
	icon.setTemplateImage(true);
	try {
		tray = new Tray(icon);
		updateTray();
	} catch (error) {
		logger?.warn("main", `tray creation failed: ${String(error)}`);
	}
}
```

> If `path.join(__dirname, "../../resources/...")` does not resolve in dev,
> check where electron-vite emits the main bundle (`out/main/index.js`, so
> `__dirname` is `<repo>/out/main`, making `../../resources` correct). Adjust
> only the number of `..` segments; do not change the strategy.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -c "data:image/png;base64" src/main/index.ts` → `0`

### Step 6: Ship the tray files in the packaged app

`electron-builder.yml` already has an `extraResources:` block for the Python
sidecar. Add the tray directory to it, keeping the existing entry:

```yaml
extraResources:
  # Python sidecar binary (built by sidecar/build.sh — see RELEASE.md)
  - from: sidecar/dist/pi-desktop-sidecar
    to: sidecar/pi-desktop-sidecar
  - from: resources/tray
    to: tray
```

The `to: tray` value must match the `path.join(process.resourcesPath, "tray", …)`
used in step 5.

**Verify**:
- `npm run dist:mac` → exit 0
- `ls "release/mac-arm64/Pi Desktop.app/Contents/Resources/tray/"` → lists
  `tray-icon.png` and `tray-icon@2x.png`
- `ls "release/mac-arm64/Pi Desktop.app/Contents/Resources/icon.icns"` → exists

## Test plan

There is no existing unit test for tray or packaging, and adding one that
launches a real `Tray` is not worth the harness cost. Instead add a cheap
**asset-integrity** test, which is what would have caught this bug:

Create `tests/unit/assets.test.ts`, modeled structurally on
`tests/unit/fs-bridge.test.ts` (same `describe`/`it` layout, `node:fs` reads,
no Electron imports). Cover:

1. `resources/tray/tray-icon.png` exists and its PNG `IDAT` chunks inflate
   without error — the exact check the old inline image failed.
2. Same for `resources/tray/tray-icon@2x.png`.
3. The 1× image reports 16×16 and the 2× reports 32×32 in their `IHDR` chunks.
4. `src/main/index.ts` contains no `data:image/png;base64` literal (guards
   against the inline image coming back).

Keep it dependency-free: parse the PNG chunks with `node:zlib` and
`Buffer.readUInt32BE`, the same way the verification snippets above do.

**Verification**: `npm test` → exit 0, `57 passed` (53 existing + 4 new).

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 and includes the 4 new tests in `tests/unit/assets.test.ts`
- [ ] `grep -c "data:image/png;base64" src/main/index.ts` returns `0`
- [ ] `grep -n "^  icon: build/icon.icns" electron-builder.yml` returns exactly one match
- [ ] `file build/icon.icns` reports `Mac OS X icon`
- [ ] `npm run dist:mac` exits 0, and both
      `release/mac-arm64/Pi Desktop.app/Contents/Resources/icon.icns` and
      `.../Contents/Resources/tray/tray-icon.png` exist
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row for 001 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `build/icon.png` does not exist and no 1024×1024 source artwork has been
  supplied (step 2). **Do not invent artwork and do not reuse pi's upstream
  logo.**
- The `mac:` block in `electron-builder.yml` no longer matches the excerpt in
  "Current state" — particularly if someone has already set an `icon:` key.
- `createTray()` no longer matches the excerpt in "Current state".
- `npm run dist:mac` fails twice in a row (once is the known CleanMyMac-class
  interference documented in the README; twice is a real failure).
- `iconutil` or `sips` are unavailable — both ship with macOS, so their absence
  means this is not a macOS build host and the plan does not apply.

## Maintenance notes

- **For the reviewer**: confirm the tray PNGs are genuinely black-with-alpha.
  A tray image with colored pixels will look correct in a light menu bar and
  wrong in a dark one, and `setTemplateImage(true)` will not warn about it.
- The `to: tray` value in `extraResources` and the `path.join(…, "tray", …)`
  in `createTray()` are a matched pair. Changing one without the other yields
  an invisible tray icon again in packaged builds only — which dev testing
  will not catch. The `icon.isEmpty()` guard added in step 5 turns that silent
  failure into a log line.
- Windows and Linux packaging (a stated future goal) will need `icon.ico` and
  a PNG icon set respectively, generated from the same `build/icon.png`. Extend
  `scripts/generate-icons.sh` at that point rather than adding a second script.
- **Deliberately deferred**: signing and notarization stay out of this plan.
  `mac.identity` remains `null`, per the warning comment already in the config.
