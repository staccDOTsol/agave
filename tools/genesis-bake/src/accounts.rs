//! Pre-populated genesis accounts.
//!
//! Each function in this module returns a `(Pubkey, AccountSharedData)` pair ready to
//! be inserted into [`solana_genesis_config::GenesisConfig::accounts`] via
//! `add_account`. Splitting them apart (rather than building one big function that
//! emits a `Vec`) keeps each constructor independently unit-testable.
//!
//! ## Categories
//!
//! 1. **Bootstrap validator + ancillary**: identity, vote, stake, faucet. All
//!    `BOOTSTRAP_LAMPORTS` (1 SOL) each, system-program-owned for v0 simplicity. Vote &
//!    stake accounts are NOT initialized as full `vote_state` / `stake_state` accounts
//!    here — vanilla `solana-genesis` does that wiring; we defer it. The validator boots
//!    with these accounts as plain SOL holdings; the operator can subsequently issue
//!    real `create-vote-account` / `create-stake-account` ixs after first slot. This
//!    matches the v0 behavior of `infra/scripts/30-init-validator.sh` which also did
//!    not need a fully-initialized vote account at slot 0.
//!
//! 2. **Treasury PDA**: derived at `["treasury"] / VALIDATOR_SUBSIDY_PROGRAM_ID`.
//!    Pre-credited with `composed.treasury_pda_lamports`. Owner is the validator-
//!    subsidy program so its `invoke_signed` calls (which sign with the treasury seed)
//!    can debit the PDA.
//!
//! 3. **Lazy-claim Config singleton**: derived at `["config"] / LAZY_CLAIM_PROGRAM_ID`.
//!    Owner is the lazy-claim program. Data is the manually-packed
//!    [`LazyClaimConfig`] payload (66 bytes) with `claimable_root` set to the value
//!    from `composed.lazy_claim_account.claimable_root` and `treasury_pda` set to the
//!    treasury PDA address derived above. Lamports: rent-exempt minimum for a 66-byte
//!    account.

use solana_account::AccountSharedData;
use solana_pubkey::Pubkey;
use solana_rent::Rent;
use solana_sdk_ids::system_program;

use staccana_lazy_claim::state::LazyClaimConfig as OnChainLazyClaimConfig;

use crate::pdas::{lazy_claim_config_pda, treasury_pda, LAZY_CLAIM_PROGRAM_ID, VALIDATOR_SUBSIDY_PROGRAM_ID};
use crate::BOOTSTRAP_LAMPORTS;

/// Build the bootstrap validator's identity account.
///
/// System-owned, zero-data, `BOOTSTRAP_LAMPORTS` lamports — the simplest possible
/// account, matches what vanilla solana-genesis seeds for a fresh dev cluster.
pub fn bootstrap_identity_account(identity: Pubkey) -> (Pubkey, AccountSharedData) {
    (
        identity,
        AccountSharedData::new(BOOTSTRAP_LAMPORTS, 0, &system_program::id()),
    )
}

/// Build the bootstrap vote account.
///
/// See module-level doc: this is a simple system-owned holding for v0; the actual
/// vote-state PDA materializes via a post-boot `create-vote-account` ix.
pub fn bootstrap_vote_account(vote: Pubkey) -> (Pubkey, AccountSharedData) {
    (
        vote,
        AccountSharedData::new(BOOTSTRAP_LAMPORTS, 0, &system_program::id()),
    )
}

/// Build the bootstrap stake account. Same shape as the vote account at v0 (see
/// module doc).
pub fn bootstrap_stake_account(stake: Pubkey) -> (Pubkey, AccountSharedData) {
    (
        stake,
        AccountSharedData::new(BOOTSTRAP_LAMPORTS, 0, &system_program::id()),
    )
}

/// Build the faucet holding.
///
/// Staccana doesn't run a faucet on mainnet (per
/// `infra/scripts/30-init-validator.sh` comment), but the keypair-and-account is
/// generated and present at slot 0 to keep tooling that expects a faucet pubkey from
/// crashing in dev. 1 SOL is enough to satisfy any tool that just wants to verify the
/// account exists.
pub fn faucet_account(faucet: Pubkey) -> (Pubkey, AccountSharedData) {
    (
        faucet,
        AccountSharedData::new(BOOTSTRAP_LAMPORTS, 0, &system_program::id()),
    )
}

/// Build the treasury PDA account, pre-credited with the lamport balance from the
/// composed genesis.
///
/// Owner: the validator-subsidy program, so its CPIs that debit the treasury (signed
/// with the `["treasury"]` PDA seeds) succeed.
///
/// Data: zero-length. The treasury PDA only carries lamports; subsidy distribution
/// metadata lives in the separate `SubsidyConfig` PDA created by the program's
/// `init_subsidy` ix post-boot.
pub fn treasury_account(lamports: u64) -> (Pubkey, AccountSharedData) {
    let (pda, _bump) = treasury_pda();
    (
        pda,
        AccountSharedData::new(lamports, 0, &VALIDATOR_SUBSIDY_PROGRAM_ID),
    )
}

/// Build the lazy-claim Config singleton account, pre-populated with the embedded
/// Merkle root.
///
/// - Address: `["config"] / LAZY_CLAIM_PROGRAM_ID`.
/// - Owner: the lazy-claim program (so the program's runtime `config_ai.owner ==
///   program_id` check passes — see `programs/lazy-claim/src/processor.rs`).
/// - Data: 66 bytes, packed via the on-chain [`LazyClaimConfig::pack`] so the layout
///   is byte-exact with what the program's `unpack` expects.
/// - Lamports: rent-exempt minimum for a 66-byte data account.
pub fn lazy_claim_config_account(claimable_root: [u8; 32]) -> (Pubkey, AccountSharedData) {
    let (pda, _bump) = lazy_claim_config_pda();
    let (treasury_pda_address, _) = treasury_pda();

    let cfg = OnChainLazyClaimConfig {
        claimable_root: solana_program_hash_bridge(claimable_root),
        treasury_pda: bridge_pubkey_to_program(treasury_pda_address),
    };

    let mut data = vec![0u8; OnChainLazyClaimConfig::SIZE];
    cfg.pack(&mut data)
        .expect("LazyClaimConfig::pack must succeed for a buffer sized exactly to SIZE");

    let rent_exempt = Rent::default().minimum_balance(OnChainLazyClaimConfig::SIZE);

    let mut account = AccountSharedData::new(rent_exempt, OnChainLazyClaimConfig::SIZE, &LAZY_CLAIM_PROGRAM_ID);
    account.set_data_from_slice(&data);
    (pda, account)
}

/// Bridge a `[u8; 32]` into the on-chain crate's `Hash` type without forcing this
/// crate to depend on `solana-program` directly. The on-chain `LazyClaimConfig` uses
/// `solana_program::hash::Hash`; we have a `[u8; 32]` from the composed genesis. Both
/// types are byte-equivalent at the wire level.
fn solana_program_hash_bridge(bytes: [u8; 32]) -> solana_program::hash::Hash {
    solana_program::hash::Hash::new_from_array(bytes)
}

/// Bridge `solana_pubkey::Pubkey` into `solana_program::pubkey::Pubkey`. Both are 32-byte
/// arrays under the hood; the type is duplicated across the SDK split, so we reach
/// across via `to_bytes()`.
fn bridge_pubkey_to_program(pk: Pubkey) -> solana_program::pubkey::Pubkey {
    solana_program::pubkey::Pubkey::new_from_array(pk.to_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_account::ReadableAccount;

    fn pk(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte; 32])
    }

    #[test]
    fn bootstrap_identity_account_is_system_owned_with_one_sol() {
        let (key, acct) = bootstrap_identity_account(pk(1));
        assert_eq!(key, pk(1));
        assert_eq!(acct.lamports(), BOOTSTRAP_LAMPORTS);
        assert_eq!(acct.lamports(), 1_000_000_000);
        assert_eq!(*acct.owner(), system_program::id());
        assert_eq!(acct.data().len(), 0);
    }

    #[test]
    fn bootstrap_vote_account_matches_identity_shape() {
        let (key, acct) = bootstrap_vote_account(pk(2));
        assert_eq!(key, pk(2));
        assert_eq!(acct.lamports(), BOOTSTRAP_LAMPORTS);
        assert_eq!(*acct.owner(), system_program::id());
    }

    #[test]
    fn bootstrap_stake_account_matches_identity_shape() {
        let (key, acct) = bootstrap_stake_account(pk(3));
        assert_eq!(key, pk(3));
        assert_eq!(acct.lamports(), BOOTSTRAP_LAMPORTS);
        assert_eq!(*acct.owner(), system_program::id());
    }

    #[test]
    fn faucet_account_is_system_owned_with_one_sol() {
        let (key, acct) = faucet_account(pk(4));
        assert_eq!(key, pk(4));
        assert_eq!(acct.lamports(), BOOTSTRAP_LAMPORTS);
        assert_eq!(*acct.owner(), system_program::id());
    }

    #[test]
    fn treasury_account_owner_is_validator_subsidy_program() {
        let (pda, acct) = treasury_account(485_192_075_139_020_370);
        let (expected_pda, _) = treasury_pda();
        assert_eq!(pda, expected_pda);
        assert_eq!(acct.lamports(), 485_192_075_139_020_370);
        assert_eq!(*acct.owner(), VALIDATOR_SUBSIDY_PROGRAM_ID);
        // Treasury PDA stores no data, only lamports.
        assert_eq!(acct.data().len(), 0);
    }

    #[test]
    fn treasury_account_carries_zero_lamports_on_zero_input() {
        // Sanity: if the composed genesis ever had a zero treasury (synthetic test
        // case), we still produce a well-formed account at the PDA.
        let (pda, acct) = treasury_account(0);
        let (expected_pda, _) = treasury_pda();
        assert_eq!(pda, expected_pda);
        assert_eq!(acct.lamports(), 0);
    }

    #[test]
    fn lazy_claim_config_account_owner_is_lazy_claim_program() {
        let root = [0xAB; 32];
        let (pda, acct) = lazy_claim_config_account(root);
        let (expected_pda, _) = lazy_claim_config_pda();
        assert_eq!(pda, expected_pda);
        assert_eq!(*acct.owner(), LAZY_CLAIM_PROGRAM_ID);
        assert_eq!(acct.data().len(), OnChainLazyClaimConfig::SIZE);
    }

    #[test]
    fn lazy_claim_config_account_data_round_trips_via_unpack() {
        let root = [0xCD; 32];
        let (_pda, acct) = lazy_claim_config_account(root);
        // The on-chain `unpack` is what the program's processor uses; round-trip
        // through it to prove the genesis-side encoding is byte-compatible.
        let decoded = OnChainLazyClaimConfig::unpack(acct.data())
            .expect("on-chain LazyClaimConfig::unpack must accept the genesis-baked data");
        assert_eq!(decoded.claimable_root.to_bytes(), root);

        // The treasury_pda field in the config must equal the actual treasury PDA
        // address — that's the cross-reference the on-chain processor uses to
        // validate the treasury account passed into a claim ix.
        let (treasury_address, _) = treasury_pda();
        assert_eq!(decoded.treasury_pda.to_bytes(), treasury_address.to_bytes());
    }

    #[test]
    fn lazy_claim_config_account_is_rent_exempt() {
        let (_pda, acct) = lazy_claim_config_account([0u8; 32]);
        // Rent-exempt minimum for a 66-byte account is well-defined; we don't pin the
        // exact value (it can shift with rent params) — just confirm we're at or
        // above the floor.
        let floor = Rent::default().minimum_balance(OnChainLazyClaimConfig::SIZE);
        assert_eq!(acct.lamports(), floor);
        assert!(acct.lamports() > 0, "rent-exempt minimum should be positive");
    }
}
