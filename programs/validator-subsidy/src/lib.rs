//! Staccana validator-subsidy program.
//!
//! Implements SPEC.md §7.2 / §7.3: closes the validator-economics loop in a chain that
//! has inflation disabled (classic v1 inheritance) and where the FBA structurally removes
//! MEV revenue. Validators are paid out of two sources:
//!
//! 1. A **productive position** funded with `TREASURY_PRODUCTIVE_BPS` of the genesis
//!    treasury (default 80%). v1 deposits the SOL into the bridge as pSYRUP via the
//!    bridge program's `mint` ix; long-term this becomes staccana-native staking once the
//!    validator set is non-trivial.
//! 2. A **bootstrap reserve** sized at `TREASURY_BOOTSTRAP_BPS` of the genesis treasury
//!    (default 2%) that pays validators directly for `BOOTSTRAP_EPOCHS` epochs (≈ 30
//!    days) while the productive position has not yet earned anything.
//!
//! Per-validator weight each epoch is `uptime_bps × delegated_stake × votes_cast`, all
//! in `u128` to avoid overflow. The per-epoch `EpochAccrual` PDA holds the federation-
//! attested observed yield; `distribute_yield` reads it and pays each registered
//! validator pro-rata.
//!
//! Module layout:
//!
//! - [`state`] — `SubsidyConfig`, `ValidatorRegistry`, `ValidatorRecord`, `EpochAccrual`
//! - [`error`] — typed `SubsidyError` codes
//! - [`subsidy`] — pure helpers for weight + share math + attestation message
//!   construction (extensively unit-tested)
//! - [`ed25519`] — re-export of the bridge program's Instructions-sysvar reader so the
//!   federation-attestation pattern stays identical across crates
//! - [`instructions`] — handler modules for each ix
//!
//! Instructions:
//!
//! 1. `init_subsidy` — one-shot: bootstraps `SubsidyConfig` and `ValidatorRegistry`.
//! 2. `stake_to_productive` — governance-gated CPI into the bridge to mint the productive
//!    position from treasury SOL.
//! 3. `unstake_from_productive` — inverse: governance-gated CPI into the bridge `burn` ix.
//! 4. `register_validator` — governance adds a validator to the registry; v1 has no
//!    self-registration.
//! 5. `update_validator_metrics` — federation-attested update of a validator's per-epoch
//!    metrics. Same M-of-N ed25519 precompile pattern as the bridge's `update_ratio`.
//! 6. `distribute_yield` — permissionless: reads `EpochAccrual` for `epoch`, walks the
//!    registry, transfers each validator's pro-rata share from the treasury PDA.
//!    Idempotent.
//! 7. `bootstrap_distribute` — permissionless: only valid for `epoch < BOOTSTRAP_EPOCHS`.
//!    Distributes `bootstrap_reserve / BOOTSTRAP_EPOCHS` from the bootstrap reserve at
//!    a fixed rate, pro-rata.
//!
//! See `docs/SPEC.md` §7 (NORMATIVE) and `docs/ARCHITECTURE.md` (Treasury section) for
//! the surrounding architecture.

// Anchor 1.0 fires a deprecation warning for raw `AccountInfo` use inside `Accounts`
// derives (preferring `UncheckedAccount`). The semantics are unchanged. This crate's
// CPI plumbing into the bridge passes account infos through to `invoke_signed`, where
// keeping them as `AccountInfo` is the clearest expression of intent — suppress the
// warning crate-wide rather than rewriting every account context.
#![allow(deprecated)]

use anchor_lang::prelude::*;

pub mod ed25519;
pub mod error;
pub mod instructions;
pub mod state;
pub mod subsidy;

pub use error::SubsidyError;
pub use instructions::*;

// Placeholder program ID. Replace with the real deployed address before mainnet launch;
// SPEC.md §2.1 lists `TREASURY_PROGRAM_ID = TBD` and the validator-subsidy program is
// the on-chain consumer of that PDA. The placeholder is a 43-character base58 string
// starting with the human-readable prefix "Subsidy" and padded with `1`s; it decodes to
// exactly 32 bytes (verified via `base58.b58decode("Subsidy1111...111").length == 32`).
declare_id!("Subsidy111111111111111111111111111111111111");

/// Hardcoded admin pubkey gating the one-shot `init_subsidy` ix.
///
/// The original handler accepted any signer and stored `args.governance`
/// verbatim, intending the off-chain deploy script to pass the cold
/// governance key. But on a live program with the SubsidyConfig PDA not
/// yet created, ANY caller could front-run the deploy and bind their own
/// pubkey as `governance` — which gates `register_validator`,
/// `stake_to_productive`, and `unstake_from_productive`. The same auditor
/// who flagged megadrop's `update_megadrop` flagged this.
///
/// Constraining `init_subsidy.authority` to this const closes the
/// front-run hole. Once init succeeds the binding is locked (Anchor's
/// `init` constraint blocks re-init) and `args.governance` is whatever
/// the legitimate deployer chose to put there.
///
/// Same key as `staccana_megadrop::ADMIN_AUTHORITY` — staccana's BPF
/// upgrade-authority. Keypair on val-1 at
/// `/etc/staccana/keys/upgrade-authority.json`.
// Anchor 1.x doesn't re-export `pubkey!` — use the const-fn path directly.
pub const ADMIN_AUTHORITY: Pubkey =
    Pubkey::from_str_const("HSwe2Y7i6CPuJGb27rBwUumt8HZ8sCpQvG4PBBiC5f4y");

#[program]
pub mod staccana_validator_subsidy {
    use super::*;

    /// Governance-gated one-shot. Initializes `SubsidyConfig` (bridge program id,
    /// productive-position vault address, bootstrap reserve, etc.) and an empty
    /// `ValidatorRegistry`. See [`instructions::init_subsidy`].
    pub fn init_subsidy(ctx: Context<InitSubsidy>, args: InitSubsidyArgs) -> Result<()> {
        instructions::init_subsidy::handler(ctx, args)
    }

    /// Governance-gated CPI into the bridge `mint` ix to swap treasury SOL into the
    /// productive position (pSYRUP via the bridge in v1). The treasury PDA signs as the
    /// depositor. See [`instructions::stake_to_productive`].
    pub fn stake_to_productive(
        ctx: Context<StakeToProductive>,
        args: StakeToProductiveArgs,
    ) -> Result<()> {
        instructions::stake_to_productive::handler(ctx, args)
    }

    /// Governance-gated CPI into the bridge `burn` ix to redeem mint tokens back to
    /// treasury SOL. See [`instructions::unstake_from_productive`].
    pub fn unstake_from_productive(
        ctx: Context<UnstakeFromProductive>,
        args: UnstakeFromProductiveArgs,
    ) -> Result<()> {
        instructions::unstake_from_productive::handler(ctx, args)
    }

    /// Governance-gated registration of a new validator. Initializes the
    /// `ValidatorRecord` PDA with zeroed metrics. See
    /// [`instructions::register_validator`].
    pub fn register_validator(
        ctx: Context<RegisterValidator>,
        args: RegisterValidatorArgs,
    ) -> Result<()> {
        instructions::register_validator::handler(ctx, args)
    }

    /// Federation-attested update of a validator's per-epoch metrics
    /// (`uptime_bps`, `delegated_stake`, `votes_cast`). Verifies M ed25519 precompile
    /// signatures over the canonical `STACCANA_VALIDATOR_METRICS_V1` message.
    /// See [`instructions::update_validator_metrics`].
    pub fn update_validator_metrics(
        ctx: Context<UpdateValidatorMetrics>,
        args: UpdateValidatorMetricsArgs,
    ) -> Result<()> {
        instructions::update_validator_metrics::handler(ctx, args)
    }

    /// Permissionless. Reads the `EpochAccrual` PDA for `args.epoch` (which an oracle /
    /// federation has already populated with the observed yield), iterates the
    /// validator registry passed in `remaining_accounts`, and pays each validator their
    /// pro-rata share from the treasury PDA. Idempotent — second call is a no-op.
    /// See [`instructions::distribute_yield`].
    pub fn distribute_yield(
        ctx: Context<DistributeYield>,
        args: DistributeYieldArgs,
    ) -> Result<()> {
        instructions::distribute_yield::handler(ctx, args)
    }

    /// Permissionless. Only valid for `args.epoch < BOOTSTRAP_EPOCHS`. Distributes a
    /// fixed `bootstrap_reserve / BOOTSTRAP_EPOCHS` per epoch, pro-rata across the
    /// registry. Replaces `distribute_yield` for the first 60 epochs while the
    /// productive position has not yet accrued. See
    /// [`instructions::bootstrap_distribute`].
    pub fn bootstrap_distribute(
        ctx: Context<BootstrapDistribute>,
        args: BootstrapDistributeArgs,
    ) -> Result<()> {
        instructions::bootstrap_distribute::handler(ctx, args)
    }
}
