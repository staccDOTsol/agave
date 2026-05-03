#!/usr/bin/env bash
# build-and-push.sh — assemble + publish jrsdunn/solana-classic-validator:v2.x
#
# Run this from val-1 (where the freshly-baked ledger lives + agave-validator
# binary is already at /usr/local/bin). The script materializes a tiny build
# context (just the binaries + ledger seed + run script — no full source tree)
# and hands it to `docker build` so we don't ship 50GB of cargo target dirs
# inside the image.
#
# Required env:
#   DOCKER_USERNAME    Docker Hub user (default: jrsdunn)
#   (run `docker login -u "$DOCKER_USERNAME"` once before invoking — token
#    cached in /root/.docker/config.json from then on)
#
# Optional env:
#   IMAGE_REPO         Docker Hub repo  (default: jrsdunn/solana-classic-validator)
#   VERSION_TAG        version tag      (default: v2.0.0-devnet-YYYYMMDD)
#   PLATFORM           buildx platforms (default: linux/amd64; add ,linux/arm64
#                      for multi-arch — needs qemu emulation set up)
#   PUSH               1 = docker push, 0 = local build only (default: 1)

set -euo pipefail

DOCKER_USERNAME="${DOCKER_USERNAME:-jrsdunn}"
IMAGE_REPO="${IMAGE_REPO:-jrsdunn/solana-classic-validator}"
VERSION_TAG="${VERSION_TAG:-v2.0.0-devnet-$(date -u +%Y%m%d)}"
PLATFORM="${PLATFORM:-linux/amd64}"
PUSH="${PUSH:-1}"

LEDGER_SRC="${LEDGER_SRC:-/var/lib/staccana/ledger}"
PROGRAM_IDS="${PROGRAM_IDS:-/etc/staccana/program-ids.json}"
BIN_DIR="${BIN_DIR:-/usr/local/bin}"

DOCKER_DIR="$(cd "$(dirname "$0")" && pwd)"
CTX_DIR="$(mktemp -d -t staccana-docker-ctx-XXXXXX)"
trap 'rm -rf "$CTX_DIR"' EXIT

echo "[docker] assembling build context at $CTX_DIR"
mkdir -p "$CTX_DIR/bin" "$CTX_DIR/ledger"

# 1. agave-validator binaries
for b in agave-validator agave-ledger-tool solana solana-keygen; do
  if [[ ! -x "$BIN_DIR/$b" ]]; then
    echo "[docker] FATAL: $BIN_DIR/$b not found or not executable" >&2
    exit 1
  fi
  cp -p "$BIN_DIR/$b" "$CTX_DIR/bin/$b"
done

# 2. Ledger seed (genesis.bin + rocksdb)
if [[ ! -f "$LEDGER_SRC/genesis.bin" ]]; then
  echo "[docker] FATAL: $LEDGER_SRC/genesis.bin not found — run step 30 first" >&2
  exit 1
fi
cp "$LEDGER_SRC/genesis.bin" "$CTX_DIR/ledger/genesis.bin"
if [[ -d "$LEDGER_SRC/rocksdb" ]]; then
  cp -r "$LEDGER_SRC/rocksdb" "$CTX_DIR/ledger/rocksdb"
fi

# 3. program-ids.json
if [[ -f "$PROGRAM_IDS" ]]; then
  cp "$PROGRAM_IDS" "$CTX_DIR/program-ids.json"
else
  echo '{"_warning":"program-ids.json missing at build time"}' > "$CTX_DIR/program-ids.json"
fi

# 4. Dockerfile + run script
cp "$DOCKER_DIR/Dockerfile" "$CTX_DIR/Dockerfile"
cp "$DOCKER_DIR/staccana-run.sh" "$CTX_DIR/staccana-run.sh"

CTX_SIZE=$(du -sh "$CTX_DIR" | cut -f1)
echo "[docker] build context size: $CTX_SIZE"
echo "[docker] image: $IMAGE_REPO:$VERSION_TAG"
echo "[docker] image: $IMAGE_REPO:latest"
echo "[docker] platform: $PLATFORM"

# Use buildx if multi-arch was requested OR push=1 (buildx handles --push natively)
USE_BUILDX=0
if [[ "$PLATFORM" == *","* || "$PUSH" == "1" ]]; then
  USE_BUILDX=1
fi

if [[ "$USE_BUILDX" == "1" ]]; then
  if ! docker buildx inspect staccana-builder >/dev/null 2>&1; then
    docker buildx create --name staccana-builder --driver docker-container --use
    docker buildx inspect --bootstrap
  else
    docker buildx use staccana-builder
  fi
  PUSH_FLAG=""
  [[ "$PUSH" == "1" ]] && PUSH_FLAG="--push"
  docker buildx build \
    --platform "$PLATFORM" \
    -t "$IMAGE_REPO:$VERSION_TAG" \
    -t "$IMAGE_REPO:latest" \
    $PUSH_FLAG \
    "$CTX_DIR"
else
  docker build \
    -t "$IMAGE_REPO:$VERSION_TAG" \
    -t "$IMAGE_REPO:latest" \
    "$CTX_DIR"
fi

echo "[docker] done."
[[ "$PUSH" == "1" ]] && echo "[docker] pushed: https://hub.docker.com/r/${IMAGE_REPO}/tags"
