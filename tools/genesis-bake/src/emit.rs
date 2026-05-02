//! Serialize the assembled [`GenesisConfig`] to disk as `genesis.bin`.
//!
//! Two-mode emission:
//!
//! - [`write_genesis_to_ledger_dir`] — uses `GenesisConfig::write` from
//!   `solana-genesis-config`. Same on-disk format the agave validator boots from
//!   (bincode at `<ledger>/genesis.bin`). Preferred for production.
//! - [`write_genesis_bin_at_path`] — direct bincode emission at an explicit path,
//!   useful for tests and ad-hoc inspection. Bytes are identical to what `write`
//!   produces; the path is just chosen by the caller.
//!
//! Both modes also compute and return the genesis hash via `GenesisConfig::hash` —
//! the validator computes the same hash internally; matching it is the launch-day
//! gate.

use std::path::Path;

use anyhow::{Context, Result};
use solana_genesis_config::GenesisConfig;
use solana_hash::Hash;

use crate::BakeSummary;

/// Write the genesis to a ledger directory in the format the validator boots from.
///
/// `GenesisConfig::write(ledger_path)` creates `<ledger_path>/genesis.bin` (the
/// `DEFAULT_GENESIS_FILE` constant). Returns the genesis hash for logging /
/// post-bake verification.
pub fn write_genesis_to_ledger_dir(
    config: &GenesisConfig,
    ledger_dir: impl AsRef<Path>,
) -> Result<Hash> {
    let ledger_dir = ledger_dir.as_ref();
    config
        .write(ledger_dir)
        .with_context(|| format!("writing genesis.bin under {}", ledger_dir.display()))?;
    Ok(config.hash())
}

/// Write the genesis to a specific path (rather than `<dir>/genesis.bin`).
///
/// Useful when the caller has a precise output filename in mind. Internally serializes
/// via `bincode::serialize` — the byte format is identical to what
/// `GenesisConfig::write` produces.
pub fn write_genesis_bin_at_path(
    config: &GenesisConfig,
    output_path: impl AsRef<Path>,
) -> Result<Hash> {
    let path = output_path.as_ref();
    let bytes = bincode::serialize(config)
        .context("serializing GenesisConfig via bincode")?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating parent directory {}", parent.display()))?;
        }
    }
    std::fs::write(path, &bytes)
        .with_context(|| format!("writing genesis.bin to {}", path.display()))?;
    Ok(config.hash())
}

/// Pretty-print a [`BakeSummary`] to stderr in the same multi-line format the existing
/// staccana tools use. Caller decides whether to call this; the library doesn't
/// touch stdio on its own.
pub fn log_bake_summary(summary: &BakeSummary, genesis_hash: &Hash) {
    eprintln!("[bake] genesis hash:           {}", genesis_hash);
    eprintln!("[bake] cluster type:           MainnetBeta");
    eprintln!("[bake] bootstrap identity:     {}", summary.bootstrap_pubkeys.identity);
    eprintln!("[bake] bootstrap vote:         {}", summary.bootstrap_pubkeys.vote);
    eprintln!("[bake] bootstrap stake:        {}", summary.bootstrap_pubkeys.stake);
    eprintln!("[bake] faucet:                 {}", summary.bootstrap_pubkeys.faucet);
    eprintln!("[bake] treasury PDA:           {}", summary.treasury_pda);
    eprintln!(
        "[bake] treasury lamports:      {} ({:.4} SOL)",
        summary.treasury_lamports,
        summary.treasury_lamports as f64 / 1_000_000_000.0
    );
    eprintln!("[bake] lazy-claim config PDA:  {}", summary.lazy_claim_config_pda);
    eprintln!("[bake] claimable_root (hex):   0x{}", summary.claimable_root_hex);
    eprintln!("[bake] claimable count:        {}", summary.claimable_count);
    eprintln!("[bake] BPF programs installed: {}", summary.programs_installed.len());
    for p in &summary.programs_installed {
        eprintln!(
            "[bake]   - {} @ {} (data {} bytes)",
            p.name, p.program_id, p.elf_bytes
        );
    }
    eprintln!(
        "[bake] native processors:      {}",
        summary.native_programs_installed.len()
    );
    for (n, id) in &summary.native_programs_installed {
        eprintln!("[bake]   - {} @ {}", n, id);
    }
    eprintln!(
        "[bake] CTE feature gates ON:   {}",
        summary.feature_gates_activated.len()
    );
    for g in &summary.feature_gates_activated {
        eprintln!("[bake]   - {}", g);
    }
    eprintln!("[bake] total accounts:         {}", summary.total_accounts);
    eprintln!("[bake] total lamports:         {}", summary.total_lamports);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{bake, BakeInputs};
    use solana_keypair::Keypair;
    use staccana_genesis::{
        ClassicDefaults, MerkleRoot, CTE_FEATURE_GATES_AT_GENESIS,
    };
    use staccana_genesis_emit::{ActiveFeatureGate, ComposedGenesis, LazyClaimGenesisAccount};
    use solana_program::hash::Hash as ProgramHash;

    fn synthetic_inputs() -> BakeInputs {
        BakeInputs {
            composed: ComposedGenesis {
                fee_governor: ClassicDefaults::fee_rate_governor(),
                inflation_disabled: true,
                active_feature_gates: CTE_FEATURE_GATES_AT_GENESIS
                    .iter()
                    .map(|(pk, desc)| ActiveFeatureGate {
                        pubkey_b58: (*pk).to_string(),
                        description: (*desc).to_string(),
                    })
                    .collect(),
                treasury_pda_lamports: 1_000,
                treasury_account_count: 1,
                lazy_claim_account: LazyClaimGenesisAccount::from_root(MerkleRoot(
                    ProgramHash::new_from_array([0x42; 32]),
                )),
                claimable_count: 1,
                bank_hash_seed: "STACCANA_GENESIS_V1".to_string(),
            },
            identity: Keypair::new(),
            vote: Keypair::new(),
            stake: Keypair::new(),
            faucet: Keypair::new(),
            lazy_claim_so: None,
            bridge_so: None,
            secret_pump_so: None,
            validator_subsidy_so: None,
            megadrop_so: None,
        }
    }

    #[test]
    fn write_genesis_to_ledger_dir_creates_genesis_bin() {
        let dir = tempfile::tempdir().expect("tempdir");
        let inputs = synthetic_inputs();
        let (config, _summary) = bake(&inputs).expect("bake");
        let hash = write_genesis_to_ledger_dir(&config, dir.path()).expect("write");

        let bin = dir.path().join("genesis.bin");
        assert!(bin.exists(), "genesis.bin must exist at {}", bin.display());
        assert!(bin.metadata().unwrap().len() > 0, "genesis.bin must be non-empty");

        // Reload via GenesisConfig::load and confirm the round-tripped hash matches.
        let reloaded = GenesisConfig::load(dir.path()).expect("load");
        assert_eq!(reloaded.hash(), hash);
    }

    #[test]
    fn write_genesis_bin_at_path_writes_bytes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("custom").join("genesis.bin");
        let inputs = synthetic_inputs();
        let (config, _summary) = bake(&inputs).expect("bake");
        let hash = write_genesis_bin_at_path(&config, &path).expect("write");

        assert!(path.exists());
        let raw = std::fs::read(&path).expect("read");
        assert!(!raw.is_empty());
        // The hash returned must match what re-parsing the file produces.
        let reparsed: GenesisConfig =
            bincode::deserialize(&raw).expect("re-deserialize");
        assert_eq!(reparsed.hash(), hash);
    }

    #[test]
    fn genesis_hash_is_deterministic_for_same_inputs() {
        // Two bakes with the SAME composed input + SAME bootstrap pubkeys produce the
        // same genesis hash. We pin the keypairs by serializing/deserializing them
        // through bytes since `Keypair::new()` is random.
        let mut inputs1 = synthetic_inputs();
        let mut inputs2 = synthetic_inputs();

        // Override randoms with deterministic ones so the test isn't comparing apples
        // to oranges.
        let id_bytes = inputs1.identity.to_bytes();
        inputs2.identity = Keypair::try_from(&id_bytes[..]).unwrap();
        let v_bytes = inputs1.vote.to_bytes();
        inputs2.vote = Keypair::try_from(&v_bytes[..]).unwrap();
        let s_bytes = inputs1.stake.to_bytes();
        inputs2.stake = Keypair::try_from(&s_bytes[..]).unwrap();
        let f_bytes = inputs1.faucet.to_bytes();
        inputs2.faucet = Keypair::try_from(&f_bytes[..]).unwrap();

        // Pin creation_time too (it's set from system clock by default).
        let (mut c1, _) = bake(&inputs1).expect("bake1");
        let (mut c2, _) = bake(&inputs2).expect("bake2");
        c1.creation_time = 1_700_000_000;
        c2.creation_time = 1_700_000_000;

        // Hashes must agree.
        let h1 = c1.hash();
        let h2 = c2.hash();
        assert_eq!(h1, h2);

        // Distinct random data ⇒ distinct hashes (regression check on the
        // determinism wiring).
        inputs1.identity = Keypair::new();
        let (mut c3, _) = bake(&inputs1).expect("bake3");
        c3.creation_time = 1_700_000_000;
        assert_ne!(c1.hash(), c3.hash());

        // Suppress the unused vars warning.
        let _ = inputs2;
    }
}
