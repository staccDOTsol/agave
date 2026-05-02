//! Staccana megadrop program.
//!
//! Implements the holder-claim flow described in `docs/MEGADROP.md`:
//! snapshotted holders of two Solana mainnet collections — `based_stacc_0` (Metaplex NFT
//! collection) and `proofv3` (Token-22 SPL fungible mint) — pull their per-holder
//! allocation **out of the staccana treasury** in 10 equal monthly tranches starting at
//! the chain's launch month.
//!
//! Architectural shape mirrors the lazy-claim program (Merkle inclusion + ed25519
//! precompile + per-pubkey claimed marker), with two extensions:
//!
//! - The "claimed marker" is an upgradable [`state::ClaimedMegadrop`] PDA carrying a
//!   16-bit tranche bitmap rather than a one-shot existence check, so the same holder
//!   can return month after month and consume tranches one at a time.
//! - Each requested tranche is gated on a calendar-month unlock check: tranche `i`
//!   (1..=10) requires `current_month >= genesis_month + (i - 1)`. Calendar math is in
//!   [`calendar`].
//!
//! Module layout:
//!
//! - [`state`]    — `MegadropConfig`, `ClaimedMegadrop`
//! - [`error`]    — typed `MegadropError` codes
//! - [`megadrop`] — pure helpers for tranche math, message construction, bitmap ops
//! - [`calendar`] — Unix timestamp → yyyymm conversion (handles leap years)
//! - [`merkle`]   — Merkle proof verification (mirrors `staccana-genesis::merkle`)
//! - [`ed25519`]  — Instructions-sysvar precompile reader (mirrors bridge / subsidy)
//! - [`instructions`] — handler modules for each ix
//!
//! Instructions:
//!
//! 1. `init_megadrop` — governance one-shot: sets the Merkle root, genesis month, and
//!    treasury authority. See [`instructions::init_megadrop`].
//! 2. `claim_megadrop` — the user-facing instruction. Verifies Merkle proof + ed25519
//!    signature + per-tranche unlock + per-tranche freshness, then debits the treasury
//!    PDA and marks the requested tranche bits. See [`instructions::claim_megadrop`].
//!
//! See `docs/MEGADROP.md` for the normative wire format and verification order, and
//! `docs/SPEC.md` §4 (lazy-claim — the architectural pattern this program mirrors) and
//! §7 (treasury — the source of allocations).

// Anchor 1.0 fires a deprecation warning for raw `AccountInfo` use inside `Accounts`
// derives (preferring `UncheckedAccount`). The semantics are unchanged. The treasury
// drain plumbing here passes account infos through to direct lamport mutation, where
// `AccountInfo` is the clearest expression of intent — suppress crate-wide rather than
// rewriting every account context.
#![allow(deprecated)]

use anchor_lang::prelude::*;

pub mod calendar;
pub mod ed25519;
pub mod error;
pub mod instructions;
pub mod megadrop;
pub mod merkle;
pub mod state;

pub use error::MegadropError;
pub use instructions::*;

// Placeholder program ID. Replace with the real deployed address before mainnet launch.
// 43-character base58 string starting with the human-readable prefix "Megadrop" and
// padded with `1`s; decodes to exactly 32 bytes (verified via
// `base58.b58decode("Megadrop1111...111").length == 32`). The 42-character form in the
// task spec was one byte short, so this string is one `1` longer.
declare_id!("Megadrop11111111111111111111111111111111111");

#[program]
pub mod staccana_megadrop {
    use super::*;

    /// Governance-gated one-shot. Initializes the singleton `MegadropConfig` PDA with
    /// the snapshot Merkle root, the genesis month (yyyymm — first tranche unlock), the
    /// total allocation summed across all leaves (sanity check), and the treasury
    /// authority (PDA-derived signer that drains the treasury). See
    /// [`instructions::init_megadrop`].
    pub fn init_megadrop(ctx: Context<InitMegadrop>, args: InitMegadropArgs) -> Result<()> {
        instructions::init_megadrop::handler(ctx, args)
    }

    /// Holder-initiated claim. Anyone can submit (the holder, or a relayer on their
    /// behalf — but the holder must have produced a fresh ed25519 signature on the
    /// canonical message), and the lamports always land at the holder's pubkey.
    ///
    /// Verification order:
    /// 1. Merkle proof against `MegadropConfig.claimable_root` for `(holder, total)`.
    /// 2. ed25519 sig from `holder` (via prior precompile + Instructions sysvar).
    /// 3. Each requested tranche is unlocked (current month gate).
    /// 4. Each requested tranche is unclaimed (bitmap check).
    ///
    /// Effects:
    /// 1. Mark the requested tranche bits in `ClaimedMegadrop.tranches_claimed`.
    /// 2. Compute `claim_amount = sum_of_requested_tranches × (total / 10)`.
    /// 3. Debit `claim_amount` lamports from the treasury PDA → holder pubkey.
    /// 4. Update `ClaimedMegadrop.total_claimed_lamports`.
    ///
    /// See [`instructions::claim_megadrop`].
    pub fn claim_megadrop(
        ctx: Context<ClaimMegadrop>,
        args: ClaimMegadropArgs,
    ) -> Result<()> {
        instructions::claim_megadrop::handler(ctx, args)
    }
}
