#!/bin/zsh
set -euo pipefail
SCRIPT_DIR=${0:A:h}
REPOSITORY_DIR=${SCRIPT_DIR:h}
cd "$REPOSITORY_DIR"
scripts/build-macos-app.sh
APP="$REPOSITORY_DIR/dist/EmbyScope.app"
VERSION=$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist")
ARCH=$(uname -m)
STAGING_DIR=$(mktemp -d /tmp/embyscope-dmg.XXXXXX)
trap 'rm -rf "$STAGING_DIR"' EXIT
mkdir "$STAGING_DIR/content"
ditto "$APP" "$STAGING_DIR/content/EmbyScope.app"
ln -s /Applications "$STAGING_DIR/content/Applications"
cp docs/macOS安装与备份.md "$STAGING_DIR/content/安装与备份说明.md"
DMG_NAME="EmbyScope-${VERSION}-${ARCH}.dmg"
hdiutil create -volname '映览 EmbyScope' -srcfolder "$STAGING_DIR/content" -format UDZO "$STAGING_DIR/$DMG_NAME"
hdiutil verify "$STAGING_DIR/$DMG_NAME"
mv -f "$STAGING_DIR/$DMG_NAME" "dist/$DMG_NAME"
(cd dist && shasum -a 256 "$DMG_NAME" > "$DMG_NAME.sha256")
print "已构建 dist/$DMG_NAME（本机临时签名，未经 Apple 公证）"
