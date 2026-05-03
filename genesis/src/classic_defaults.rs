//! Solana Classic v1 genesis defaults — inherited unchanged into Staccana v2.
//!
//! Classic v1 made three economic-policy choices at genesis:
//!
//! 1. **Fixed transaction fee** of 0.027 SOL (= mainnet average arbitrage profit) for
//!    non-vote txs, 5,000 lamports for votes. In v1 this was the entire anti-MEV mechanism.
//!    In v2 it persists "elevated for fun" — staccana doesn't *need* it for MEV deterrence
//!    (the FBA does that), but it shapes a different fee market that the v1 audience
//!    already tolerates.
//! 2. **Inflation disabled.** Validator rewards come from fees only. With v2's treasury
//!    funding ops (no inflation needed for that either), this stays disabled.
//! 3. **50% burn rate.** Half of fees burn, half go to validators.
//!
//! See `genesis/src/solana_classic_defaults.rs` in the v1 repo for the original.

use serde::{Deserialize, Serialize};

/// Mirrors `solana_fee_calculator::FeeRateGovernor` without taking the heavy dep. The
/// actual genesis-emit step converts this to the real type.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeeRateGovernor {
    pub target_lamports_per_signature: u64,
    pub target_signatures_per_slot: u64,
    pub min_lamports_per_signature: u64,
    pub max_lamports_per_signature: u64,
    pub burn_percent: u8,
}

/// 0.027 SOL — the fixed non-vote transaction fee inherited from classic v1.
pub const FIXED_TRANSACTION_FEE_LAMPORTS: u64 = 27_000_000;

/// 5,000 lamports — fee for vote transactions. Kept low so consensus participation isn't
/// priced out of the validator economy.
pub const VOTE_TRANSACTION_FEE_LAMPORTS: u64 = 5_000;

/// 50% — share of fees burned (the other 50% goes to validators).
pub const BURN_PERCENT: u8 = 50;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClassicDefaults;

impl ClassicDefaults {
    /// Fee governor producing the fixed-fee model. The signature-based dynamic adjustment
    /// is disabled (`target_signatures_per_slot = 0`); min and max are equal so the fee is
    /// permanently pinned.
    pub fn fee_rate_governor() -> FeeRateGovernor {
        FeeRateGovernor {
            target_lamports_per_signature: FIXED_TRANSACTION_FEE_LAMPORTS,
            target_signatures_per_slot: 0,
            min_lamports_per_signature: FIXED_TRANSACTION_FEE_LAMPORTS,
            max_lamports_per_signature: FIXED_TRANSACTION_FEE_LAMPORTS,
            burn_percent: BURN_PERCENT,
        }
    }

    /// Inflation: disabled. Validator rewards come from fees only; project ops come from
    /// the genesis treasury.
    pub fn inflation_disabled() -> bool {
        true
    }
}

/// Feature gates that ship ON at slot 0.
///
/// **Confidential transfer (4 gates):** the four ZK gates are `inactive` on mainnet,
/// devnet, and testnet as of fork time. Activating them at staccana's genesis is what
/// makes Token-22's Confidential Transfer extension work for the foreseeable future.
///
/// **Token-22 v8 syscall prerequisites (5 gates):** the spl-token-2022 v8 ELF directly
/// references `sol_curve_group_op`, `sol_alt_bn128_*`, `sol_big_mod_exp`, and
/// `sol_poseidon` syscalls. If any of these gates is inactive at deploy time, the loader
/// fails with `Unresolved symbol (...)` at the offending instruction. Token-22 v8 is the
/// version that ships the on-chain proof verifier we need for CTE, so it must be
/// deployable from slot 0.
///
/// Constant name is kept for backwards-compat; despite the `CTE_` prefix, this slice now
/// covers every feature gate we want flipped at genesis.
pub const CTE_FEATURE_GATES_AT_GENESIS: &[(&str, &str)] = &[
    // --- ZK / confidential transfer (the original four) ---
    (
        "zk1snxsc6Fh3wsGNbbHAJNHiJoYgF29mMnTSusGx5EJ",
        "enable Zk Token proof program and syscalls",
    ),
    (
        "zkesAyFB19sTkX8i9ReoKaMNDA4YNTPYJpZKPDt7FMW",
        "Re-enables zk-elgamal-proof program",
    ),
    (
        "zkNLP7EQALfC1TYeB3biDU7akDckj8iPkvh9y2Mt2K3",
        "enable Zk Token proof program transfer with fee",
    ),
    (
        "zkiTNuzBKxrCLMKehzuQeKZyLtX2yvFcEKMML8nExU8",
        "Enable zk token proof program to read proof from accounts instead of instruction data",
    ),
    // --- Token-22 v8 syscall prerequisites ---
    (
        "7rcw5UtqgDTBBv2EcynNfYckgdAaH1MAsCjKgXMkN7Ri",
        "enable curve25519 syscalls (sol_curve_group_op, sol_curve_multiscalar_mul, sol_curve_validate_point)",
    ),
    (
        "A16q37opZdQMCbe5qJ6xpBB9usykfv8jZaMkxvZQi4GJ",
        "enable alt_bn128 syscalls (sol_alt_bn128_group_op)",
    ),
    (
        "EJJewYSddEEtSZHiqugnvhQHiWyZKjkFDQASd7oKSagn",
        "enable big_mod_exp syscall (sol_big_mod_exp)",
    ),
    (
        "EeyoXa3AyQuHkhRmT9mhKtTPrLNPBuNQbLEvyt5VrYxv",
        "enable alt_bn128 compression syscall (sol_alt_bn128_compression)",
    ),
    (
        "EaQpmC6GtRssaZ3PCUM5YksGqUdMLeZ46BQXYtHYakDS",
        "enable poseidon syscall (sol_poseidon)",
    ),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_governor_is_pinned() {
        let g = ClassicDefaults::fee_rate_governor();
        assert_eq!(g.min_lamports_per_signature, g.max_lamports_per_signature);
        assert_eq!(g.min_lamports_per_signature, FIXED_TRANSACTION_FEE_LAMPORTS);
        assert_eq!(g.target_signatures_per_slot, 0);
        assert_eq!(g.burn_percent, BURN_PERCENT);
    }

    #[test]
    fn cte_gate_count() {
        // 4 ZK gates + 5 Token-22 v8 syscall prerequisite gates.
        assert_eq!(CTE_FEATURE_GATES_AT_GENESIS.len(), 9);
    }

    #[test]
    fn no_duplicate_feature_gates() {
        use std::collections::HashSet;
        let mut seen: HashSet<&str> = HashSet::new();
        for (k, _) in CTE_FEATURE_GATES_AT_GENESIS {
            assert!(seen.insert(k), "duplicate feature-gate pubkey {k}");
        }
    }
}
