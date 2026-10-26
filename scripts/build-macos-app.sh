#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
REPOSITORY_DIR=${SCRIPT_DIR:h}
cd "$REPOSITORY_DIR"
eval "$(fnm env --shell zsh)"
fnm use
NODE_BINARY=$(command -v node)
NODE_ROOT=${NODE_BINARY:A:h:h}
[[ $(node -p 'process.versions.node') == "22.22.2" ]] || { print '请使用项目指定的 Node 22.22.2'; exit 1; }
[[ $(node -p 'process.arch') == $(uname -m | sed 's/x86_64/x64/') ]] || { print 'Node 与本机架构不同'; exit 1; }
# 不把依赖 Homebrew 动态库的运行时误当作独立发行版。
if otool -L "$NODE_BINARY" | tail -n +2 | awk '{print $1}' | rg -v '^(/usr/lib/|/System/Library/)' >/dev/null; then
  print 'Node 包含非系统动态库依赖，请使用 fnm 的官方运行时'
  exit 1
fi
swift build --package-path desktop --configuration release
BIN_DIR=$(swift build --package-path desktop --configuration release --show-bin-path)
STAGING_DIR=$(mktemp -d /tmp/embyscope-app.XXXXXX)
trap 'rm -rf "$STAGING_DIR"' EXIT
APP="$STAGING_DIR/EmbyScope.app"
RESOURCES="$APP/Contents/Resources"
mkdir -p "$APP/Contents/MacOS" "$RESOURCES/runtime" "$RESOURCES/service/desktop/backend"
cp "$BIN_DIR/EmbyScope" "$APP/Contents/MacOS/EmbyScope"
cp "$NODE_BINARY" "$RESOURCES/runtime/node"
cp -R src public "$RESOURCES/service/"
cp package.json "$RESOURCES/service/"
cp desktop/backend/*.js "$RESOURCES/service/desktop/backend/"
swift scripts/make-macos-icon.swift "$STAGING_DIR/AppIcon.iconset"
iconutil -c icns "$STAGING_DIR/AppIcon.iconset" -o "$RESOURCES/AppIcon.icns"
if [[ -f "$NODE_ROOT/LICENSE" ]]; then
  cp "$NODE_ROOT/LICENSE" "$RESOURCES/runtime/LICENSE"
else
  print 'Node 安装目录缺少 LICENSE，停止打包以避免漏带运行时许可'
  exit 1
fi
for artwork in desktop/assets/*.png; do
  # 发行资源只需要缩略图，原始生成稿留在源码目录。
  sips -Z 1000 -s format jpeg "$artwork" --out "$RESOURCES/${artwork:t:r}.jpg" >/dev/null
done
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>EmbyScope</string>
<key>CFBundleIdentifier</key><string>com.zaynzhu.embyscope</string>
<key>CFBundleName</key><string>EmbyScope</string>
<key>CFBundleDisplayName</key><string>映览 · EmbyScope</string>
<key>CFBundleIconFile</key><string>AppIcon.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.18</string>
<key>CFBundleVersion</key><string>19</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
codesign --force --sign - "$RESOURCES/runtime/node"
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"
mkdir -p dist
if [[ -d dist/EmbyScope.app ]]; then
  # 仅替换本脚本生成的相同 bundle，不覆盖其他应用。
  [[ $(plutil -extract CFBundleIdentifier raw dist/EmbyScope.app/Contents/Info.plist) == com.zaynzhu.embyscope ]] || exit 1
  rm -rf dist/EmbyScope.app
fi
mv "$APP" dist/EmbyScope.app
print "已构建 $REPOSITORY_DIR/dist/EmbyScope.app"
print '演示预览：open dist/EmbyScope.app --args --demo'
