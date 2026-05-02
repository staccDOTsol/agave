#!/usr/bin/env bash
# 30-init-validator.sh — generate keypairs and bake the staccana ledger from genesis.
#
# v1 / mainnet-sigma path: this script now drives `staccana-genesis-bake`, which produces
# a *real* staccana genesis.bin with the treasury PDA pre-credited (485M SOL), the
# lazy-claim Config PDA pre-populated with the embedded Merkle root, the four CTE
# feature gates flipped on at slot 0, and the five staccana programs registered as
# upgradeable BPF builtins. The earlier `solana-genesis` invocation produced only a
# 3.22 SOL bootstrap ledger and is no longer used.
#
# Inputs consumed:
#   - $COMPOSED                           composed-genesis.json (from 20-build-genesis.sh)
#   - $KEY_DIR/{identity,vote,stake,faucet}.json   bootstrap keypairs (auto-generated)
#   - $SO_DIR/staccana_*.so               BPF program binaries
#
# Output:
#   - $LEDGER_DIR/genesis.bin             validator-bootable genesis
#   - $GENESIS_DIR/post-boot-state.json   metadata stash for steps 40-50
#
# IMPORTANT: the .so artifacts must exist before this script runs. Build them via
# step 25 (or wherever `cargo build-sbf` / `anchor build` lives in the deploy
# pipeline) BEFORE invoking this script. Missing .so files are skipped with a
# warning rather than fatally — the chain still boots, but those programs would
# need a post-boot `solana program deploy` to become executable. For mainnet-sigma
# launch night, all five programs MUST be present.

set -euo pipefail

KEY_DIR="${KEY_DIR:-/etc/staccana/keys}"
LEDGER_DIR="${LEDGER_DIR:-/var/lib/staccana/ledger}"
GENESIS_DIR="${GENESIS_DIR:-/var/lib/staccana/genesis}"
COMPOSED="${COMPOSED:-$GENESIS_DIR/composed-genesis.json}"
STACCANA_DIR="${STACCANA_DIR:-/opt/staccana}"
SO_DIR="${SO_DIR:-$STACCANA_DIR/target/deploy}"

mkdir -p "$KEY_DIR" "$LEDGER_DIR"
chmod 700 "$KEY_DIR"

# 1. Generate the four core keypairs. Idempotent — never overwrites existing keys.
# faucet is generated even though staccana doesn't run a faucet on mainnet — kept so
# tooling that expects a faucet pubkey doesn't crash in dev / staging.
for k in identity vote stake faucet; do
  if [[ ! -f "$KEY_DIR/$k.json" ]]; then
    solana-keygen new --no-passphrase --silent --outfile "$KEY_DIR/$k.json"
    echo "[init] generated $k keypair: $(solana-keygen pubkey $KEY_DIR/$k.json)"
  fi
done

IDENTITY=$(solana-keygen pubkey "$KEY_DIR/identity.json")
VOTE=$(solana-keygen pubkey "$KEY_DIR/vote.json")
STAKE=$(solana-keygen pubkey "$KEY_DIR/stake.json")
FAUCET=$(solana-keygen pubkey "$KEY_DIR/faucet.json")

echo "[init] identity=$IDENTITY"
echo "[init] vote    =$VOTE"
echo "[init] stake   =$STAKE"
echo "[init] faucet  =$FAUCET (placeholder — staccana doesn't run a faucet on mainnet)"

# 2. Sanity-check the composed genesis (produced by step 20).
if [[ ! -f "$COMPOSED" ]]; then
  echo "[init] FATAL: $COMPOSED not found — run 20-build-genesis.sh first" >&2
  exit 1
fi

# 3. Resolve the .so paths. Each is optional at the binary level (genesis-bake skips
# missing programs); we warn but do not fail so dev clusters can boot with a partial
# program set.
declare -a SO_FLAGS=()
add_so_flag() {
  local flag="$1"; local path="$2"; local label="$3"
  if [[ -f "$path" ]]; then
    SO_FLAGS+=("$flag" "$path")
    echo "[init] including $label .so: $path"
  else
    echo "[init] WARNING: $label .so not found at $path — program will be SKIPPED" >&2
    echo "[init]          chain will boot, but $label needs a post-boot 'solana program deploy'" >&2
  fi
}
add_so_flag --lazy-claim-so         "$SO_DIR/staccana_lazy_claim.so"          lazy-claim
add_so_flag --bridge-so             "$SO_DIR/staccana_bridge.so"              bridge
add_so_flag --secret-pump-so        "$SO_DIR/staccana_secret_pump.so"         secret-pump
add_so_flag --validator-subsidy-so  "$SO_DIR/staccana_validator_subsidy.so"   validator-subsidy
add_so_flag --megadrop-so           "$SO_DIR/staccana_megadrop.so"            megadrop

# 4. Bake the genesis. Replaces the prior `solana-genesis` invocation entirely.
#
# The new genesis hash will be DIFFERENT from the v0 vanilla one (Fp98...4FKqw); that's
# correct — it's a different genesis (treasury pre-credited, programs pre-registered,
# CTE gates flipped on). The bake binary logs the new hash to stderr.
cargo run --release \
  --manifest-path "$STACCANA_DIR/tools/genesis-bake/Cargo.toml" \
  -- \
  --composed-genesis    "$COMPOSED" \
  --identity-keypair    "$KEY_DIR/identity.json" \
  --vote-keypair        "$KEY_DIR/vote.json" \
  --stake-keypair       "$KEY_DIR/stake.json" \
  --faucet-keypair      "$KEY_DIR/faucet.json" \
  "${SO_FLAGS[@]}" \
  --output-genesis      "$LEDGER_DIR/genesis.bin"

GENESIS_HASH=$(solana-ledger-tool -l "$LEDGER_DIR" genesis-hash 2>/dev/null | tail -1)
echo "[init] staccana ledger initialized at $LEDGER_DIR"
echo "[init] genesis hash: $GENESIS_HASH"

# 5. Cross-check post-boot metadata for steps 40 / 50 to consume. With the bake
# script most of this state is already live in the genesis (treasury pre-credited,
# lazy-claim Config materialized at slot 0), but downstream scripts still want the
# raw values for sanity checks.
TREASURY_LAMPORTS=$(jq -r '.treasury_pda_lamports' "$COMPOSED")
CLAIMABLE_ROOT_HEX=$(jq -r '.lazy_claim_account.claimable_root | map(.) | join(",")' "$COMPOSED")

cat > "$GENESIS_DIR/post-boot-state.json" <<EOF
{
  "treasury_lamports": $TREASURY_LAMPORTS,
  "claimable_root_array": [$CLAIMABLE_ROOT_HEX],
  "genesis_hash": "$GENESIS_HASH",
  "identity_pubkey": "$IDENTITY",
  "vote_pubkey": "$VOTE",
  "stake_pubkey": "$STAKE",
  "faucet_pubkey": "$FAUCET"
}
EOF

echo "[init] done."
echo "[init] next: systemctl enable --now staccana-validator"
echo "[init] then: ./40-deploy-programs.sh    (deploys any programs that were skipped above; idempotent for already-installed builtins)"
echo "[init] then: ./50-init-state.sh         (post-boot state init for governance / federation set; lazy-claim Config + treasury PDA already live from genesis)"
