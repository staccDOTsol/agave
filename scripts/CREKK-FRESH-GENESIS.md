# Fresh crekk genesis and shared model address

This procedure creates an independent Agave chain from a new genesis. It does
not import Solana mainnet state or a mainnet snapshot. The model stays in its
existing account shards; only its executable is present at genesis. The new
vanity Token-2022 mint is initialized by a signed transaction after bootstrap.

## Build on the validator host

Use the `crekk` source plus the local 256 MiB loaded-account limit change. The
validator, genesis tool, and keygen must all come from the same checkout.

```bash
git clone --branch crekk --single-branch https://github.com/staccDOTsol/agave.git "$HOME/agave-crekk"
cd "$HOME/agave-crekk"
git rev-parse HEAD  # expected upstream base: d8d06e8b9a6216f079f2c241325759f72f12bfa9
./cargo build --release --locked -j 12 -p agave-validator -p solana-genesis -p solana-keygen -p solana-cli
```

Apply the local `codex/crekk-model-accounts-limit` commit before building if it
has not yet been merged into the remote branch. The separate ledger tool uses
the `dev-bins` workspace and is optional for a genuinely fresh genesis:

```bash
./cargo build --manifest-path dev-bins/Cargo.toml --release --locked -j 12 -p agave-ledger-tool
```

Stage the current `sea_chat_inference.so` executable from the project. The
program keypair is not needed on the validator host because genesis accepts its
public program ID directly. The model mint keypair and treasury keypair stay on
the local signing machine.

## Create genesis on the validator host

The configured genesis allocation is 2,000,000,000 SOL to the treasury,
1,000,000 SOL to bootstrap stake, and 500 SOL to the validator identity: a
2,001,000,500 SOL discretionary allocation (2,001,000,500,000,000,000
lamports). Genesis also funds vote, sysvar, feature, and executable accounts
at rent exemption. The first server genesis had exact capitalization
2,001,000,672.488321040 SOL (2,001,000,672,488,321,040 lamports) across 312
accounts; verify the exact value for any later genesis. The treasury is the
existing agent wallet `D88qwUFs75jLzVD9noGp8nyPEw4yqqvco3oMrRote2wa`,
which is distinct from the unused vanity model mint address
`DxNXApfiPXYcobrM3NsePAXMDYyaPgB8jfK4yc9ichat`. The script generates
validator identity, vote, and stake keypairs on the host; it does not read or
copy either local mint or treasury secret.

```bash
chmod +x scripts/crekk-fresh-genesis.sh
MODEL_PROGRAM_SO=/absolute/path/sea_chat_inference.so \
MODEL_MINT_PUBKEY=DxNXApfiPXYcobrM3NsePAXMDYyaPgB8jfK4yc9ichat \
  scripts/crekk-fresh-genesis.sh "$HOME/crekk-chain"
```

The script uses `--cluster-type development` so Agave does not populate the
chain with the historical 500 million SOL genesis stake allocation. It installs
the standard core and SPL programs, including Token-2022, and preloads the
inference executable at program ID
`BkWuzU3fn4NS7LXdBxH1j4gRyRw3ma35aNGytbANzUvB`. The measured Qwen3-8B
export is 4,224,531,264 bytes (3.934401 GiB). Its weights are uploaded as
separate accounts after the chain produces blocks; they are not
part of the genesis archive. Agave's `--enable-warmup-epochs` accelerates the
initial validator stake activation.
Development genesis activates the registered features, including transaction
v1 and direct account data mapping, except Alpenglow. The chain starts with
Agave's default inflation policy; the genesis allocation is not a permanent
fixed supply cap.

## Start the bootstrap validator

Use the same `target/release/agave-validator` built above. The first startup of
an empty ledger needs the initial leader wait override used by Agave's
multinode demo. Review networking and firewall configuration before exposing
RPC publicly.

```bash
"$HOME/agave-crekk/target/release/agave-validator" \
  --ledger "$HOME/crekk-chain/ledger" \
  --identity "$HOME/crekk-chain/keys/identity.json" \
  --vote-account "$("$HOME/agave-crekk/target/release/solana-keygen" pubkey "$HOME/crekk-chain/keys/vote.json")" \
  --bind-address 0.0.0.0 \
  --rpc-bind-address 0.0.0.0 --rpc-port 8899 \
  --gossip-port 8001 --dynamic-port-range 8002-8040 \
  --full-rpc-api \
  --snapshot-interval-slots 10000 --no-incremental-snapshots \
  --no-wait-for-vote-to-start-leader \
  --no-xdp \
  --log "$HOME/crekk-chain/validator.log"
```

On Ubuntu, ensure `net.core.rmem_max` and `net.core.wmem_max` are at least
`134217728` before startup; the validator's network limit check otherwise
refuses to start. Its QUIC TPU binds UDP port 8003 in this configuration.

Check the network's distinct genesis hash, health, and advancing slots:

```bash
"$HOME/agave-crekk/target/release/solana" --url http://127.0.0.1:8899 genesis-hash
"$HOME/agave-crekk/target/release/solana" --url http://127.0.0.1:8899 block-height
"$HOME/agave-crekk/target/release/solana" --url http://127.0.0.1:8899 supply
```

## Create the model mint from the local signing machine

The `*chat` vanity keypair remains in the local `~/stacc-mint` directory. The
local `agent-sol.json` keypair controls the treasury pubkey
funded at genesis. Set `RPC_URL` to the new chain's reachable RPC and check
that the genesis hash differs from Solana mainnet before sending anything.

```bash
MINT_KEYPAIR="$HOME/stacc-mint/DxNXApfiPXYcobrM3NsePAXMDYyaPgB8jfK4yc9ichat.json"
TREASURY_KEYPAIR="$HOME/stacc-mint/agent-sol.json"
RPC_URL=http://<validator-address>:8899
solana-keygen pubkey "$MINT_KEYPAIR"       # must end in chat
solana --url "$RPC_URL" genesis-hash
solana --url "$RPC_URL" balance D88qwUFs75jLzVD9noGp8nyPEw4yqqvco3oMrRote2wa
spl-token --url "$RPC_URL" --fee-payer "$TREASURY_KEYPAIR" \
  --program-2022 create-token --decimals 6 --enable-metadata \
  --mint-authority D88qwUFs75jLzVD9noGp8nyPEw4yqqvco3oMrRote2wa \
  "$MINT_KEYPAIR"
spl-token --url "$RPC_URL" --fee-payer "$TREASURY_KEYPAIR" \
  --program-2022 initialize-metadata "$(solana-keygen pubkey "$MINT_KEYPAIR")" \
  '<model-token-name>' '<symbol>' '<metadata-URI>' \
  --mint-authority "$TREASURY_KEYPAIR" \
  --update-authority D88qwUFs75jLzVD9noGp8nyPEw4yqqvco3oMrRote2wa
```

The same mint keypair can then be used to create a separate Token-2022 mint at
the same address on Solana mainnet, provided that address is still unoccupied.
Each chain has independent token supply and balances. Confirm the desired
supply, distribution, and authority policy before minting or disabling mint
authority on either network.
