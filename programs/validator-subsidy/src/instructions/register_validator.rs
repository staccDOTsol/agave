//! `register_validator` — governance adds a validator to the registry.
//!
//! v1 has no self-registration: the governance multisig is the only path. Initializes a
//! [`ValidatorRecord`] PDA at `["validator", validator_pubkey]` with all metrics zeroed,
//! and appends the pubkey to the [`ValidatorRegistry`].
//!
//! Idempotency: re-registering the same pubkey rejects with `ValidatorAlreadyRegistered`
//! (Anchor's `init` constraint catches the duplicate PDA).

use crate::error::SubsidyError;
use crate::state::{SubsidyConfig, ValidatorRecord, ValidatorRegistry, MAX_VALIDATORS};
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RegisterValidatorArgs {
    /// Validator identity address (Solana vote account's identity, NOT the vote
    /// account itself). Distributions land on this address.
    pub validator: Pubkey,
}

#[derive(Accounts)]
#[instruction(args: RegisterValidatorArgs)]
pub struct RegisterValidator<'info> {
    /// Must equal `subsidy_config.governance`. Pays for the new `ValidatorRecord` PDA.
    #[account(
        mut,
        constraint = authority.key() == subsidy_config.governance
            @ SubsidyError::BadInstructionData,
    )]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"subsidy_config"],
        bump = subsidy_config.bump,
    )]
    pub subsidy_config: Account<'info, SubsidyConfig>,

    #[account(
        mut,
        seeds = [b"validator_registry"],
        bump = validator_registry.bump,
    )]
    pub validator_registry: Account<'info, ValidatorRegistry>,

    #[account(
        init,
        payer = authority,
        space = ValidatorRecord::SPACE,
        seeds = [b"validator", args.validator.as_ref()],
        bump,
    )]
    pub validator_record: Account<'info, ValidatorRecord>,

    pub system_program: Program<'info, System>,
}

/// Handler — append to the registry, init the record with zero metrics.
pub fn handler(ctx: Context<RegisterValidator>, args: RegisterValidatorArgs) -> Result<()> {
    let reg = &mut ctx.accounts.validator_registry;
    require!(
        (reg.count as usize) < MAX_VALIDATORS,
        SubsidyError::ValidatorRegistryFull
    );

    // Defense-in-depth: scan for an existing entry. The `init` constraint on the PDA
    // already catches the on-chain duplicate, but checking the registry contents
    // explicitly catches the (unlikely) race where the registry is somehow out of sync.
    for i in 0..(reg.count as usize) {
        if reg.validators[i] == args.validator {
            return Err(SubsidyError::ValidatorAlreadyRegistered.into());
        }
    }

    // Newer rustc rejects `reg.validators[reg.count as usize] = ...` as a simultaneous
    // mutable + immutable borrow of `*reg`. Bind the index first.
    let next_idx = reg.count as usize;
    reg.validators[next_idx] = args.validator;
    reg.count = reg
        .count
        .checked_add(1)
        .ok_or(SubsidyError::BadInstructionData)?;

    let rec = &mut ctx.accounts.validator_record;
    rec.validator = args.validator;
    rec.uptime_bps = 0;
    rec.delegated_stake = 0;
    rec.votes_cast = 0;
    rec.last_metrics_slot = 0;
    rec.last_metrics_nonce = 0;
    rec.last_distribution_epoch = 0;
    rec.total_subsidy_received = 0;
    rec.bump = ctx.bumps.validator_record;

    Ok(())
}
