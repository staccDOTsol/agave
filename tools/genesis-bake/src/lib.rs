//! `staccana-genesis-bake` — bake the real `genesis.bin` for staccana mainnet-sigma.
//!
//! ## What this crate replaces
//!
//! Vanilla `solana-genesis` produces a working ledger with system + faucet + bootstrap
//! validator accounts and not much else (ours weighs in at ~3.22 SOL / 212 accounts —
//! enough to boot, nowhere near enough to *be* staccana). This crate consumes the
//! `ComposedGenesis` JSON written by `tools/genesis-emit/` (step 20 of the deploy
//! pipeline) and produces a `genesis.bin` with everything pre-installed at slot 0:
//!
//! - The bootstrap validator + vote + stake + faucet accounts (1 SOL each, same as
//!   vanilla).
//! - The **treasury PDA** at `["treasury"] / VALIDATOR_SUBSIDY_PROGRAM_ID`, pre-credited
//!   with the 485M-SOL figure from the composed genesis. Owner: validator-subsidy
//!   program — so the validator-subsidy CPIs that debit it can sign.
//! - The **lazy-claim Config account** at `["config"] / LAZY_CLAIM_PROGRAM_ID`, owned by
//!   the lazy-claim program, carrying the embedded Merkle root. The on-chain claim
//!   handler reads its `claimable_root` directly from this account at runtime.
//! - The **five staccana programs** (lazy-claim, bridge, secret-pump,
//!   validator-subsidy, megadrop) registered as upgradeable BPF programs at their
//!   well-known program IDs. The `.so` byte payloads are read from disk paths supplied
//!   on the command line.
//! - The **four CTE feature gates** (the ZK ElGamal Proof set from
//!   `staccana_genesis::CTE_FEATURE_GATES_AT_GENESIS`) flipped on at slot 0 — these are
//!   the gates Token-22 Confidential Transfer Extension needs but that mainnet hasn't
//!   activated yet. Combined with the `solana_zk_elgamal_proof_program` builtin (also
//!   wired here) this is what gives staccana confidential transfers from the moment
//!   the chain boots.
//! - The classic-v1 **fixed-fee governor** (0.027 SOL, 50% burn) and **disabled
//!   inflation**, both inherited from `ComposedGenesis`.
//! - **Cluster type** = `MainnetBeta` (staccana's mainnet, not a devnet).
//!
//! ## Module layout
//!
//! - [`config`] — assembles the [`solana_genesis_config::GenesisConfig`] from a
//!   [`BakeInputs`] bundle. Pure function.
//! - [`accounts`] — the bootstrap-validator / vote / stake / faucet / treasury PDA /
//!   lazy-claim Config account constructors. Each is independently unit-tested.
//! - [`programs`] — reads `.so` files and lays them out as `bpf_loader_upgradeable`
//!   `Program` + `ProgramData` account pairs at the well-known program IDs.
//! - [`features`] — turns each entry of `CTE_FEATURE_GATES_AT_GENESIS` into a
//!   `Feature { activated_at: Some(0) }` account at the gate's pubkey.
//! - [`emit`] — serializes the assembled `GenesisConfig` to `genesis.bin` and surfaces
//!   the resulting genesis hash + capitalization summary.
//! - [`pdas`] — well-known PDA + program-ID constants (treasury, lazy-claim config,
//!   the five program IDs). All match what the on-chain programs actually expect, so
//!   the genesis-side derivations and the program-side derivations agree.
//!
//! ## Pipeline
//!
//! ```text
//!     composed-genesis.json (step 20)         identity/vote/stake/faucet keypairs
//!                  │                                          │
//!                  ▼                                          ▼
//!              load_composed                              load_keypairs
//!                  │                                          │
//!                  └──────────────────┬──────────────────────┘
//!                                     ▼
//!                                bake(BakeInputs)
//!                                     │
//!                                     ▼
//!                          GenesisConfig (in memory)
//!                                     │
//!                                     ▼
//!                              emit::write_bin
//!                                     │
//!                                     ▼
//!                                genesis.bin (step 30)
//! ```

pub mod accounts;
pub mod config;
pub mod emit;
pub mod features;
pub mod pdas;
pub mod programs;

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use solana_genesis_config::GenesisConfig;
use solana_keypair::{read_keypair_file, Keypair};
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use staccana_genesis_emit::ComposedGenesis;

pub use config::{assemble_genesis_config, BakeSummary};
pub use pdas::{
    lazy_claim_config_pda, treasury_pda, BRIDGE_PROGRAM_ID, LAZY_CLAIM_PROGRAM_ID,
    LAZY_CLAIM_CONFIG_SEED, MEGADROP_PROGRAM_ID, SECRET_PUMP_PROGRAM_ID, TREASURY_SEED,
    VALIDATOR_SUBSIDY_PROGRAM_ID,
};

/// Default lamport allocation for each of the bootstrap-validator-related accounts
/// (identity, vote, stake, faucet). Matches the value `infra/scripts/30-init-validator.sh`
/// passed to vanilla `solana-genesis` (`--bootstrap-validator-lamports 1000000000`).
pub const BOOTSTRAP_LAMPORTS: u64 = 1_000_000_000;

/// All inputs required to bake the genesis. Assembled by [`load_inputs_from_paths`] (or
/// constructed by hand in tests).
///
/// `.so` paths are optional. For the mainnet-sigma launch night every program should be
/// supplied; in dev / staging it's useful to skip programs whose binary hasn't been
/// built yet — the chain still boots, those programs just need a post-boot
/// `solana program deploy` to materialize.
pub struct BakeInputs {
    pub composed: ComposedGenesis,
    pub identity: Keypair,
    pub vote: Keypair,
    pub stake: Keypair,
    pub faucet: Keypair,
    pub lazy_claim_so: Option<PathBuf>,
    pub bridge_so: Option<PathBuf>,
    pub secret_pump_so: Option<PathBuf>,
    pub validator_subsidy_so: Option<PathBuf>,
    pub megadrop_so: Option<PathBuf>,
}

impl BakeInputs {
    /// Convenience accessor — pubkey of the bootstrap-validator identity account.
    pub fn identity_pubkey(&self) -> Pubkey {
        self.identity.pubkey()
    }
    /// Convenience accessor — pubkey of the vote account.
    pub fn vote_pubkey(&self) -> Pubkey {
        self.vote.pubkey()
    }
    /// Convenience accessor — pubkey of the stake account.
    pub fn stake_pubkey(&self) -> Pubkey {
        self.stake.pubkey()
    }
    /// Convenience accessor — pubkey of the faucet account.
    pub fn faucet_pubkey(&self) -> Pubkey {
        self.faucet.pubkey()
    }
}

/// Read the `ComposedGenesis` JSON written by `staccana-genesis-emit`. Same on-disk
/// format the existing CLI produces — plain serde-json.
pub fn load_composed_genesis(path: impl AsRef<Path>) -> Result<ComposedGenesis> {
    let path = path.as_ref();
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("reading composed genesis from {}", path.display()))?;
    serde_json::from_str(&raw)
        .with_context(|| format!("parsing composed genesis JSON at {}", path.display()))
}

/// Read a single keypair file in the standard `solana-keygen` JSON format
/// (`[byte, byte, byte, ...]` of the secret-key concatenated with the pubkey, 64 bytes
/// total).
pub fn load_keypair(path: impl AsRef<Path>) -> Result<Keypair> {
    let path = path.as_ref();
    read_keypair_file(path).map_err(|e| {
        anyhow::anyhow!("reading keypair from {}: {}", path.display(), e)
    })
}

/// Load every input from disk. Wraps [`load_composed_genesis`] + four
/// [`load_keypair`] calls + path passthroughs.
#[allow(clippy::too_many_arguments)]
pub fn load_inputs_from_paths(
    composed: impl AsRef<Path>,
    identity: impl AsRef<Path>,
    vote: impl AsRef<Path>,
    stake: impl AsRef<Path>,
    faucet: impl AsRef<Path>,
    lazy_claim_so: Option<PathBuf>,
    bridge_so: Option<PathBuf>,
    secret_pump_so: Option<PathBuf>,
    validator_subsidy_so: Option<PathBuf>,
    megadrop_so: Option<PathBuf>,
) -> Result<BakeInputs> {
    Ok(BakeInputs {
        composed: load_composed_genesis(composed)?,
        identity: load_keypair(identity)?,
        vote: load_keypair(vote)?,
        stake: load_keypair(stake)?,
        faucet: load_keypair(faucet)?,
        lazy_claim_so,
        bridge_so,
        secret_pump_so,
        validator_subsidy_so,
        megadrop_so,
    })
}

/// End-to-end entrypoint. Takes the loaded inputs, builds a [`GenesisConfig`], and
/// returns it together with a [`BakeSummary`] of what got injected (used for the CLI's
/// stdout report).
///
/// Pure function modulo `.so` file reads — the on-disk write happens in [`emit`].
pub fn bake(inputs: &BakeInputs) -> Result<(GenesisConfig, BakeSummary)> {
    config::assemble_genesis_config(inputs)
}
