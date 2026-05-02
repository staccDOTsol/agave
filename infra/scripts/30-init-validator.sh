#!/usr/bin/env bash
# 30-init-validator.sh — generate keypairs and init the ledger from staccana genesis.
#
# v0 / mainnet-sigma path: use VANILLA `solana-genesis` to build the base ledger with the
# right fee governor + inflation, then deploy the lazy-claim program as a regular program
# AFTER first slot. The merkle root is written via a one-time `init_config` ix after
# deploy.
#
# v1.1 will write a single genesis.bin with the lazy-claim program account + treasury PDA
# pre-credited at slot 0; for now we accept that the program-state account materializes
# at slot 1+ instead of slot 0. Functionally equivalent for users.

set -euo pipefail

KEY_DIR="${KEY_DIR:-/etc/staccana/keys}"
LEDGER_DIR="${LEDGER_DIR:-/var/lib/staccana/ledger}"
GENESIS_DIR="${GENESIS_DIR:-/var/lib/staccana/genesis}"
COMPOSED="${COMPOSED:-$GENESIS_DIR/composed-genesis.json}"

mkdir -p "$KEY_DIR" "$LEDGER_DIR"
chmod 700 "$KEY_DIR"

# 1. Generate the three core keypairs. Idempotent — never overwrites existing keys.
for k in identity vote stake; do
  if [[ ! -f "$KEY_DIR/$k.json" ]]; then
    solana-keygen new --no-passphrase --silent --outfile "$KEY_DIR/$k.json"
    echo "[init] generated $k keypair: $(solana-keygen pubkey $KEY_DIR/$k.json)"
  fi
done

IDENTITY=$(solana-keygen pubkey "$KEY_DIR/identity.json")
VOTE=$(solana-keygen pubkey "$KEY_DIR/vote.json")
STAKE=$(solana-keygen pubkey "$KEY_DIR/stake.json")

echo "[init] identity=$IDENTITY"
echo "[init] vote    =$VOTE"
echo "[init] stake   =$STAKE"

# 2. Pull staccana-specific params from composed-genesis.json (fee governor, inflation,
# treasury lamports, claimable_root). These were produced by step 20-build-genesis.sh.
if [[ ! -f "$COMPOSED" ]]; then
  echo "[init] FATAL: $COMPOSED not found — run 20-build-genesis.sh first" >&2
  exit 1
fi

FEE_LAMPORTS=$(jq -r '.fee_governor.target_lamports_per_signature' "$COMPOSED")
TREASURY_LAMPORTS=$(jq -r '.treasury_lamports' "$COMPOSED")
CLAIMABLE_ROOT_HEX=$(jq -r '.lazy_claim.claimable_root' "$COMPOSED")

# 3. Build the base genesis with vanilla solana-genesis. We pin:
#   - target-lamports-per-signature 27_000_000 (classic v1's 0.027 SOL fixed fee)
#   - inflation: none (--no-inflation per cluster-type override below)
#   - bootstrap validator with the keypairs from step 1
#   - cluster-type = development so default features are conservative; we then activate
#     the four ZK gates manually via solana feature activate after first boot.
solana-genesis \
  --bootstrap-validator "$IDENTITY" "$VOTE" "$STAKE" \
  --bootstrap-validator-lamports 1000000000 \
  --bootstrap-validator-stake-lamports 1000000000 \
  --target-lamports-per-signature "$FEE_LAMPORTS" \
  --target-signatures-per-slot 0 \
  --inflation none \
  --cluster-type development \
  --ledger "$LEDGER_DIR"

GENESIS_HASH=$(solana-ledger-tool -l "$LEDGER_DIR" genesis-hash 2>/dev/null | tail -1)
echo "[init] vanilla ledger initialized at $LEDGER_DIR"
echo "[init] genesis hash: $GENESIS_HASH"
echo "[init] treasury lamports queued for post-boot deposit: $TREASURY_LAMPORTS"
echo "[init] claimable_root for post-deploy init: $CLAIMABLE_ROOT_HEX"

# Stash for 40-deploy-programs.sh and 50-init-state.sh to consume.
cat > "$GENESIS_DIR/post-boot-state.json" <<EOF
{
  "treasury_lamports": $TREASURY_LAMPORTS,
  "claimable_root_hex": "$CLAIMABLE_ROOT_HEX",
  "genesis_hash": "$GENESIS_HASH",
  "identity_pubkey": "$IDENTITY",
  "vote_pubkey": "$VOTE",
  "stake_pubkey": "$STAKE"
}
EOF

echo "[init] done."
echo "[init] next: systemctl enable --now staccana-validator"
echo "[init] then: ./40-deploy-programs.sh    (deploys lazy-claim, bridge, secret-pump)"
echo "[init] then: ./50-init-state.sh         (writes claimable_root into lazy-claim Config; pre-credits treasury PDA)"
