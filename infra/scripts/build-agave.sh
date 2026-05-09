#!/usr/bin/env bash
# build-agave.sh — clone + build the patched staccana validator binary.
#
# What it does:
#   1. Clones (or fast-forwards) the staccDOTsol/agave fork at ./agave-src
#   2. Checks out the staccana-3.1.14 branch
#   3. Runs `cargo build --release` to produce target/release/agave-validator
#
# What's in the patched branch vs. upstream anza-xyz/agave v3.1.14:
#   - fs/src/buffered_reader.rs  : assert!(io_uring_supported()) → if/else fallback
#   - fs/src/dirs.rs              : same, two more spots
#   That's it. 35 lines. Zero consensus, ledger, FBA, or program-activation changes.
#
# Why a separate branch and not a patch file:
#   The fork keeps `git log` clean for downstream contributors (Ooze, etc.)
#   and lets cargo's lockfile pin to a specific revision in case we ever
#   want to vendor agave back into this repo as a submodule.
#
# Output:
#   ./agave-src/target/release/agave-validator  — the binary
#
# Re-run-safe. The git fetch is incremental; cargo build is incremental.

set -euo pipefail

REPO_URL="${STACCANA_AGAVE_REPO:-https://github.com/staccDOTsol/agave}"
BRANCH="${STACCANA_AGAVE_BRANCH:-staccana-3.1.14}"
DEST_DIR="${STACCANA_AGAVE_DIR:-$(pwd)/agave-src}"

echo "[build-agave] $(date -Iseconds) starting"
echo "[build-agave] repo:   $REPO_URL"
echo "[build-agave] branch: $BRANCH"
echo "[build-agave] dest:   $DEST_DIR"

if [[ ! -d "$DEST_DIR/.git" ]]; then
  echo "[build-agave] cloning fresh"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$DEST_DIR"
else
  echo "[build-agave] updating existing checkout"
  cd "$DEST_DIR"
  git fetch --depth 1 origin "$BRANCH"
  git checkout "$BRANCH"
  git reset --hard "origin/$BRANCH"
  cd - >/dev/null
fi

cd "$DEST_DIR"

# Sanity check — fail loudly if anyone accidentally builds vanilla 3.1.14
# without the patches, since the missing fallbacks would crash on any
# non-io_uring host (WSL2, older kernels). The marker comment is committed
# in the patched branch; absence means the wrong branch is checked out.
if ! grep -q "staccana patch: fall back" fs/src/buffered_reader.rs 2>/dev/null; then
  echo "[build-agave] ERROR: io_uring fallback patch missing in fs/src/buffered_reader.rs."
  echo "             The wrong branch is checked out — expected staccana-3.1.14."
  echo "             git status:"
  git status --short
  exit 1
fi

echo "[build-agave] cargo build --release (this takes a while; ~20-25 min cold)"
cargo build --release --bin agave-validator

echo "[build-agave] done"
echo "[build-agave] binary: $DEST_DIR/target/release/agave-validator"
"$DEST_DIR/target/release/agave-validator" --version
