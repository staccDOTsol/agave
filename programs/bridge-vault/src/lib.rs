//! Mainnet-side bridge vault program.
//!
//! Counterpart to `programs/bridge` (the staccana-side wrapper-mint program). This
//! program runs on **Solana mainnet** (or devnet for testing). It is the custody +
//! settlement layer for the bridge:
//!
//! - **Mainnet → staccana**: user calls [`instructions::deposit`] to lock underlying
//!   (or wrap native SOL into the vault for wSOL). The vault emits a `Deposit` event;
//!   the federation observes it, signs M-of-N, publishes a mint attestation that the
//!   staccana-side bridge consumes.
//! - **Staccana → mainnet**: user burns wrapper tokens on staccana, the federation
//!   observes the staccana-side `BurnEvent`, signs M-of-N, and the user (or a relayer)
//!   submits the resulting release attestation here via
//!   [`instructions::release_with_attestation`]. This program verifies the signatures
//!   over the canonical release-message bytes, transfers the locked underlying to the
//!   attested mainnet recipient, and marks the staccana-side outbound nonce as
//!   consumed (replay protection).
//!
//! Per-asset support mirrors the staccana side:
//!
//! - **wSOL** — vault holds native mainnet SOL; R fixed at 1.0 (`AssetFlag::R_LOCKED`);
//!   no `underlying_mint`.
//! - **stSOL** — vault holds an LST mint (e.g. pSYRUP); R accrues via federation
//!   `update_ratio` (not implemented in v1 of this crate — R lives staccana-side and
//!   the release-attestation already encodes the post-R underlying amount).
//! - **ssUSDC** — vault holds USDC; same shape as stSOL.
//!
//! ## Wire format compatibility
//!
//! The on-chain effects must be byte-compatible with what the staccana-side bridge
//! emits on `burn`. The release-attestation payload mirrors the structure of the
//! mint-attestation on the staccana side ([`crate::attestation::build_release_message`]
//! mirrors `build_mint_message`), with a distinct domain prefix
//! (`"MAINNET_RELEASE_V1"`) so a mint attestation can never replay as a release and
//! vice-versa. See SPEC §"Replay protection" — every attestation commits to
//! `(chain_id, asset_id, nonce)` and a domain prefix.

use anchor_lang::prelude::*;

pub mod attestation;
pub mod ed25519;
pub mod error;
pub mod instructions;
pub mod state;

pub use error::VaultError;
pub use instructions::*;

// Placeholder program ID. The deploy script writes the real devnet ID into
// `/etc/staccana/bridge-vault-devnet-id.txt` after the first deploy; mainnet swaps to
// a vanity address pre-launch.
declare_id!("VauLt11111111111111111111111111111111111111");

#[program]
pub mod staccana_bridge_vault {
    use super::*;

    /// Governance one-shot: register a new asset's vault account. Initializes the
    /// per-asset [`state::VaultConfig`] PDA, the inbound deposit nonce counter, and
    /// (on first call) the global federation set. See [`instructions::init_vault`].
    pub fn init_vault(ctx: Context<InitVault>, args: InitVaultArgs) -> Result<()> {
        instructions::init_vault::handler(ctx, args)
    }

    /// User locks `amount` of underlying (or native SOL for wSOL) into the vault and
    /// declares a destination on staccana. Increments the per-asset deposit nonce and
    /// emits a `DepositEvent` for the federation to observe. See
    /// [`instructions::deposit`].
    pub fn deposit(ctx: Context<Deposit>, args: DepositArgs) -> Result<()> {
        instructions::deposit::handler(ctx, args)
    }

    /// Verify M-of-N federation signatures over a release attestation and transfer
    /// `release_amount` of underlying to the attested mainnet recipient. The staccana
    /// outbound nonce is recorded in a marker PDA so the same attestation cannot be
    /// replayed. See [`instructions::release_with_attestation`].
    pub fn release_with_attestation(
        ctx: Context<ReleaseWithAttestation>,
        args: ReleaseArgs,
    ) -> Result<()> {
        instructions::release_with_attestation::handler(ctx, args)
    }
}
