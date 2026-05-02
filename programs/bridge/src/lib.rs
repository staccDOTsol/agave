//! Staccana-side bridge program.
//!
//! Exposes four instructions implementing the staccana side of the asynchronous,
//! federation-attested, non-1:1 bridge between mainnet vaults and Token-22 wrapper
//! mints on staccana. See `docs/SPEC.md` §5 for the normative wire formats and
//! `docs/BRIDGE.md` for the surrounding architecture.
//!
//! Module layout:
//!
//! - [`state`] — `AssetConfig`, `RatioState`, `FederationSet`, marker PDAs
//! - [`error`] — typed `BridgeError` codes
//! - [`attestation`] — pure helpers for R math and message construction (unit-tested)
//! - [`ed25519`] — Instructions-sysvar reader for verifying federation precompile sigs
//! - [`instructions`] — handler modules for each ix
//!
//! Instructions:
//!
//! 1. `register_asset` — governance one-shot per asset; bootstraps the federation set
//!    on first call.
//! 2. `update_ratio` — federation publishes a fresh R, gated by an interval and an
//!    M-of-N signature check.
//! 3. `mint` — relay an inbound deposit attestation; mint Token-22 to the recipient.
//! 4. `burn` — user redeems wrapper tokens; emits a `Burn` event for the federation
//!    to relay back to the mainnet vault.
//!
//! Token-22 specifics: the staccana mint for each asset has the Confidential Transfer
//! extension active (set up out-of-band before `register_asset`). Mint authority MUST
//! be the AssetConfig PDA so the bridge can sign for `mint_to` / `burn` CPIs.

use anchor_lang::prelude::*;

pub mod attestation;
pub mod ed25519;
pub mod error;
pub mod instructions;
pub mod state;

pub use error::BridgeError;
pub use instructions::*;

// Placeholder program ID. Replace with the real deployed address before mainnet launch;
// SPEC.md §2.1 lists `BRIDGE_PROGRAM_ID = TBD`.
declare_id!("Bridge1111111111111111111111111111111111111");

#[program]
pub mod staccana_bridge {
    use super::*;

    /// Governance-gated registration of a new bridgeable asset. Initializes
    /// `AssetConfig`, `RatioState` (R = 1.0), `NonceOutCounter`, and bootstraps the
    /// global `FederationSet` on first call. See [`instructions::register_asset`].
    pub fn register_asset(
        ctx: Context<RegisterAsset>,
        args: RegisterAssetArgs,
    ) -> Result<()> {
        instructions::register_asset::handler(ctx, args)
    }

    /// Federation publishes a fresh R for `args.asset_id`. Verifies M ed25519 precompile
    /// sigs over the canonical `STACCANA_RATIO_V1` message, then recomputes and stores
    /// `R_q64`. See [`instructions::update_ratio`].
    pub fn update_ratio(
        ctx: Context<UpdateRatio>,
        args: UpdateRatioArgs,
    ) -> Result<()> {
        instructions::update_ratio::handler(ctx, args)
    }

    /// Relay an inbound (mainnet → staccana) attestation; mint wrapper tokens. Verifies
    /// M federation sigs, applies `mint_fee_bps`, computes mint amount via current R,
    /// CPIs into Token-22 with the AssetConfig PDA as mint authority, then marks the
    /// nonce consumed. See [`instructions::mint`].
    pub fn mint(ctx: Context<BridgeMint>, args: MintArgs) -> Result<()> {
        instructions::mint::handler(ctx, args)
    }

    /// User burns wrapper tokens, redeeming underlying on the mainnet vault. Computes
    /// release amount via current R, applies `burn_fee_bps`, CPIs into Token-22 to
    /// burn from the user's ATA, allocates the next outbound nonce, and emits a
    /// `BurnEvent`. See [`instructions::burn`].
    pub fn burn(ctx: Context<BridgeBurn>, args: BurnArgs) -> Result<()> {
        instructions::burn::handler(ctx, args)
    }
}
