//! Binary entrypoint for the staccana federation-attestor daemon.
//!
//! Intentionally thin: parse CLI args, load config, kick off the daemon loop. All
//! testable logic lives in the library (`lib.rs` and the modules it re-exports).
//!
//! ## CLI
//!
//! ```text
//! staccana-federation-attestor --config /etc/staccana/attestor.toml
//! ```
//!
//! ## Daemon loop (v0)
//!
//! 1. Load + validate config.
//! 2. Load the member's signing keypair from disk.
//! 3. Spawn an [`Observer`] (v0: stub — returns no events).
//! 4. Loop forever:
//!    - Tick every `R_PUBLISH_INTERVAL_SLOTS / 2` (target: ~30s) so we comfortably hit
//!      the on-chain spacing requirement.
//!    - Drain any pending deposit / burn events.
//!    - When an event lands, build the attestation, sign locally, and (v1) gossip to
//!      peers.
//!    - When local + peer signatures hit M, aggregate and publish via
//!      [`publish_attestation`].
//!
//! v0 only exercises the timer + sign-locally path; observer + peer gossip + actual RPC
//! publish are stubbed (each module documents what real impl needs).

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::Parser;

use staccana_federation_attestor::{
    config::AttestorConfig,
    observer::{Observer, StubObserver},
};

/// `R_PUBLISH_INTERVAL_SLOTS` from SPEC §2.3 = 150 slots × ~400ms = ~60s. The daemon ticks
/// at half that interval so it never misses a publication window because of clock drift.
const TICK: Duration = Duration::from_secs(30);

#[derive(Parser, Debug)]
#[command(
    name = "staccana-federation-attestor",
    about = "Federation member daemon: signs ratio attestations and publishes R updates per SPEC §5.3.",
    version
)]
struct Cli {
    /// Path to the TOML config file.
    #[arg(long, short)]
    config: PathBuf,

    /// Run a single tick and exit. Useful for systemd OneShot health checks.
    #[arg(long, default_value_t = false)]
    once: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    let cfg = AttestorConfig::load_and_validate(&cli.config)
        .with_context(|| format!("loading config from {:?}", cli.config))?;
    eprintln!(
        "[federation-attestor] loaded config for member_index={} (set size {}, peers {})",
        cfg.member_index,
        cfg.federation_pubkeys.len(),
        cfg.peers.len()
    );

    let _keypair = cfg
        .load_keypair()
        .with_context(|| format!("loading signing keypair from {:?}", cfg.member_key_path))?;

    let mut observer = StubObserver::new();

    loop {
        // Drain whatever the observer has — v0 always returns Ok(None).
        match observer.poll_deposit() {
            Ok(Some(d)) => {
                eprintln!("[federation-attestor] saw mainnet deposit: {d:?}");
                // TODO(v1): construct attestation inputs (vault_value + mint_supply at
                // d.slot), sign, gossip, when M sigs gathered → aggregate + publish.
            }
            Ok(None) => {}
            Err(e) => eprintln!("[federation-attestor] deposit poll error: {e}"),
        }

        match observer.poll_burn() {
            Ok(Some(b)) => {
                eprintln!("[federation-attestor] saw staccana burn: {b:?}");
                // TODO(v1): same shape as deposit — emit attestation for the post-burn
                // mint_supply / vault_value tuple.
            }
            Ok(None) => {}
            Err(e) => eprintln!("[federation-attestor] burn poll error: {e}"),
        }

        if cli.once {
            eprintln!("[federation-attestor] --once set, exiting after one tick");
            return Ok(());
        }
        tokio::time::sleep(TICK).await;
    }
}
