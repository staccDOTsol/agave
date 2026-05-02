//! `staccana-snapshot-fork` — read a Solana mainnet snapshot, partition every
//! account through [`staccana_genesis`], and emit a serializable
//! `GenesisOutput`.
//!
//! Layout:
//!
//! * [`source`] — the [`SnapshotSource`](source::SnapshotSource) trait and
//!   the [`AccountRecord`](source::AccountRecord) DTO that implements
//!   [`staccana_genesis::Account`].
//! * [`mock`] — JSON-fixture source used for tests and the dev loop.
//! * [`solana`] — stub for the real `solana-runtime` / `solana-accounts-db`
//!   integration. See its module docs for the wiring plan.
//! * [`output`] — JSON / bincode encoding of `GenesisOutput`.
//! * [`cli`] — argument parsing + the `run` entrypoint shared by `main.rs`
//!   and integration tests.
//!
//! ## Pipeline
//!
//! ```text
//! SnapshotSource::accounts() ─┐
//!                             ├─► build_genesis() ─► GenesisOutput ─► output::write_to_path()
//! AccountRecord ──────────────┘
//! ```
//!
//! End-to-end smoke tests of the whole pipeline live in `cli::tests`.

pub mod cli;
pub mod mock;
pub mod output;
pub mod solana;
pub mod source;

pub use cli::{run, Args, SourceKind};
pub use output::{decode, encode, write_to_path, OutputFormat, SerializableGenesis};
pub use source::{AccountRecord, SnapshotSource};
