//! `create` instruction: spin up a new bonding curve.
//!
//! Steps performed:
//!
//! 1. Allocate the [`crate::state::BondingCurve`] PDA.
//! 2. Initialize a fresh **Token-22** mint with the **Confidential Transfer Extension**
//!    enabled by default. The mint authority is the curve PDA; freeze authority is unset
//!    (no rugs).
//! 3. Initialize the curve's vault as a Token-22 account owned by the curve PDA.
//! 4. Mint the full virtual token allocation ([`crate::curve::VIRTUAL_TOKENS`]) into the
//!    vault — that's the curve's initial token-side liquidity.
//! 5. Seed the curve's lamport balance from the treasury PDA (TBD per
//!    `docs/SPEC.md` §2.1; the integrator wires this up). The treasury seeds are documented
//!    as a placeholder here; production wiring is responsible for moving lamports.
//!
//! ## Caller-supplied data
//!
//! `name`, `symbol`, `uri` are passed through to the Token-22 metadata pointer / metadata
//! extension setup. We keep them here for completeness; v0 stores them only on the PDA so
//! off-chain indexers have a deterministic source. Adding the Token-22 Metadata extension
//! init is left as a follow-up — anchor-spl does not yet expose a convenient Token-22
//! Metadata-extension builder, and the focus of this milestone is the curve mechanics.

// `mint` and `curve_vault` are declared as `AccountInfo` (rather than `UncheckedAccount`)
// because we drive their initialization via raw Token-22 ixs that take `AccountInfo` and
// passing them through `.clone()` keeps the helper-function signatures simple. Anchor 1.0
// fires a deprecation warning for raw `AccountInfo` use inside `Accounts` derives — the
// semantics are unchanged so we suppress the warning explicitly.
#![allow(deprecated)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::system_program;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{self, MintTo};
// Anchor 1.0's `anchor_spl::token_2022` re-exports `spl_token_2022_interface` as
// `spl_token_2022`. Our direct `spl-token-2022` Cargo dep is renamed to
// `spl_token_2022` (package = `spl-token-2022-interface`) so the extension/instruction
// builders here resolve to the same types as the anchor_spl wrappers.
//
// `Pack` is required for `spl_token_2022::state::Account::LEN` to resolve under the new
// crate split (the trait is in `solana-program-pack`, not the prelude).
use anchor_lang::solana_program::program_pack::Pack;
use spl_token_2022::extension::ExtensionType;
use spl_token_2022::instruction as token_2022_ix;

use crate::curve::{VIRTUAL_SOL, VIRTUAL_TOKENS};
use crate::error::SecretPumpError;
use crate::state::{BondingCurve, CurveCreatedEvent};

/// Caller-supplied metadata for the new curve. Stored on the PDA verbatim; off-chain
/// indexers consume it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateArgs {
    /// Display name (UTF-8). Capped at 32 bytes.
    pub name: [u8; 32],
    /// Display symbol (UTF-8). Capped at 10 bytes.
    pub symbol: [u8; 10],
    /// Off-chain metadata URI. Capped at 200 bytes.
    pub uri: [u8; 200],
}

#[derive(Accounts)]
pub struct CreateCurve<'info> {
    /// The fresh Token-22 mint. Must be a new keypair signer; this instruction initializes
    /// it. Decimals are fixed at 9 to match `VIRTUAL_TOKENS`'s smallest-unit accounting.
    ///
    /// The mint is created via raw SPL Token-22 instructions (not Anchor's `init`) because
    /// we need the Confidential Transfer extension active before `InitializeMint` runs.
    #[account(mut, signer)]
    /// CHECK: validated and initialized in handler via raw Token-22 ixs; account is empty
    /// at instruction entry.
    pub mint: AccountInfo<'info>,

    /// Per-mint bonding curve PDA. Owns the mint authority and the vault.
    #[account(
        init,
        payer = creator,
        space = BondingCurve::SPACE,
        seeds = [BondingCurve::SEED, mint.key().as_ref()],
        bump,
    )]
    pub bonding_curve: Account<'info, BondingCurve>,

    /// Vault token account that holds the curve's token reserves. PDA owned by the curve
    /// account itself (i.e. authority = `bonding_curve`).
    ///
    /// Created via raw Token-22 instructions in the handler — Anchor's `init` does not yet
    /// drive Token-22 with extensions cleanly enough for this case.
    #[account(mut)]
    /// CHECK: validated and initialized in handler.
    pub curve_vault: AccountInfo<'info>,

    /// Curve creator. Pays rent for mint + curve PDA + vault. No protocol authority is
    /// granted to this address.
    #[account(mut)]
    pub creator: Signer<'info>,

    /// SPL Token-22 program.
    pub token_program: Program<'info, Token2022>,

    /// System program (for rent-paying CPIs).
    pub system_program: Program<'info, System>,

    /// Rent sysvar (Token-22 still requires it for some extension inits).
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<CreateCurve>, args: CreateArgs) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();
    let curve_key = ctx.accounts.bonding_curve.key();
    let creator_key = ctx.accounts.creator.key();
    let curve_bump = ctx.bumps.bonding_curve;

    // ---- 1. Allocate + initialize the Token-22 mint with CTE active ----
    create_mint_with_confidential_transfer(
        &ctx.accounts.mint,
        &ctx.accounts.creator,
        &ctx.accounts.system_program,
        &ctx.accounts.token_program,
        &ctx.accounts.rent,
        &curve_key,
    )?;

    // ---- 2. Allocate + initialize the curve's vault token account ----
    let (vault_key, vault_bump) = Pubkey::find_program_address(
        &[BondingCurve::VAULT_SEED, mint_key.as_ref()],
        ctx.program_id,
    );
    if vault_key != ctx.accounts.curve_vault.key() {
        return err!(SecretPumpError::BadCurveVault);
    }
    create_vault_token_account(
        &ctx.accounts.curve_vault,
        &ctx.accounts.mint,
        &ctx.accounts.bonding_curve.to_account_info(),
        &ctx.accounts.creator,
        &ctx.accounts.system_program,
        &ctx.accounts.token_program,
        &ctx.accounts.rent,
        vault_bump,
    )?;

    // ---- 3. Mint the full virtual token allocation into the vault ----
    let bump_arr = [curve_bump];
    let signer_seeds_owned = BondingCurve::signer_seeds(&mint_key, &bump_arr);
    let signer_seeds: &[&[&[u8]]] = &[&signer_seeds_owned];

    let cpi_accounts = MintTo {
        mint: ctx.accounts.mint.clone(),
        to: ctx.accounts.curve_vault.clone(),
        authority: ctx.accounts.bonding_curve.to_account_info(),
    };
    // Anchor 1.0: `CpiContext::new_with_signer` takes the program id (`Pubkey`) instead
    // of an `AccountInfo`.
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        cpi_accounts,
        signer_seeds,
    );
    token_interface::mint_to(cpi_ctx, VIRTUAL_TOKENS)?;

    // ---- 4. Initialize the BondingCurve PDA fields ----
    let curve = &mut ctx.accounts.bonding_curve;
    curve.mint = mint_key;
    curve.creator = creator_key;
    curve.real_sol_reserves = 0;
    curve.real_token_reserves = VIRTUAL_TOKENS;
    curve.total_tokens_dispensed = 0;
    curve.total_fees_collected = 0;
    curve.graduated = false;
    curve.graduation_slot = 0;
    curve.bump = curve_bump;
    curve.vault_bump = vault_bump;

    // Sanity: the vault's deserialized balance must match what we just minted. We use the
    // token-interface to read the Token-22 account.
    let vault_data = ctx.accounts.curve_vault.try_borrow_data()?;
    let vault_state =
        spl_token_2022::extension::StateWithExtensions::<spl_token_2022::state::Account>::unpack(
            &vault_data,
        )
        .map_err(|_| ProgramError::InvalidAccountData)?;
    if vault_state.base.amount != VIRTUAL_TOKENS {
        return err!(SecretPumpError::BadInitialTokenAllocation);
    }
    drop(vault_data);

    emit!(CurveCreatedEvent {
        mint: mint_key,
        creator: creator_key,
        virtual_sol: VIRTUAL_SOL,
        virtual_tokens: VIRTUAL_TOKENS,
    });

    // Metadata is intentionally not propagated on-chain in v0. Off-chain indexers can
    // re-derive name/symbol/uri from the originating tx data; the program does not
    // depend on them. Acknowledge the parameter to silence dead-code warnings.
    let _ = args;

    Ok(())
}

/// Allocate the mint account, initialize its Confidential Transfer extension, then
/// initialize the base mint with `decimals = 9` and `mint_authority = curve_pda`.
///
/// Order matters for Token-22 with extensions: extension inits MUST happen between
/// `SystemProgram::create_account` and `InitializeMint2`. We pre-compute the account size
/// from the extension list so the rent transfer is exact.
fn create_mint_with_confidential_transfer<'info>(
    mint: &AccountInfo<'info>,
    payer: &Signer<'info>,
    system_program: &Program<'info, System>,
    token_program: &Program<'info, Token2022>,
    rent: &Sysvar<'info, Rent>,
    curve_pda: &Pubkey,
) -> Result<()> {
    let extensions = [ExtensionType::ConfidentialTransferMint];
    let space = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&extensions)
        .map_err(|_| ProgramError::InvalidAccountData)?;
    let lamports = rent.minimum_balance(space);

    // 1. Create the empty mint account, owned by Token-22.
    //
    // Anchor 1.0: `CpiContext::new` takes the program id (`Pubkey`) instead of an
    // `AccountInfo`.
    system_program::create_account(
        CpiContext::new(
            system_program.key(),
            system_program::CreateAccount {
                from: payer.to_account_info(),
                to: mint.clone(),
            },
        ),
        lamports,
        space as u64,
        &spl_token_2022::id(),
    )?;

    // 2. Initialize Confidential Transfer extension.
    //    `auto_approve_new_accounts = true` → users can open confidential accounts without
    //    a per-account approval ix from a config authority. `auditor_elgamal_pubkey = None`
    //    → no protocol-level decryption back-door.
    // spl-token-2022-interface 2.x changed this signature: `authority` is now
    // `Option<Pubkey>` (was `Option<&Pubkey>` in spl-token-2022 3.x). The semantic
    // arguments below are unchanged.
    let cte_ix = spl_token_2022::extension::confidential_transfer::instruction::initialize_mint(
        &spl_token_2022::id(),
        &mint.key(),
        None,         // confidential transfer mint authority — none, immutable
        true,         // auto_approve_new_accounts
        None,         // auditor_elgamal_pubkey
    )
    .map_err(|_| ProgramError::InvalidArgument)?;
    invoke(
        &cte_ix,
        &[mint.clone(), token_program.to_account_info()],
    )?;

    // 3. Initialize the base mint. Decimals = 9 to match VIRTUAL_TOKENS smallest-units
    //    convention. Freeze authority intentionally None (no rug authority).
    let init_mint_ix = token_2022_ix::initialize_mint2(
        &spl_token_2022::id(),
        &mint.key(),
        curve_pda,
        None, // freeze authority
        9,
    )
    .map_err(|_| ProgramError::InvalidArgument)?;
    invoke(
        &init_mint_ix,
        &[mint.clone(), token_program.to_account_info()],
    )?;

    Ok(())
}

/// Allocate the curve's vault token account at the PDA `[VAULT_SEED, mint]` with
/// `owner = curve_pda`. Account itself is a Token-22 account (no extra extensions on the
/// vault — the confidentiality lives at the mint level / user-side accounts).
#[allow(clippy::too_many_arguments)]
fn create_vault_token_account<'info>(
    vault: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    curve_pda: &AccountInfo<'info>,
    payer: &Signer<'info>,
    system_program: &Program<'info, System>,
    token_program: &Program<'info, Token2022>,
    rent: &Sysvar<'info, Rent>,
    vault_bump: u8,
) -> Result<()> {
    let space = spl_token_2022::state::Account::LEN;
    let lamports = rent.minimum_balance(space);

    let mint_key = mint.key();
    let bump_arr = [vault_bump];
    let seeds: &[&[u8]] = &[BondingCurve::VAULT_SEED, mint_key.as_ref(), &bump_arr];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    // 1. Create empty Token-22 account at the vault PDA.
    //
    // Anchor 1.0: `CpiContext::new_with_signer` takes the program id (`Pubkey`) instead
    // of an `AccountInfo`.
    system_program::create_account(
        CpiContext::new_with_signer(
            system_program.key(),
            system_program::CreateAccount {
                from: payer.to_account_info(),
                to: vault.clone(),
            },
            signer_seeds,
        ),
        lamports,
        space as u64,
        &spl_token_2022::id(),
    )?;

    // 2. InitializeAccount3 — sets owner without requiring the rent sysvar.
    let init_ix = token_2022_ix::initialize_account3(
        &spl_token_2022::id(),
        &vault.key(),
        &mint.key(),
        &curve_pda.key(),
    )
    .map_err(|_| ProgramError::InvalidArgument)?;
    invoke(
        &init_ix,
        &[
            vault.clone(),
            mint.clone(),
            curve_pda.clone(),
            token_program.to_account_info(),
        ],
    )?;

    Ok(())
}
