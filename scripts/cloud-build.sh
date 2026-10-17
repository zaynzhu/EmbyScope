#!/usr/bin/env bash
# 仅在 GitHub 托管 runner 执行，不在 NAS 或开发机上构建。
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test "${GITHUB_SHA:-}" != ""
image="embyscope:${GITHUB_SHA:0:12}"
out="dist/embyscope-linux-amd64"
mkdir -p "$out" "$RUNNER_TEMP/embyscope-config"
chmod 777 "$RUNNER_TEMP/embyscope-config"
export EMBYSCOPE_IMAGE="$image" DATA_PATH="$RUNNER_TEMP/embyscope-config" APP_PORT=33000 BIND_ADDRESS=127.0.0.1
docker compose -p embyscope-ci config --quiet
docker buildx build --platform linux/amd64 --tag "$image" --load .
test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" = linux/amd64
trap 'docker compose -p embyscope-ci down --volumes' EXIT
docker compose -p embyscope-ci up -d --pull never --no-build
node scripts/smoke.mjs setup
docker compose -p embyscope-ci restart
node scripts/smoke.mjs login
docker save --output "$out/images.tar" "$image"
cp compose.yaml compose.external-network.yaml compose.env.example "$out/"
cp docs/部署说明.md "$out/README.md"
sed -i "s|embyscope:replace-with-commit|$image|" "$out/compose.env.example"
export BUNDLE_OUT="$out" BUNDLE_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$image")"
node --input-type=module <<'JS'
import { writeFileSync, readdirSync } from 'node:fs'
const out = process.env.BUNDLE_OUT
writeFileSync(`${out}/manifest.json`, JSON.stringify({
  project: '映览 · EmbyScope', commit: process.env.GITHUB_SHA,
  run: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  platform: 'linux/amd64', image: process.env.EMBYSCOPE_IMAGE, imageId: process.env.BUNDLE_IMAGE_ID,
  validation: '构建、Compose 启动、初始化、API、持久化通过；等待干净 runner 导入验收',
  files: [...readdirSync(out), 'manifest.json', 'SHA256SUMS']
}, null, 2))
JS
(cd "$out" && sha256sum images.tar compose.yaml compose.external-network.yaml compose.env.example README.md manifest.json > SHA256SUMS)
