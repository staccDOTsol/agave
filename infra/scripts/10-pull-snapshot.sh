#!/usr/bin/env bash
# 10-pull-snapshot.sh — fetch a recent Solana mainnet snapshot.
#
# The snapshot-fetch-only mode of agave-validator was removed in 2.0.25, so we use
# `solana-snapshot-finder` (the community-standard discovery + download tool) to find a
# working mainnet mirror and pull from it.
#
# Mainnet snapshots are ~200GB. Allow several minutes to many hours depending on your
# bandwidth. Cherryservers boxes typically pull at 50-200 MB/s — figure 30 min to a
# couple hours wall-clock.

set -euo pipefail

SNAPSHOT_DIR="${SNAPSHOT_DIR:-/var/lib/staccana/snapshot-cache}"
MAX_SNAPSHOT_AGE="${MAX_SNAPSHOT_AGE:-1500}"  # slots; ~10 minutes at 400ms slot time

mkdir -p "$SNAPSHOT_DIR"

# Install solana-snapshot-finder via pip if not already present.
if ! command -v solana-snapshot-finder >/dev/null 2>&1; then
  echo "[snapshot] installing solana-snapshot-finder"
  apt-get install -y --no-install-recommends python3-pip python3-venv >/dev/null
  # Ubuntu 24.04 disallows global pip installs by default; --break-system-packages is the
  # documented opt-out for ops-style installs on dedicated boxes.
  pip install --break-system-packages solana-snapshot-finder >/dev/null
fi

echo "[snapshot] starting fetch (max age ${MAX_SNAPSHOT_AGE} slots)"
solana-snapshot-finder \
  --snapshot_path "$SNAPSHOT_DIR" \
  --max_snapshot_age "$MAX_SNAPSHOT_AGE"

# After exit, the snapshot lives at $SNAPSHOT_DIR/snapshot-XXXXXXXX-*.tar.zst
LATEST_SNAPSHOT=$(ls -1 "$SNAPSHOT_DIR"/snapshot-*-*.tar.zst 2>/dev/null | sort -V | tail -1)
if [[ -z "$LATEST_SNAPSHOT" ]]; then
  echo "[snapshot] FATAL: solana-snapshot-finder did not produce a snapshot file" >&2
  exit 1
fi

LATEST_SLOT=$(basename "$LATEST_SNAPSHOT" | sed -E 's/snapshot-([0-9]+)-.*/\1/')

echo "[snapshot] downloaded $LATEST_SNAPSHOT (slot $LATEST_SLOT)"
echo "$LATEST_SLOT" > "$SNAPSHOT_DIR/.snapshot-slot"
echo "$LATEST_SNAPSHOT" > "$SNAPSHOT_DIR/.snapshot-path"
echo "[snapshot] done. next: ./20-build-genesis.sh"
