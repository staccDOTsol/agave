#!/usr/bin/env bash
# staccana-run.sh — container entrypoint for jrsdunn/solana-classic-validator:v2.x
#
# Auto-generates a fresh identity/vote/stake keypair on first boot, seeds the
# ledger from the embedded /var/staccana/seed-ledger/ if no on-disk ledger
# exists yet, and joins the staccana cluster as a follower validator via
# val-1's gossip endpoint.
#
# All knobs are env vars (override on `docker run` with -e):
#   STACCANA_ENTRYPOINT   gossip entrypoint (default: 84.32.220.211:8001 = val-1)
#   STACCANA_RPC_PORT     local RPC port    (default: 8899)
#   STACCANA_GOSSIP_PORT  local gossip port (default: 8001)
#   STACCANA_LIMIT_LEDGER_SIZE  ledger size cap in shreds (default: 200_000_000)
#   STACCANA_PUBLIC_IP    if set, advertised in gossip (otherwise auto-discover)
#   STACCANA_EXTRA_ARGS   appended verbatim to the agave-validator invocation
#   STACCANA_LOG_LEVEL    RUST_LOG (default: solana=info,solana_metrics=warn)
#
# Default behavior is "follower validator on a laptop, joins staccana devnet".
# To run as an isolated single-node test cluster (no entrypoint, no peers),
# set STACCANA_ENTRYPOINT=none.

set -euo pipefail

ENTRYPOINT="${STACCANA_ENTRYPOINT:-84.32.220.211:8001}"
RPC_PORT="${STACCANA_RPC_PORT:-8899}"
GOSSIP_PORT="${STACCANA_GOSSIP_PORT:-8001}"
LIMIT_LEDGER_SIZE="${STACCANA_LIMIT_LEDGER_SIZE:-200000000}"
LOG_LEVEL="${STACCANA_LOG_LEVEL:-solana=info,solana_metrics=warn}"

KEY_DIR="${KEY_DIR:-/etc/staccana/keys}"
LEDGER_DIR="${LEDGER_DIR:-/var/lib/staccana/ledger}"
ACCOUNTS_DIR="${ACCOUNTS_DIR:-/var/lib/staccana/accounts}"
SEED_DIR="${SEED_DIR:-/var/staccana/seed-ledger}"
LOG_DIR="${LOG_DIR:-/var/log/staccana}"

mkdir -p "$KEY_DIR" "$LEDGER_DIR" "$ACCOUNTS_DIR" "$LOG_DIR"

# Generate identity / vote / stake on first boot. Idempotent — never overwrites.
for k in identity vote stake; do
  if [[ ! -f "$KEY_DIR/$k.json" ]]; then
    /usr/local/bin/solana-keygen new --no-passphrase --silent --outfile "$KEY_DIR/$k.json"
    echo "[staccana] generated $k keypair: $(/usr/local/bin/solana-keygen pubkey $KEY_DIR/$k.json)"
  fi
done

# Seed the ledger from the embedded slot-0 snapshot iff this container has
# never booted before. Followers will then snapshot-fetch from the cluster.
if [[ ! -f "$LEDGER_DIR/genesis.bin" ]]; then
  echo "[staccana] seeding ledger from $SEED_DIR (first boot)"
  cp -r "$SEED_DIR"/* "$LEDGER_DIR"/
fi

IDENTITY=$(/usr/local/bin/solana-keygen pubkey "$KEY_DIR/identity.json")
VOTE=$(/usr/local/bin/solana-keygen pubkey "$KEY_DIR/vote.json")
echo "[staccana] identity: $IDENTITY"
echo "[staccana] vote:     $VOTE"
echo "[staccana] entrypoint: $ENTRYPOINT"
echo "[staccana] rpc: 0.0.0.0:$RPC_PORT  gossip: 0.0.0.0:$GOSSIP_PORT"

ENTRYPOINT_FLAGS=()
if [[ "$ENTRYPOINT" != "none" ]]; then
  ENTRYPOINT_FLAGS=(--entrypoint "$ENTRYPOINT")
fi

GOSSIP_HOST_FLAGS=()
if [[ -n "${STACCANA_PUBLIC_IP:-}" ]]; then
  GOSSIP_HOST_FLAGS=(--gossip-host "$STACCANA_PUBLIC_IP")
fi

# shellcheck disable=SC2086  # STACCANA_EXTRA_ARGS intentional word-split
exec /usr/local/bin/agave-validator \
  --identity "$KEY_DIR/identity.json" \
  --vote-account "$KEY_DIR/vote.json" \
  --authorized-voter "$KEY_DIR/vote.json" \
  --ledger "$LEDGER_DIR" \
  --accounts "$ACCOUNTS_DIR" \
  --limit-ledger-size "$LIMIT_LEDGER_SIZE" \
  --no-poh-speed-test \
  --no-os-network-limits-test \
  --no-port-check \
  --no-wait-for-vote-to-start-leader \
  --full-rpc-api \
  --enable-rpc-transaction-history \
  --enable-extended-tx-metadata-storage \
  --rpc-pubsub-enable-block-subscription \
  --allow-private-addr \
  --rpc-port "$RPC_PORT" \
  --rpc-bind-address 0.0.0.0 \
  --gossip-port "$GOSSIP_PORT" \
  --dynamic-port-range 8002-8027 \
  --log "$LOG_DIR/validator.log" \
  "${ENTRYPOINT_FLAGS[@]}" \
  "${GOSSIP_HOST_FLAGS[@]}" \
  ${STACCANA_EXTRA_ARGS:-}
