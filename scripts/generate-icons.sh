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
  sips -z $sz $sz "$SRC" --out "build/icon.iconset/icon_${sz}x${sz}.png" >/dev/null
  sips -z $((sz*2)) $((sz*2)) "$SRC" --out "build/icon.iconset/icon_${sz}x${sz}@2x.png" >/dev/null
done
iconutil -c icns build/icon.iconset -o build/icon.icns
rm -rf build/icon.iconset
echo "wrote build/icon.icns"
