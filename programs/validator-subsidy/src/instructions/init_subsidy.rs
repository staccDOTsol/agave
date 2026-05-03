//! `init_subsidy` — governance-gated one-shot bootstrap of the subsidy machinery.
//!
//! Initializes two PDAs in one tx:
//! - [`SubsidyConfig`] at `["subsidy_config"]` with the bridge program id, productive-
//!   position vault address, federation set, and the bootstrap reserve sized as
//!   `treasury_total × TREASURY_BOOTSTRAP_BPS / 10_000`.
//! - [`ValidatorRegistry`] at `["validator_registry"]` — empty.
//!
//! `treasury_total` is the lamports balance of the treasury PDA at `init_subsidy` time;
//! the program does NOT introspect the treasury account itself (no clean way to without
//! taking it as an account, and that complicates the PDA chain). The governance signer
//! is responsible for reading the treasury balance off-chain and passing it correctly.

use crate::error::SubsidyError;
use crate::state::{
    SubsidyConfig, ValidatorRegistry, MAX_FEDERATION_MEMBERS,
};
use crate::subsidy::compute_bootstrap_reserve;
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitSubsidyArgs {
    /// Governance multisig key. All gated ops are checked against this.
    pub governance: Pubkey,

    /// Bridge program id used for productive-position CPIs.
    pub bridge_program_id: Pubkey,

    /// Productive-position vault PDA — the bridge's `AssetConfig` PDA for the staked
    /// asset (e.g. pSYRUP). Stored for binding; CPI account list is supplied per call.
    pub productive_vault: Pubkey,

    /// Bridge `asset_id` of the productive position.
    pub productive_asset_id: u32,

    /// Total treasury balance at init time (lamports). Used to compute the bootstrap
    /// reserve. Caller is responsible for accuracy — the program does not introspect.
    pub treasury_total: u64,

    /// Federation threshold (M).
    pub federation_m: u8,

    /// Federation member count (N).
    pub federation_n: u8,

    /// Federation pubkeys. Variable-length on the wire — Anchor serializes a
    /// `Vec<Pubkey>` as `[u32 len-LE | members…]`. Length must match
    /// `federation_n`. Storage in `SubsidyConfig` is still a fixed
    /// `[Pubkey; MAX_FEDERATION_MEMBERS]`, zero-padded; the wire-side change
    /// just keeps the ix data under the 1232-byte legacy tx ceiling for
    /// reasonable N (e.g. M-of-9 → ~408 bytes vs the old 1142 bytes that
    /// hit "encoding overruns Uint8Array").
    pub federation_members: Vec<Pubkey>,
}

#[derive(Accounts)]
#[instruction(args: InitSubsidyArgs)]
pub struct InitSubsidy<'info> {
    /// Pays for both PDA allocations. v1 expects this signer == `args.governance`; the
    /// handler does not enforce that since deploy-time tooling will use a hot key for
    /// the deploy and a cold key for ongoing governance.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = SubsidyConfig::SPACE,
        seeds = [b"subsidy_config"],
        bump,
    )]
    pub subsidy_config: Account<'info, SubsidyConfig>,

    #[account(
        init,
        payer = authority,
        space = ValidatorRegistry::SPACE,
        seeds = [b"validator_registry"],
        bump,
    )]
    pub validator_registry: Account<'info, ValidatorRegistry>,

    pub system_program: Program<'info, System>,
}

/// Handler — populate the two PDAs from `args` and the derived bootstrap reserve.
pub fn handler(ctx: Context<InitSubsidy>, args: InitSubsidyArgs) -> Result<()> {
    require!(
        args.federation_m > 0
            && args.federation_n > 0
            && args.federation_n as usize <= MAX_FEDERATION_MEMBERS
            && args.federation_m <= args.federation_n
            && args.federation_members.len() == args.federation_n as usize,
        SubsidyError::BadFederationParams
    );

    let bootstrap_reserve = compute_bootstrap_reserve(args.treasury_total);

    let cfg = &mut ctx.accounts.subsidy_config;
    cfg.governance = args.governance;
    cfg.bridge_program_id = args.bridge_program_id;
    cfg.productive_vault = args.productive_vault;
    cfg.productive_asset_id = args.productive_asset_id;
    cfg.productive_deposit_total = 0;
    cfg.bootstrap_reserve_initial = bootstrap_reserve;
    cfg.bootstrap_reserve_remaining = bootstrap_reserve;
    cfg.last_distributed_epoch = 0;
    cfg.federation_m = args.federation_m;
    cfg.federation_n = args.federation_n;
    // Storage is fixed-size [Pubkey; MAX_FEDERATION_MEMBERS], zero-padded.
    // Copy the variable-length wire vec into the prefix; leave the tail as
    // `Pubkey::default()` from the `init` zero-initialization.
    let mut padded = [Pubkey::default(); MAX_FEDERATION_MEMBERS];
    for (i, k) in args.federation_members.iter().enumerate() {
        padded[i] = *k;
    }
    cfg.federation_members = padded;
    cfg.bump = ctx.bumps.subsidy_config;

    let reg = &mut ctx.accounts.validator_registry;
    reg.count = 0;
    reg.bump = ctx.bumps.validator_registry;

    Ok(())
}
