#!/bin/bash
# iklipse for Mac: builds iklipse.app (Apple silicon and Intel, macOS 12+) and
# out/iklipse.dmg (drag to Applications). Runs on a Mac with Xcode's command
# line tools; .github/workflows/mac.yml runs it and publishes the disk image.
#
#   CODE=12 mac/build.sh      (CODE: the build number the app compares for updates)
set -euo pipefail
cd "$(dirname "$0")"
CODE="${CODE:-1}"
VERSION="1.0.$CODE"
APP=build/iklipse.app

rm -rf build out
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" out

for arch in arm64 x86_64; do
  xcrun swiftc -O -swift-version 5 -target "$arch-apple-macos12.0" Sources/*.swift -o "build/iklipse-$arch"
done
lipo -create build/iklipse-arm64 build/iklipse-x86_64 -output "$APP/Contents/MacOS/iklipse"
sed -e "s/__VERSION__/$VERSION/" -e "s/__CODE__/$CODE/" Info.plist > "$APP/Contents/Info.plist"

# The icon, from the web app's 1024 px one (scripts/make-icons.py), so the @2x sizes are never scaled up; the menu bar icon is the white mark (a template image).
ICONS=build/iklipse.iconset
mkdir -p "$ICONS"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" ../public/icons/icon-1024.png --out "$ICONS/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) ../public/icons/icon-1024.png --out "$ICONS/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONS" -o "$APP/Contents/Resources/iklipse.icns"
cp ../public/icons/badge-96.png "$APP/Contents/Resources/tray.png"

# Not signed with an Apple Developer ID: macOS asks to allow it the first time.
codesign --force --deep --sign - "$APP"

mkdir -p build/dmg
cp -R "$APP" build/dmg/
ln -s /Applications build/dmg/Applications
hdiutil create -volname iklipse -srcfolder build/dmg -ov -format UDZO out/iklipse.dmg
ls -l out/iklipse.dmg
