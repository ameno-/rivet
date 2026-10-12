#!/usr/bin/env bash
# Build the two images the standalone Pi Mate deploys as:
#
#   pi-mate-engine:latest   the durable Rivet Engine host (owns actor state)
#   pi-mate-runtime:latest  the restartable Mate executor (owns no state)
#
# Stages build inputs next to each Dockerfile, then builds the images. Run
# from anywhere; the script locates the example root itself.
#
#   ./deploy/build.sh
#
# The engine binary and the rivetkit-napi addon both come from published npm
# artefacts, so the repo never carries a 90 MB binary and the runtime's
# native addon always matches the bundled rivetkit version. Override the
# versions with RIVET_ENGINE_VERSION / RIVET_NAPI_VERSION.
#
# The bundle links the workspace rivetkit (the repo root pins
# `pnpm.overrides.rivetkit: workspace:*`, so every example resolves to it),
# therefore both defaults must track rivetkit-typescript/packages/rivetkit's
# own version. A napi addon newer than the bundled JS loads but speaks a
# different runner protocol, so keep these three in lockstep.
set -euo pipefail

cd "$(dirname "$0")/.."
WORKSPACE_RIVETKIT_VERSION="$(node -p "require('../../rivetkit-typescript/packages/rivetkit/package.json').version")"
ENGINE_VERSION="${RIVET_ENGINE_VERSION:-${WORKSPACE_RIVETKIT_VERSION}}"
NAPI_VERSION="${RIVET_NAPI_VERSION:-${WORKSPACE_RIVETKIT_VERSION}}"
echo "== workspace rivetkit ${WORKSPACE_RIVETKIT_VERSION} (engine ${ENGINE_VERSION}, napi ${NAPI_VERSION}) =="

echo "== staging the engine binary (@rivetkit/engine-cli-linux-x64-musl@${ENGINE_VERSION}) =="
rm -rf deploy/engine/stage deploy/engine/rivet-engine
mkdir -p deploy/engine/stage
npm pack "@rivetkit/engine-cli-linux-x64-musl@${ENGINE_VERSION}" --pack-destination deploy/engine/stage >/dev/null
tar -xzf deploy/engine/stage/*.tgz -C deploy/engine/stage
cp deploy/engine/stage/package/rivet-engine deploy/engine/rivet-engine
rm -rf deploy/engine/stage

echo "== building the runtime bundle =="
rm -rf deploy/mate/mate-runtime.mjs deploy/mate/node_modules
mkdir -p deploy/mate/node_modules/@rivetkit/rivetkit-napi
npx esbuild src/runtime.ts \
	--bundle --platform=node --format=esm --target=node22 \
	--outfile=deploy/mate/mate-runtime.mjs \
	--external:@rivetkit/rivetkit-napi \
	--banner:js="import { createRequire as __mateCreateRequire } from 'node:module'; const require = __mateCreateRequire(import.meta.url);"

echo "== staging the rivetkit-napi addon (@rivetkit/rivetkit-napi@${NAPI_VERSION}) =="
NAPI_STAGE="$(mktemp -d)"
trap 'rm -rf "${NAPI_STAGE}"' EXIT
mkdir -p "${NAPI_STAGE}/wrapper" "${NAPI_STAGE}/platform"
npm pack "@rivetkit/rivetkit-napi@${NAPI_VERSION}" --pack-destination "${NAPI_STAGE}/wrapper" >/dev/null
npm pack "@rivetkit/rivetkit-napi-linux-x64-gnu@${NAPI_VERSION}" --pack-destination "${NAPI_STAGE}/platform" >/dev/null
tar -xzf "${NAPI_STAGE}/wrapper/"*.tgz -C "${NAPI_STAGE}/wrapper"
tar -xzf "${NAPI_STAGE}/platform/"*.tgz -C "${NAPI_STAGE}/platform"
cp "${NAPI_STAGE}/wrapper/package/package.json" \
	"${NAPI_STAGE}/wrapper/package/index.js" \
	"${NAPI_STAGE}/wrapper/package/index.d.ts" \
	deploy/mate/node_modules/@rivetkit/rivetkit-napi/
cp "${NAPI_STAGE}/platform/package/rivetkit-napi.linux-x64-gnu.node" \
	deploy/mate/node_modules/@rivetkit/rivetkit-napi/

echo "== docker build =="
docker build -t pi-mate-engine:latest deploy/engine
docker build -t pi-mate-runtime:latest deploy/mate

echo "== images ready =="
docker images --format "{{.Repository}}:{{.Tag}} {{.Size}}" | grep '^pi-mate-' || true
