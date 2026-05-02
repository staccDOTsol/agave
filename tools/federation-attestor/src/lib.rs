//! Library entry for the staccana federation-attestor daemon.
//!
//! A federation member runs this daemon to perform three duties:
//!
//! 1. **Observe** the mainnet vault for `Deposit` events and the staccana bridge for `Burn`
//!    events (see [`observer`]). v0 ships a stub here — the real implementation needs a
//!    websocket subscription via `solana-pubsub-client` filtered by program id.
//! 2. **Sign** ratio attestations whose byte layout is locked by SPEC §5.3 (see [`sign`]).
//!    This module is wire-format-critical and is pure / unit-tested.
//! 3. **Publish** the signed `R` update to the staccana bridge program every
//!    `R_PUBLISH_INTERVAL_SLOTS` slots (~1 minute) by submitting an `update_ratio`
//!    instruction (see [`publish`]). v0 stubs the network round-trip but constructs the
//!    instruction body in spec-conformant form.
//!
//! Configuration lives in [`config`] and is loaded from a TOML file on disk. The
//! single-binary tokio entrypoint is in `main.rs` — that file is intentionally thin so the
//! library surface here is what matters for tests.
//!
//! ## What is *not* in v0
//!
//! - Real-time WebSocket subscriptions (stubbed in [`observer`])
//! - Inter-member gossip / signature aggregation (stubbed; v0 produces a single-member
//!   signature locally)
//! - Federation pubkey-set rotation handling (out of scope)
//!
//! See each module's doc comment for what shipping that piece will require.

pub mod config;
pub mod observer;
pub mod publish;
pub mod sign;

pub use config::{AttestorConfig, ConfigError};
pub use observer::{BurnEvent, DepositEvent, Observer, ObserverError};
pub use publish::{build_update_ratio_ix, publish_attestation, PublishError, UpdateRatioArgs};
pub use sign::{
    build_attestation_message, sign_attestation, verify_attestation, AttestationInputs,
    SignedAttestation, ATTESTATION_DOMAIN, ATTESTATION_LEN,
};
