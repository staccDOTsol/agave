//! SPEC §2 invariants for the classic v1 economic defaults inherited at staccana genesis.
//!
//! These constants are normative: they're committed to in the genesis configuration
//! (SPEC §3.5) and must not drift. This file pins each value to the SPEC and verifies the
//! `ClassicDefaults` helpers expose them consistently.

use staccana_genesis::*;

#[test]
fn fixed_transaction_fee_lamports_matches_spec() {
    // SPEC §2.2: FIXED_TRANSACTION_FEE_LAMPORTS = 27_000_000 (0.027 SOL).
    assert_eq!(FIXED_TRANSACTION_FEE_LAMPORTS, 27_000_000);
}

#[test]
fn vote_transaction_fee_lamports_matches_spec() {
    // SPEC §2.2: VOTE_TRANSACTION_FEE_LAMPORTS = 5_000.
    assert_eq!(VOTE_TRANSACTION_FEE_LAMPORTS, 5_000);
}

#[test]
fn burn_percent_matches_spec() {
    // SPEC §2.2: BURN_PERCENT = 50 (50% of fees burned).
    assert_eq!(BURN_PERCENT, 50);
}

#[test]
fn inflation_disabled_matches_spec() {
    // SPEC §2.2: INFLATION = disabled.
    assert!(ClassicDefaults::inflation_disabled());
}

#[test]
fn fee_governor_emits_pinned_fixed_fee() {
    // The min/max bracket is collapsed to the fixed fee — no dynamic adjustment ever.
    let g = ClassicDefaults::fee_rate_governor();
    assert_eq!(g.target_lamports_per_signature, FIXED_TRANSACTION_FEE_LAMPORTS);
    assert_eq!(g.min_lamports_per_signature, FIXED_TRANSACTION_FEE_LAMPORTS);
    assert_eq!(g.max_lamports_per_signature, FIXED_TRANSACTION_FEE_LAMPORTS);
    assert_eq!(g.target_signatures_per_slot, 0);
    assert_eq!(g.burn_percent, BURN_PERCENT);
}

#[test]
fn cte_feature_gates_count_matches_spec() {
    // SPEC §2.4: exactly four ZK ElGamal Proof / confidential transfer gates ship ON at
    // slot 0.
    assert_eq!(CTE_FEATURE_GATES_AT_GENESIS.len(), 4);
}

#[test]
fn cte_feature_gates_pubkeys_match_spec() {
    // SPEC §2.4 lists these four pubkeys exactly. The order in the const is normative —
    // any reordering changes the genesis fingerprint downstream.
    let expected_pubkeys = [
        "zk1snxsc6Fh3wsGNbbHAJNHiJoYgF29mMnTSusGx5EJ",
        "zkesAyFB19sTkX8i9ReoKaMNDA4YNTPYJpZKPDt7FMW",
        "zkNLP7EQALfC1TYeB3biDU7akDckj8iPkvh9y2Mt2K3",
        "zkiTNuzBKxrCLMKehzuQeKZyLtX2yvFcEKMML8nExU8",
    ];
    for (i, expected) in expected_pubkeys.iter().enumerate() {
        assert_eq!(
            CTE_FEATURE_GATES_AT_GENESIS[i].0, *expected,
            "CTE gate {} pubkey diverged from SPEC §2.4",
            i
        );
    }
}

#[test]
fn cte_feature_gates_have_descriptions() {
    // Every gate carries a short description (the second tuple field). Empty descriptions
    // would be a regression — the human-readable label is what makes the gate set
    // self-documenting in the genesis config.
    for (pubkey, desc) in CTE_FEATURE_GATES_AT_GENESIS {
        assert!(!pubkey.is_empty(), "pubkey must not be empty");
        assert!(
            !desc.is_empty(),
            "description for {} must not be empty",
            pubkey
        );
    }
}
