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
#   - $LEDGER_DIR/genesis.tar.bz2         tar+bzip2 of genesis.bin + rocksdb (snapshot bootstrap)
#   - $LEDGER_DIR/rocksdb/                blockstore pre-seeded with slot 0 ticks
#   - $GENESIS_DIR/post-boot-state.json   metadata stash for steps 40-50
#
# NOTE: genesis-bake destroys any existing $LEDGER_DIR contents (Blockstore::destroy
# is idempotent), so re-runs are safe. Don't pre-wipe.
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
# CLUSTER_TYPE controls the cluster_type field baked into genesis. For tonight's
# devnet shake-out: development. For the real mainnet-sigma launch (2026-05-16):
# mainnet-beta. Override via env var if needed. Valid values:
#   development | devnet | testnet | mainnet-beta
CLUSTER_TYPE="${CLUSTER_TYPE:-development}"

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
  --cluster-type        "$CLUSTER_TYPE" \
  "${SO_FLAGS[@]}" \
  --output-ledger-dir   "$LEDGER_DIR"

# Detect the ledger tool binary FIRST, before any invocation. agave 2.x rebrands
# `solana-ledger-tool` -> `agave-ledger-tool`; on a fresh box only the new name
# exists. Using the wrong name triggers a `command not found` (exit 127) that
# `set -o pipefail` (active via `set -euo pipefail` at the top of this script)
# turns into a silent script abort even when stderr is redirected to /dev/null —
# this is exactly how an earlier version of this script ate the bank-hash logic
# without leaving any trace.
LEDGER_TOOL_BIN=""
if command -v agave-ledger-tool >/dev/null 2>&1; then
  LEDGER_TOOL_BIN=agave-ledger-tool
elif command -v solana-ledger-tool >/dev/null 2>&1; then
  LEDGER_TOOL_BIN=solana-ledger-tool
else
  echo "[init] FATAL: neither agave-ledger-tool nor solana-ledger-tool found in PATH" >&2
  exit 1
fi
echo "[init] using ledger tool: $LEDGER_TOOL_BIN"

GENESIS_HASH=$($LEDGER_TOOL_BIN -l "$LEDGER_DIR" genesis-hash 2>/dev/null | tail -1)
echo "[init] staccana ledger initialized at $LEDGER_DIR"
echo "[init] genesis hash: $GENESIS_HASH"

# Compute the bank-0 hash for `--expected-bank-hash`. Required by the systemd unit's
# `--wait-for-supermajority 0` flag, which is what unblocks the single-validator
# tower-BFT deadlock (the validator can't land its first vote without it — the
# threshold check rejects every vote with FailedThreshold(_, _, 0, total_stake)).
# This is the same recipe jito-solana's `bootstrap` script and agave's
# `multinode-demo/bootstrap-validator.sh` use.
# `bank-hash` was deprecated in agave 2.0.x in favor of `verify --print-bank-hash`.
# Two complications on agave 2.0.25 reading a blockstore created by our 2.3.x
# `solana-ledger` dep:
#   1. The tool's blockstore opener strict-checks for the `program_costs` column
#      family which 2.3.x dropped — without `--force-update-to-open`, the tool
#      exits before even getting to the verify pass. The flag lets it migrate the
#      blockstore on the fly so it matches what 2.0.25 expects.
#   2. env_logger writes log lines to stderr; the actual `bank.hash()` output goes
#      to stdout via `println!`. The previous version of this script merged the
#      streams with `2>&1` and then `grep`'d any base58-looking string — which
#      matched the genesis hash printed in a log line, NOT the bank hash. We now
#      capture them separately and only extract a base58 hash that lives on a
#      line by itself (program output, no log prefix).
echo "[init] computing bank-0 hash via $LEDGER_TOOL_BIN verify --print-bank-hash..."
BANK_HASH_STDOUT=$($LEDGER_TOOL_BIN -l "$LEDGER_DIR" verify \
  --halt-at-slot 0 \
  --print-bank-hash \
  --force-update-to-open \
  2>/tmp/bank-hash.stderr || true)
echo "[init] (verify stdout):"
printf '%s\n' "$BANK_HASH_STDOUT" | sed 's/^/[init]   /'
echo "[init] (verify stderr, last 8 lines):"
tail -8 /tmp/bank-hash.stderr 2>/dev/null | sed 's/^/[init]   /'
# Output format on agave 2.0.25:
#   `Bank hash for slot 0: <base58>`
# (one line on stdout). Extract the hash via awk taking the last field of the
# matching line — robust against the hash being on its own or prefixed.
BANK_HASH=$(printf '%s\n' "$BANK_HASH_STDOUT" \
  | awk '/^Bank hash for slot [0-9]+:/ {print $NF}' \
  | tail -1)
# Fallback: if the format ever changes back to a bare hash on its own line.
if [[ -z "$BANK_HASH" ]]; then
  BANK_HASH=$(printf '%s\n' "$BANK_HASH_STDOUT" \
    | grep -E '^[1-9A-HJ-NP-Za-km-z]{32,44}$' \
    | tail -1)
fi
if [[ -z "$BANK_HASH" ]]; then
  echo "[init] FATAL: could not extract a base58 bank hash from verify stdout" >&2
  echo "[init]        check stderr above; common causes:" >&2
  echo "[init]          - agave version mismatch (try $LEDGER_TOOL_BIN --version)" >&2
  echo "[init]          - rocksdb permission issues (chown -R staccana:staccana)" >&2
  exit 1
fi
echo "[init] bank-0 hash:   $BANK_HASH"

# Shred version is derived from the genesis hash via
# `solana_sdk::shred_version::version_from_hash`. The validator REQUIRES
# `--expected-shred-version` whenever `--wait-for-supermajority` is set; without it
# the agave-validator CLI parser dumps its full required-args list and exits.
# `agave-ledger-tool shred-version` prints the same value the runtime computes
# internally — pin the validator to it so the supermajority gate doesn't reject the
# local bank as a wrong-fork peer.
# Same treatment as bank-hash: --force-update-to-open to handle the column-family
# version skew, and stdout/stderr split so we don't grep timestamp microseconds
# from log lines (a real shred version is u16, range 0..=65535).
echo "[init] computing shred version via $LEDGER_TOOL_BIN shred-version..."
SHRED_VERSION_STDOUT=$($LEDGER_TOOL_BIN -l "$LEDGER_DIR" shred-version \
  --force-update-to-open \
  2>/tmp/shred-version.stderr || true)
echo "[init] (shred-version stdout):"
printf '%s\n' "$SHRED_VERSION_STDOUT" | sed 's/^/[init]   /'
echo "[init] (shred-version stderr, last 5 lines):"
tail -5 /tmp/shred-version.stderr 2>/dev/null | sed 's/^/[init]   /'
# A bare integer in the u16 range, on its own line. agave-ledger-tool prints
# `shred version: NNNNN` on stdout — extract the number after the colon.
SHRED_VERSION=$(printf '%s\n' "$SHRED_VERSION_STDOUT" \
  | grep -oE '\b[0-9]{1,5}\b' \
  | awk '$1 >= 0 && $1 <= 65535' \
  | tail -1)
if [[ -z "$SHRED_VERSION" ]]; then
  echo "[init] FATAL: could not extract a u16 shred version from stdout above" >&2
  echo "[init]        check stderr above; if the subcommand also doesn't exist on" >&2
  echo "[init]        this agave version, fall back to deriving it from the genesis" >&2
  echo "[init]        hash via solana_sdk::shred_version::version_from_hash" >&2
  exit 1
fi
echo "[init] shred version:  $SHRED_VERSION"

# Write the bank hash to a systemd-readable env file. The validator unit
# (infra/systemd/staccana-validator.service) consumes this via
# `EnvironmentFile=-/etc/staccana/bank-hash` so `--expected-bank-hash $BANK_HASH`
# resolves at start. Re-runs of step 30 produce a new bank hash; keep the file in
# sync.
mkdir -p /etc/staccana
cat > /etc/staccana/bank-hash <<EOF
BANK_HASH=$BANK_HASH
GENESIS_HASH=$GENESIS_HASH
SHRED_VERSION=$SHRED_VERSION
EOF
chmod 644 /etc/staccana/bank-hash
echo "[init] wrote /etc/staccana/bank-hash"

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
