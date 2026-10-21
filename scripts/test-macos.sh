#!/bin/zsh
set -euo pipefail
SCRIPT_DIR=${0:A:h}
REPOSITORY_DIR=${SCRIPT_DIR:h}
SDK_DEVELOPER_DIR=$(xcode-select -p)
TEST_FRAMEWORKS_DIR="$SDK_DEVELOPER_DIR/Library/Developer/Frameworks"
TEST_LIBRARIES_DIR="$SDK_DEVELOPER_DIR/Library/Developer/usr/lib"
swift test --package-path "$REPOSITORY_DIR/desktop" \
  -Xswiftc -F -Xswiftc "$TEST_FRAMEWORKS_DIR" \
  -Xlinker -F -Xlinker "$TEST_FRAMEWORKS_DIR" \
  -Xlinker -rpath -Xlinker "$TEST_FRAMEWORKS_DIR" \
  -Xlinker -rpath -Xlinker "$TEST_LIBRARIES_DIR" "$@"
