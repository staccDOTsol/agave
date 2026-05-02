//! `staccana-genesis-bake` CLI binary.
//!
//! Drives the library: reads a `composed-genesis.json`, the four bootstrap keypairs,
//! and (optionally) up to five program `.so` paths, then writes a real `genesis.bin`
//! at the requested output path. See the crate's `lib.rs` doc comment for the
//! end-to-end pipeline.
//!
//! Usage:
//!
//! ```text
//! staccana-genesis-bake \
//!   --composed-genesis /var/lib/staccana/genesis/composed-genesis.json \
//!   --identity-keypair /etc/staccana/keys/identity.json \
//!   --vote-keypair    /etc/staccana/keys/vote.json \
//!   --stake-keypair   /etc/staccana/keys/stake.json \
//!   --faucet-keypair  /etc/staccana/keys/faucet.json \
//!   --lazy-claim-so          target/deploy/staccana_lazy_claim.so \
//!   --bridge-so              programs/bridge/target/deploy/staccana_bridge.so \
//!   --secret-pump-so         programs/secret-pump/target/deploy/staccana_secret_pump.so \
//!   --validator-subsidy-so   programs/validator-subsidy/target/deploy/staccana_validator_subsidy.so \
//!   --megadrop-so            programs/megadrop/target/deploy/staccana_megadrop.so \
//!   --output-genesis /var/lib/staccana/ledger/genesis.bin
//! ```

use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;

use staccana_genesis_bake::{
    bake, emit::log_bake_summary, emit::write_genesis_bin_at_path, load_inputs_from_paths,
};

#[derive(Parser, Debug)]
#[command(
    name = "staccana-genesis-bake",
    about = "Bake a real Solana genesis.bin for staccana from a ComposedGenesis JSON.",
    version
)]
struct Cli {
    /// Path to the `composed-genesis.json` written by `staccana-genesis-emit` (step
    /// 20 of the deploy pipeline).
    #[arg(long)]
    composed_genesis: PathBuf,

    /// Bootstrap validator identity keypair (standard `solana-keygen` JSON format).
    #[arg(long)]
    identity_keypair: PathBuf,

    /// Bootstrap validator vote keypair.
    #[arg(long)]
    vote_keypair: PathBuf,

    /// Bootstrap validator stake keypair.
    #[arg(long)]
    stake_keypair: PathBuf,

    /// Faucet keypair. Even though staccana doesn't run a faucet on mainnet, the
    /// keypair-and-account is generated and present at slot 0 to keep tooling that
    /// expects a faucet pubkey from crashing in dev.
    #[arg(long)]
    faucet_keypair: PathBuf,

    /// `.so` path for the lazy-claim program. If omitted the program is skipped (the
    /// chain still boots; lazy-claim must then be deployed post-boot via
    /// `solana program deploy`).
    #[arg(long)]
    lazy_claim_so: Option<PathBuf>,

    /// `.so` path for the bridge program. Optional — see `--lazy-claim-so` for the
    /// "skipped" semantics.
    #[arg(long)]
    bridge_so: Option<PathBuf>,

    /// `.so` path for the secret-pump program. Optional.
    #[arg(long)]
    secret_pump_so: Option<PathBuf>,

    /// `.so` path for the validator-subsidy program. Optional.
    #[arg(long)]
    validator_subsidy_so: Option<PathBuf>,

    /// `.so` path for the megadrop program. Optional.
    #[arg(long)]
    megadrop_so: Option<PathBuf>,

    /// Output path for `genesis.bin`. Parent directory is created if it does not
    /// exist.
    #[arg(long)]
    output_genesis: PathBuf,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    let inputs = load_inputs_from_paths(
        &cli.composed_genesis,
        &cli.identity_keypair,
        &cli.vote_keypair,
        &cli.stake_keypair,
        &cli.faucet_keypair,
        cli.lazy_claim_so,
        cli.bridge_so,
        cli.secret_pump_so,
        cli.validator_subsidy_so,
        cli.megadrop_so,
    )?;

    let (config, summary) = bake(&inputs)?;
    let hash = write_genesis_bin_at_path(&config, &cli.output_genesis)?;
    log_bake_summary(&summary, &hash);
    eprintln!("[bake] genesis.bin written:    {}", cli.output_genesis.display());

    Ok(())
}
