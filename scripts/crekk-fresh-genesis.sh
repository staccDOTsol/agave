#!/usr/bin/env bash
# Create an independent crekk ledger. Run on the validator host after building
# the crekk Agave binaries. This script never reads the model mint keypair.
set -euo pipefail
umask 077

usage() {
  cat >&2 <<'EOF'
Usage: MODEL_PROGRAM_SO=/abs/path/sea_chat_inference.so \
       crekk-fresh-genesis.sh /abs/path/chain-data

Optional public values:
  TREASURY_PUBKEY       Defaults to the existing agent wallet D88qw...te2wa.
  MODEL_MINT_PUBKEY     Defaults to the new unused DxNX...ichat address.
  PROGRAM_UPGRADE_AUTHORITY  Defaults to TREASURY_PUBKEY.
  TREASURY_LAMPORTS     Defaults to 2,000,000,000 SOL in lamports.
  BOOTSTRAP_VALIDATOR_LAMPORTS  Defaults to 500 SOL in lamports.
  BOOTSTRAP_STAKE_LAMPORTS  Defaults to 1,000,000 SOL in lamports.
EOF
  exit 2
}

[[ $# -eq 1 ]] || usage
DATA_DIR=$1
[[ $DATA_DIR = /* ]] || { echo 'DATA_DIR must be absolute' >&2; exit 2; }

CREKK_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
KEYGEN="$CREKK_ROOT/target/release/solana-keygen"
GENESIS="$CREKK_ROOT/target/release/solana-genesis"
TREASURY_PUBKEY=${TREASURY_PUBKEY:-D88qwUFs75jLzVD9noGp8nyPEw4yqqvco3oMrRote2wa}
MODEL_MINT_PUBKEY=${MODEL_MINT_PUBKEY:-DxNXApfiPXYcobrM3NsePAXMDYyaPgB8jfK4yc9ichat}
PROGRAM_UPGRADE_AUTHORITY=${PROGRAM_UPGRADE_AUTHORITY:-$TREASURY_PUBKEY}
TREASURY_LAMPORTS=${TREASURY_LAMPORTS:-2000000000000000000}
BOOTSTRAP_VALIDATOR_LAMPORTS=${BOOTSTRAP_VALIDATOR_LAMPORTS:-500000000000}
BOOTSTRAP_STAKE_LAMPORTS=${BOOTSTRAP_STAKE_LAMPORTS:-1000000000000000}
MODEL_PROGRAM_ID=BkWuzU3fn4NS7LXdBxH1j4gRyRw3ma35aNGytbANzUvB
UPGRADEABLE_LOADER=BPFLoaderUpgradeab1e11111111111111111111111

for name in TREASURY_LAMPORTS BOOTSTRAP_VALIDATOR_LAMPORTS BOOTSTRAP_STAKE_LAMPORTS; do
  value=${!name:-}
  [[ $value =~ ^[1-9][0-9]*$ ]] || { echo "$name must be a positive integer" >&2; usage; }
done
[[ ${MODEL_PROGRAM_SO:-} = /* && -s ${MODEL_PROGRAM_SO:-/dev/null} ]] || {
  echo 'MODEL_PROGRAM_SO must name an existing absolute .so file' >&2
  usage
}
[[ $MODEL_MINT_PUBKEY != "$TREASURY_PUBKEY" ]] || {
  echo 'The model mint address cannot be the SOL treasury address' >&2
  exit 2
}
[[ -x $KEYGEN && -x $GENESIS ]] || {
  echo 'Build solana-keygen and solana-genesis from this crekk checkout first' >&2
  exit 2
}

KEY_DIR="$DATA_DIR/keys"
LEDGER_DIR="$DATA_DIR/ledger"
ARTIFACT_DIR="$DATA_DIR/genesis-programs"
[[ ! -e "$LEDGER_DIR/genesis.bin" && ! -e "$LEDGER_DIR/genesis.tar.bz2" ]] || {
  echo "Genesis already exists in $LEDGER_DIR; refusing to overwrite it" >&2
  exit 2
}
mkdir -p "$KEY_DIR" "$LEDGER_DIR" "$ARTIFACT_DIR"
chmod 700 "$KEY_DIR"

for role in identity vote stake; do
  if [[ ! -s "$KEY_DIR/$role.json" ]]; then
    "$KEYGEN" new --no-bip39-passphrase --silent --outfile "$KEY_DIR/$role.json"
  fi
done
IDENTITY_PUBKEY=$("$KEYGEN" pubkey "$KEY_DIR/identity.json")
VOTE_PUBKEY=$("$KEYGEN" pubkey "$KEY_DIR/vote.json")
STAKE_PUBKEY=$("$KEYGEN" pubkey "$KEY_DIR/stake.json")
BLS_PUBKEY=$("$KEYGEN" bls_pubkey "$KEY_DIR/identity.json")

# The upstream demo uses these scripts to install the core SBF and SPL
# executables at their standard addresses. Token-2022 is included.
if [[ ! -s "$ARTIFACT_DIR/core-bpf-genesis-args.sh" || ! -s "$ARTIFACT_DIR/spl-genesis-args.sh" ]]; then
  (
    cd "$ARTIFACT_DIR"
    "$CREKK_ROOT/fetch-core-bpf.sh"
    "$CREKK_ROOT/fetch-spl.sh"
  )
fi
[[ -s "$ARTIFACT_DIR/core-bpf-genesis-args.sh" && -s "$ARTIFACT_DIR/spl-genesis-args.sh" ]] || {
  echo 'Could not stage core/SPL genesis programs' >&2
  exit 1
}
read -r -a core_args < "$ARTIFACT_DIR/core-bpf-genesis-args.sh"
read -r -a spl_args < "$ARTIFACT_DIR/spl-genesis-args.sh"

(
  cd "$ARTIFACT_DIR"
  "$GENESIS" \
    --ledger "$LEDGER_DIR" \
    --cluster-type development \
    --enable-warmup-epochs \
    --max-genesis-archive-unpacked-size 1073741824 \
    --bootstrap-validator "$IDENTITY_PUBKEY" "$VOTE_PUBKEY" "$STAKE_PUBKEY" \
    --bootstrap-validator-bls-pubkey "$BLS_PUBKEY" \
    --bootstrap-validator-lamports "$BOOTSTRAP_VALIDATOR_LAMPORTS" \
    --bootstrap-validator-stake-lamports "$BOOTSTRAP_STAKE_LAMPORTS" \
    --faucet-pubkey "$TREASURY_PUBKEY" \
    --faucet-lamports "$TREASURY_LAMPORTS" \
    "${core_args[@]}" \
    "${spl_args[@]}" \
    --upgradeable-program "$MODEL_PROGRAM_ID" "$UPGRADEABLE_LOADER" \
      "$MODEL_PROGRAM_SO" "$PROGRAM_UPGRADE_AUTHORITY"
)

echo "Fresh genesis created: $LEDGER_DIR"
echo "Validator identity: $IDENTITY_PUBKEY"
echo "Validator vote: $VOTE_PUBKEY"
echo "Treasury: $TREASURY_PUBKEY"
echo "Reserved model mint address: $MODEL_MINT_PUBKEY"
echo "Treasury lamports: $TREASURY_LAMPORTS"
echo "Validator identity lamports: $BOOTSTRAP_VALIDATOR_LAMPORTS"
echo "Validator stake lamports: $BOOTSTRAP_STAKE_LAMPORTS"
echo "Configured allocation: $((TREASURY_LAMPORTS + BOOTSTRAP_VALIDATOR_LAMPORTS + BOOTSTRAP_STAKE_LAMPORTS)) lamports"
echo "Inference program: $MODEL_PROGRAM_ID"
echo 'The vanity model mint is intentionally created after bootstrap from a local signer.'
