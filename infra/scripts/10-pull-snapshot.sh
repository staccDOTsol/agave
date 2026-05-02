#!/usr/bin/env bash
# 10-pull-snapshot.sh — fetch a recent Solana mainnet snapshot.
#
# We need a snapshot at slot S to build staccana's genesis from.

set -euo pipefail

SNAPSHOT_DIR="${SNAPSHOT_DIR:-/var/lib/staccana/snapshot-cache}"
SNAPSHOT_SLOT="${SNAPSHOT_SLOT:-}"  # leave empty to grab latest from a known validator
KNOWN_VALIDATOR="${KNOWN_VALIDATOR:-7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2}"  # one of the well-known mainnet validators
RPC_URL="${RPC_URL:-https://api.mainnet-beta.solana.com}"

mkdir -p "$SNAPSHOT_DIR"

echo "[snapshot] starting fetch — known-validator=$KNOWN_VALIDATOR"

# Use solana-validator's snapshot-only mode. Spins up briefly, downloads the snapshot
# from the gossip network, then exits. ~5-15 minutes depending on snapshot size.
agave-validator \
  --no-voting \
  --rpc-port 0 \
  --gossip-port 8001 \
  --ledger "$SNAPSHOT_DIR/ledger" \
  --known-validator "$KNOWN_VALIDATOR" \
  --only-known-rpc \
  --entrypoint entrypoint.mainnet-beta.solana.com:8001 \
  --entrypoint entrypoint2.mainnet-beta.solana.com:8001 \
  --entrypoint entrypoint3.mainnet-beta.solana.com:8001 \
  --no-snapshot-fetch-error \
  --maximum-local-snapshot-age 9999 \
  --snapshot-fetch-only

# After exit, the snapshot lives at $SNAPSHOT_DIR/ledger/snapshot-XXXXXXXX-*.tar.zst
LATEST_SNAPSHOT=$(ls -1 "$SNAPSHOT_DIR/ledger"/snapshot-*-*.tar.zst | sort -V | tail -1)
LATEST_SLOT=$(basename "$LATEST_SNAPSHOT" | sed -E 's/snapshot-([0-9]+)-.*/\1/')

echo "[snapshot] downloaded $LATEST_SNAPSHOT (slot $LATEST_SLOT)"
echo "$LATEST_SLOT" > "$SNAPSHOT_DIR/.snapshot-slot"
echo "$LATEST_SNAPSHOT" > "$SNAPSHOT_DIR/.snapshot-path"
echo "[snapshot] done. next: ./20-build-genesis.sh"
