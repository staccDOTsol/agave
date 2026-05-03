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
//!    on first call. Per-asset `flags` opt into special behaviour (e.g. R-locking for
//!    wSOL).
//! 2. `update_ratio` — federation publishes a fresh R, gated by an interval and an
//!    M-of-N signature check. Rejected for R-locked assets.
//! 3. `mint` — relay an inbound deposit attestation; mint Token-22 to the recipient.
//! 4. `burn` — user redeems wrapper tokens; emits a `Burn` event for the federation
//!    to relay back to the mainnet vault.
//! 5. `convert_native_to_wsol` — swap native staccana SOL → wSOL via the on-chain
//!    secret-ray AMM as price oracle. Used by holders exiting native SOL → mainnet
//!    SOL (this ix produces wSOL; the standard `burn` then redeems for mainnet SOL).
//! 6. `convert_wsol_to_native` — mirror: swap wSOL → native staccana SOL via the AMM.
//!    Used by mainnet-SOL inbound flows (`mint` produces wSOL; this ix produces
//!    native SOL).
//!
//! ## wSOL and the native SOL ↔ mainnet SOL flow
//!
//! Per `docs/BRIDGE.md` §"Native SOL ↔ mainnet SOL via the bridge (uncorrelated,
//! AMM-quoted)", the bridge supports a third asset class **wSOL** that is 1:1 mainnet
//! SOL backed with no yield component (R hard-pinned at 1.0 forever via the
//! [`state::AssetFlag::R_LOCKED`] flag). wSOL exists so the secret-ray pool
//! `wSOL ↔ native-SOL` can act as the price oracle for native staccana SOL.
//!
//! **This is not a peg.** Native staccana SOL is intentionally a non-correlated
//! asset; the bridge always quotes at the current AMM rate. Round-trips close at AMM
//! slippage + 2× bridge fees, identical to a direct AMM trade. There is no fixed
//! rate to defend, no UST/LUNA-style death spiral surface — if the chain is "worthless",
//! the AMM rate reflects that and the bridge honors it.
//!
//! Genesis-baked native SOL (485M treasury, lazy-claim airdrops, validator stakes)
//! is **not** directly redeemable. Only newly-locked mainnet SOL backs wSOL; native
//! SOL prices itself via AMM trades against wSOL.
//!
//! Token-22 specifics: the staccana mint for each asset has the Confidential Transfer
//! extension active (set up out-of-band before `register_asset`). Mint authority MUST
//! be the AssetConfig PDA so the bridge can sign for `mint_to` / `burn` CPIs.

use anchor_lang::prelude::*;

pub mod amm_oracle;
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

    /// Convert native staccana SOL to wSOL using the on-chain secret-ray AMM as the
    /// price oracle. Step 1 of the user-facing native-SOL → mainnet-SOL exit path.
    /// See [`instructions::convert_native_to_wsol`].
    pub fn convert_native_to_wsol(
        ctx: Context<ConvertNativeToWsol>,
        args: ConvertNativeToWsolArgs,
    ) -> Result<()> {
        instructions::convert_native_to_wsol::handler(ctx, args)
    }

    /// Convert wSOL to native staccana SOL using the on-chain secret-ray AMM. Step 2
    /// of the mainnet-SOL → native-SOL inbound path. See
    /// [`instructions::convert_wsol_to_native`].
    pub fn convert_wsol_to_native(
        ctx: Context<ConvertWsolToNative>,
        args: ConvertWsolToNativeArgs,
    ) -> Result<()> {
        instructions::convert_wsol_to_native::handler(ctx, args)
    }
}
