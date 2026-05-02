#!/usr/bin/env bash
# 40-deploy-programs.sh — build .so artifacts and deploy after first validator boot.
#
# Run this AFTER the validator is producing slots (so the RPC accepts deploys).

set -euo pipefail

STACCANA_DIR="${STACCANA_DIR:-/opt/staccana}"
KEY_DIR="${KEY_DIR:-/etc/staccana/keys}"
RPC="${RPC:-http://localhost:8899}"

# Configure solana CLI to talk to local validator
solana config set --url "$RPC" --keypair "$KEY_DIR/identity.json"

# Build artifacts
echo "[deploy] building lazy-claim (native solana-program)"
cargo build-sbf \
  --manifest-path "$STACCANA_DIR/programs/lazy-claim/Cargo.toml" \
  --sbf-out-dir "$STACCANA_DIR/target/deploy"

echo "[deploy] building bridge (Anchor)"
(cd "$STACCANA_DIR/programs/bridge" && anchor build)

echo "[deploy] building secret-pump (Anchor)"
(cd "$STACCANA_DIR/programs/secret-pump" && anchor build)

# Generate program-id keypairs if missing. These addresses become the well-known PROGRAM_IDs.
for p in lazy-claim bridge secret-pump validator-subsidy; do
  if [[ ! -f "$KEY_DIR/program-$p.json" ]]; then
    solana-keygen new --no-passphrase --silent --outfile "$KEY_DIR/program-$p.json"
    echo "[deploy] $p program id: $(solana-keygen pubkey $KEY_DIR/program-$p.json)"
  fi
done

# Deploy each program
solana program deploy \
  --program-id "$KEY_DIR/program-lazy-claim.json" \
  "$STACCANA_DIR/target/deploy/staccana_lazy_claim.so"

solana program deploy \
  --program-id "$KEY_DIR/program-bridge.json" \
  "$STACCANA_DIR/programs/bridge/target/deploy/staccana_bridge.so"

solana program deploy \
  --program-id "$KEY_DIR/program-secret-pump.json" \
  "$STACCANA_DIR/programs/secret-pump/target/deploy/staccana_secret_pump.so"

echo "[deploy] done. next: ./50-init-state.sh"
