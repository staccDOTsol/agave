//! Assemble the [`GenesisConfig`].
//!
//! This is the orchestration layer: it pulls together the bootstrap accounts, the
//! treasury PDA, the lazy-claim Config singleton, the program registrations, and the
//! feature gate accounts, then writes them all into a single
//! [`solana_genesis_config::GenesisConfig`] with the right top-level economic policy
//! (fee governor, inflation, cluster type).
//!
//! Pure function modulo the `.so` filesystem reads pulled in via
//! [`crate::programs::build_program_pair_from_path`]. The resulting `GenesisConfig` is
//! ready for `GenesisConfig::write` (or `bincode::serialize_into`) — see [`crate::emit`].

use anyhow::{Context, Result};
use solana_cluster_type::ClusterType;
use solana_fee_calculator::FeeRateGovernor;
use solana_genesis_config::GenesisConfig;
use solana_inflation::Inflation;
use solana_pubkey::Pubkey;

use staccana_genesis::FeeRateGovernor as ComposedFeeGovernor;

use crate::accounts::{
    bootstrap_identity_account, bootstrap_stake_account, bootstrap_vote_account, faucet_account,
    lazy_claim_config_account, treasury_account,
};
use crate::features::build_all_feature_accounts;
use crate::programs::{
    build_program_pair_from_path, canonical_slots, zk_elgamal_proof_native_processor, ProgramPair,
};
use crate::BakeInputs;

/// Summary of what the bake injected. Used for the CLI's stdout report and the
/// integration tests' assertions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BakeSummary {
    pub bootstrap_pubkeys: BootstrapPubkeys,
    pub treasury_pda: Pubkey,
    pub treasury_lamports: u64,
    pub lazy_claim_config_pda: Pubkey,
    pub claimable_root_hex: String,
    pub claimable_count: u64,
    pub programs_installed: Vec<ProgramSummary>,
    pub feature_gates_activated: Vec<Pubkey>,
    pub native_programs_installed: Vec<(String, Pubkey)>,
    pub total_accounts: usize,
    pub total_lamports: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootstrapPubkeys {
    pub identity: Pubkey,
    pub vote: Pubkey,
    pub stake: Pubkey,
    pub faucet: Pubkey,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgramSummary {
    pub name: &'static str,
    pub program_id: Pubkey,
    pub program_data_address: Pubkey,
    pub elf_bytes: usize,
}

/// Assemble the [`GenesisConfig`] from the loaded inputs.
///
/// Step-by-step:
///
/// 1. Convert the composed-genesis [`ComposedFeeGovernor`] mirror into the real
///    [`solana_fee_calculator::FeeRateGovernor`] — same field names, just different
///    type universe.
/// 2. Pick `Inflation::new_disabled()` since `composed.inflation_disabled` is always
///    `true` for staccana v2 (we still validate it as a guard against accidentally
///    booting an inflationary chain).
/// 3. Construct an empty `GenesisConfig` with cluster type `MainnetBeta`, then mutate
///    in the bootstrap accounts, treasury, lazy-claim config, programs, and features.
/// 4. Register `solana_zk_elgamal_proof_program` as a native instruction processor —
///    the runtime needs this to dispatch the ZK proof program calls that CTE uses.
/// 5. Build the [`BakeSummary`] alongside.
pub fn assemble_genesis_config(inputs: &BakeInputs) -> Result<(GenesisConfig, BakeSummary)> {
    if !inputs.composed.inflation_disabled {
        anyhow::bail!(
            "ComposedGenesis.inflation_disabled = false; staccana v2 requires inflation off"
        );
    }

    let fee_rate_governor = convert_fee_governor(&inputs.composed.fee_governor);
    let inflation = Inflation::new_disabled();

    let mut config = GenesisConfig {
        fee_rate_governor,
        inflation,
        cluster_type: ClusterType::MainnetBeta,
        ..GenesisConfig::default()
    };

    // ---- Bootstrap accounts ----
    let identity_pk = inputs.identity_pubkey();
    let vote_pk = inputs.vote_pubkey();
    let stake_pk = inputs.stake_pubkey();
    let faucet_pk = inputs.faucet_pubkey();

    let (k, a) = bootstrap_identity_account(identity_pk);
    config.add_account(k, a);
    let (k, a) = bootstrap_vote_account(vote_pk);
    config.add_account(k, a);
    let (k, a) = bootstrap_stake_account(stake_pk);
    config.add_account(k, a);
    let (k, a) = faucet_account(faucet_pk);
    config.add_account(k, a);

    // ---- Treasury PDA ----
    let treasury_lamports = inputs.composed.treasury_pda_lamports;
    let (treasury_pda, treasury_acct) = treasury_account(treasury_lamports);
    config.add_account(treasury_pda, treasury_acct);

    // ---- Lazy-claim Config singleton ----
    let claimable_root = inputs.composed.lazy_claim_account.claimable_root;
    let (lc_config_pda, lc_config_acct) = lazy_claim_config_account(claimable_root);
    config.add_account(lc_config_pda, lc_config_acct);

    // ---- Programs (BPF builtins via upgradeable loader) ----
    let slots = canonical_slots(
        inputs.lazy_claim_so.as_deref(),
        inputs.bridge_so.as_deref(),
        inputs.secret_pump_so.as_deref(),
        inputs.validator_subsidy_so.as_deref(),
        inputs.megadrop_so.as_deref(),
    );
    let mut programs_installed = Vec::with_capacity(5);
    for slot in slots.iter() {
        let Some(path) = slot.so_path else {
            // Operator chose to skip this program — chain still boots; that program
            // can be deployed post-boot via `solana program deploy`. Logged in
            // BakeSummary by absence.
            continue;
        };
        let pair: ProgramPair = build_program_pair_from_path(slot.program_id, path)
            .with_context(|| format!("building Program/ProgramData pair for {}", slot.name))?;
        programs_installed.push(ProgramSummary {
            name: slot.name,
            program_id: pair.program_id,
            program_data_address: pair.program_data_address,
            elf_bytes: pair.elf_bytes,
        });
        config.add_account(pair.program_id, pair.program_account);
        config.add_account(pair.program_data_address, pair.program_data_account);
    }

    // ---- ZK ElGamal Proof native program (CTE prerequisite) ----
    let (native_name, native_id) = zk_elgamal_proof_native_processor();
    config.add_native_instruction_processor(native_name.clone(), native_id);
    let native_programs_installed = vec![(native_name, native_id)];

    // ---- Feature gates ----
    let feature_accounts =
        build_all_feature_accounts(&inputs.composed.active_feature_gates)
            .context("building CTE feature accounts")?;
    let mut feature_gates_activated = Vec::with_capacity(feature_accounts.len());
    for (k, a) in feature_accounts {
        feature_gates_activated.push(k);
        config.add_account(k, a);
    }

    // ---- Tallies ----
    let total_accounts = config.accounts.len();
    let total_lamports: u64 = config.accounts.values().map(|a| a.lamports).sum();
    let claimable_root_hex = bytes_to_hex(&claimable_root);

    let summary = BakeSummary {
        bootstrap_pubkeys: BootstrapPubkeys {
            identity: identity_pk,
            vote: vote_pk,
            stake: stake_pk,
            faucet: faucet_pk,
        },
        treasury_pda,
        treasury_lamports,
        lazy_claim_config_pda: lc_config_pda,
        claimable_root_hex,
        claimable_count: inputs.composed.claimable_count,
        programs_installed,
        feature_gates_activated,
        native_programs_installed,
        total_accounts,
        total_lamports,
    };

    Ok((config, summary))
}

/// Convert the `staccana-genesis` mirror of `FeeRateGovernor` (which avoids the heavy
/// `solana-fee-calculator` dep) into the real `solana_fee_calculator::FeeRateGovernor`.
/// Same field names, byte-equivalent semantics.
fn convert_fee_governor(g: &ComposedFeeGovernor) -> FeeRateGovernor {
    FeeRateGovernor {
        // The real type carries `lamports_per_signature` (current observed rate); we
        // pin it equal to the target for the fixed-fee model. This matches what
        // `FeeRateGovernor::new(target, signatures_per_slot=0)` would produce.
        lamports_per_signature: g.target_lamports_per_signature,
        target_lamports_per_signature: g.target_lamports_per_signature,
        target_signatures_per_slot: g.target_signatures_per_slot,
        min_lamports_per_signature: g.min_lamports_per_signature,
        max_lamports_per_signature: g.max_lamports_per_signature,
        burn_percent: g.burn_percent,
    }
}

/// Hex-encode a 32-byte hash for human-readable display in logs / the bake summary.
/// Avoids pulling in `hex` as a dep — we only need it for the summary log.
fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_keypair::Keypair;
    use solana_signer::Signer;
    use staccana_genesis_emit::{ActiveFeatureGate, ComposedGenesis, LazyClaimGenesisAccount};
    use staccana_genesis::{
        ClassicDefaults, MerkleRoot, CTE_FEATURE_GATES_AT_GENESIS,
    };
    use solana_program::hash::Hash;

    fn synthetic_composed() -> ComposedGenesis {
        ComposedGenesis {
            fee_governor: ClassicDefaults::fee_rate_governor(),
            inflation_disabled: true,
            active_feature_gates: CTE_FEATURE_GATES_AT_GENESIS
                .iter()
                .map(|(pk, desc)| ActiveFeatureGate {
                    pubkey_b58: (*pk).to_string(),
                    description: (*desc).to_string(),
                })
                .collect(),
            treasury_pda_lamports: 485_192_075_139_020_370,
            treasury_account_count: 12_345,
            lazy_claim_account: LazyClaimGenesisAccount::from_root(MerkleRoot(
                Hash::new_from_array([0xAB; 32]),
            )),
            claimable_count: 99_999,
            bank_hash_seed: "STACCANA_GENESIS_V1".to_string(),
        }
    }

    fn synthetic_inputs() -> BakeInputs {
        BakeInputs {
            composed: synthetic_composed(),
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
    fn assemble_with_no_so_paths_still_builds_valid_genesis() {
        let inputs = synthetic_inputs();
        let (config, summary) = assemble_genesis_config(&inputs).expect("assemble");

        // ClusterType is staccana mainnet-beta.
        assert_eq!(config.cluster_type, ClusterType::MainnetBeta);
        // Inflation off.
        assert_eq!(config.inflation.initial, 0.0);
        assert_eq!(config.inflation.terminal, 0.0);
        // Fee governor pinned at 0.027 SOL.
        assert_eq!(config.fee_rate_governor.target_lamports_per_signature, 27_000_000);
        assert_eq!(config.fee_rate_governor.burn_percent, 50);

        // Bootstrap pubkeys round-trip into the summary.
        assert_eq!(summary.bootstrap_pubkeys.identity, inputs.identity.pubkey());
        assert_eq!(summary.bootstrap_pubkeys.vote, inputs.vote.pubkey());
        assert_eq!(summary.bootstrap_pubkeys.stake, inputs.stake.pubkey());
        assert_eq!(summary.bootstrap_pubkeys.faucet, inputs.faucet.pubkey());

        // Treasury lamports propagated.
        assert_eq!(summary.treasury_lamports, 485_192_075_139_020_370);
        // claimable_count propagated.
        assert_eq!(summary.claimable_count, 99_999);
        // Without .so paths, no BPF programs are installed (just the ZK ElGamal
        // native processor).
        assert!(summary.programs_installed.is_empty());
        assert_eq!(summary.native_programs_installed.len(), 1);
        // Four CTE gates flipped on.
        assert_eq!(summary.feature_gates_activated.len(), 4);
        // Account total: 4 bootstrap + treasury + lazy-claim config + 4 features = 10.
        assert_eq!(summary.total_accounts, 10);
        // Total lamports: 4*1SOL + treasury + LC rent + 4*feature rent.
        assert!(summary.total_lamports >= 485_192_075_139_020_370);
    }

    #[test]
    fn assemble_rejects_inflation_enabled() {
        let mut inputs = synthetic_inputs();
        inputs.composed.inflation_disabled = false;
        let err = assemble_genesis_config(&inputs).unwrap_err();
        assert!(format!("{err:#}").contains("inflation"));
    }

    #[test]
    fn assemble_with_lazy_claim_so_installs_bpf_program() {
        // Write a synthetic ELF and confirm it gets registered as a Program +
        // ProgramData pair at the lazy-claim program ID.
        let dir = tempfile::tempdir().expect("tempdir");
        let lc_path = dir.path().join("staccana_lazy_claim.so");
        std::fs::write(&lc_path, vec![0xAA; 256]).expect("write");

        let mut inputs = synthetic_inputs();
        inputs.lazy_claim_so = Some(lc_path);

        let (config, summary) = assemble_genesis_config(&inputs).expect("assemble");

        assert_eq!(summary.programs_installed.len(), 1);
        let p = &summary.programs_installed[0];
        assert_eq!(p.name, "staccana_lazy_claim");
        assert_eq!(p.program_id, crate::pdas::LAZY_CLAIM_PROGRAM_ID);
        assert_eq!(p.elf_bytes, 256);

        // Both Program and ProgramData accounts were inserted.
        assert!(config.accounts.contains_key(&p.program_id));
        assert!(config.accounts.contains_key(&p.program_data_address));
    }

    #[test]
    fn assemble_with_all_five_so_paths_installs_all_five() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut inputs = synthetic_inputs();
        for (slot, byte) in [
            ("staccana_lazy_claim.so", 0x01),
            ("staccana_bridge.so", 0x02),
            ("staccana_secret_pump.so", 0x03),
            ("staccana_validator_subsidy.so", 0x04),
            ("staccana_megadrop.so", 0x05),
        ] {
            let p = dir.path().join(slot);
            std::fs::write(&p, vec![byte; 64]).expect("write");
            match slot {
                "staccana_lazy_claim.so" => inputs.lazy_claim_so = Some(p),
                "staccana_bridge.so" => inputs.bridge_so = Some(p),
                "staccana_secret_pump.so" => inputs.secret_pump_so = Some(p),
                "staccana_validator_subsidy.so" => inputs.validator_subsidy_so = Some(p),
                "staccana_megadrop.so" => inputs.megadrop_so = Some(p),
                _ => unreachable!(),
            }
        }

        let (_, summary) = assemble_genesis_config(&inputs).expect("assemble");
        assert_eq!(summary.programs_installed.len(), 5);
        let names: Vec<&str> = summary.programs_installed.iter().map(|p| p.name).collect();
        assert_eq!(
            names,
            vec![
                "staccana_lazy_claim",
                "staccana_bridge",
                "staccana_secret_pump",
                "staccana_validator_subsidy",
                "staccana_megadrop",
            ]
        );
    }

    #[test]
    fn assemble_includes_zk_elgamal_proof_native_processor() {
        let inputs = synthetic_inputs();
        let (config, summary) = assemble_genesis_config(&inputs).expect("assemble");

        // The native processor entry must be present under both the GenesisConfig and
        // the bake summary.
        assert_eq!(config.native_instruction_processors.len(), 1);
        assert_eq!(config.native_instruction_processors[0].0, "solana_zk_elgamal_proof_program");
        assert_eq!(summary.native_programs_installed.len(), 1);
    }

    #[test]
    fn assemble_treasury_pda_lamports_match_composed_input() {
        let inputs = synthetic_inputs();
        let (config, summary) = assemble_genesis_config(&inputs).expect("assemble");
        let treasury_acct = config
            .accounts
            .get(&summary.treasury_pda)
            .expect("treasury PDA must be in accounts map");
        assert_eq!(treasury_acct.lamports, 485_192_075_139_020_370);
    }

    #[test]
    fn assemble_lazy_claim_config_carries_correct_root() {
        let inputs = synthetic_inputs();
        let (config, summary) = assemble_genesis_config(&inputs).expect("assemble");
        let lc_acct = config
            .accounts
            .get(&summary.lazy_claim_config_pda)
            .expect("lazy-claim config must be in accounts map");
        // Decode via the on-chain unpack to prove byte compatibility.
        let cfg = staccana_lazy_claim::state::LazyClaimConfig::unpack(&lc_acct.data).unwrap();
        assert_eq!(cfg.claimable_root.to_bytes(), [0xAB; 32]);
    }

    #[test]
    fn convert_fee_governor_preserves_pin() {
        let g = ClassicDefaults::fee_rate_governor();
        let real = convert_fee_governor(&g);
        // Min == max == target == 27,000,000.
        assert_eq!(real.min_lamports_per_signature, 27_000_000);
        assert_eq!(real.max_lamports_per_signature, 27_000_000);
        assert_eq!(real.target_lamports_per_signature, 27_000_000);
        assert_eq!(real.target_signatures_per_slot, 0);
        assert_eq!(real.burn_percent, 50);
    }

    #[test]
    fn bytes_to_hex_encodes_known_value() {
        // Lowercase, padded to 2 chars per byte, no separators.
        assert_eq!(
            bytes_to_hex(&[0x00, 0x0A, 0xFF, 0xFE, 0x12, 0x34, 0x56, 0x78]),
            "000afffe12345678"
        );
    }

    #[test]
    fn bytes_to_hex_round_trip_length() {
        // Every byte produces exactly two hex chars, regardless of value.
        let bytes = [0u8; 32];
        assert_eq!(bytes_to_hex(&bytes).len(), 64);
        let bytes = [0xFFu8; 32];
        assert_eq!(bytes_to_hex(&bytes).len(), 64);
    }

    #[test]
    fn assemble_total_accounts_matches_independent_count() {
        // 4 bootstrap + treasury + lazy-claim config + 4 features = 10 (no programs).
        let inputs = synthetic_inputs();
        let (_, summary) = assemble_genesis_config(&inputs).expect("assemble");
        assert_eq!(summary.total_accounts, 10);
    }

    #[test]
    fn assemble_with_two_programs_yields_total_accounts_eq_baseline_plus_four() {
        // Each program installation adds 2 accounts (Program + ProgramData), so
        // 2 programs ⇒ +4 accounts vs the no-programs baseline of 10.
        let dir = tempfile::tempdir().expect("tempdir");
        let lc = dir.path().join("lc.so");
        std::fs::write(&lc, vec![1u8; 16]).unwrap();
        let br = dir.path().join("br.so");
        std::fs::write(&br, vec![2u8; 16]).unwrap();

        let mut inputs = synthetic_inputs();
        inputs.lazy_claim_so = Some(lc);
        inputs.bridge_so = Some(br);
        let (_, summary) = assemble_genesis_config(&inputs).expect("assemble");
        assert_eq!(summary.total_accounts, 10 + 4);
        assert_eq!(summary.programs_installed.len(), 2);
    }
}
