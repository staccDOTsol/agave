//! Real Solana snapshot reader — STUB.
//!
//! This module documents what a production snapshot reader needs to do but
//! intentionally does not pull in `solana-runtime` / `solana-accounts-db`.
//! Those crates are huge (compile-time + binary size + transitive dep
//! footprint), and standing them up sensibly requires architectural choices
//! that are out of scope for v0 of the snapshot-fork tool. The
//! [`crate::mock::MockSnapshot`] source covers the dev/test loop in the
//! meantime.
//!
//! ## What the real implementation needs to do
//!
//! Inputs:
//! * Path to a `.tar.zst` snapshot archive (full or incremental). Mainnet
//!   snapshots are typically 50–200 GB after decompression and contain
//!   hundreds of millions of accounts.
//!
//! Pipeline:
//!
//! 1. **Untar + decompress.** Snapshots are `tar.zst`. Use
//!    `solana-runtime::snapshot_utils::{untar_snapshot_in, ArchiveFormat}` or
//!    its modern equivalent. Don't roll a tar reader by hand — Solana ships
//!    fixed quirks (special-cased symlinks, deterministic ordering) that the
//!    util handles.
//!
//! 2. **Parse `bank.fields`.** This file (older: `bank.bin`) is the canonical
//!    bincode dump of `BankFieldsToDeserialize`. We don't actually need the
//!    bank state for partition — only the slot, parent_slot, and the path to
//!    the `accounts/` directory.
//!
//! 3. **Iterate AppendVecs.** Every file in `accounts/` is an AppendVec —
//!    Solana's append-only mmap'd account log. Each has a header followed by
//!    a stream of `StoredAccountMeta` entries. Walk each AppendVec with
//!    `AppendVec::accounts(0)` (or the modern `scan_pubkeys_and_account_data`
//!    streaming API). Multiple AppendVecs may hold different versions of the
//!    same pubkey — we want the **latest** version per pubkey.
//!
//! 4. **Build the latest-version index.** Either:
//!    * Use `AccountsDb::new_with_config` + `generate_index` to let
//!      AccountsDb resolve the latest version per pubkey for us. Heaviest
//!      option but the most correct.
//!    * Or, if we're willing to mirror the logic, walk AppendVecs in
//!      slot-descending order and skip pubkeys we've already seen. Lighter
//!      but easy to get wrong (zero-lamport "tombstone" entries, slot
//!      ordering edge cases at snapshot boundaries).
//!
//! 5. **Project to [`AccountRecord`].** For each (pubkey, latest StoredMeta)
//!    pair: copy out `pubkey`, `owner`, `data_len`, `lamports`, drop the
//!    `data` bytes immediately. This is the hot path — at ~1B accounts the
//!    total throughput is dominated by mmap + memcpy + index lookup, NOT by
//!    the partition logic in `staccana_genesis`. Stream, don't buffer.
//!
//! 6. **Skip zero-lamport accounts?** No. The genesis partition rule does not
//!    have a lamport floor — even a 0-lamport system-owned EOA is technically
//!    "claimable" (though useless to claim). If we want to drop them, that's
//!    a separate post-partition optimization.
//!
//! ## Required crates
//!
//! ```toml
//! solana-runtime = "2"
//! solana-accounts-db = "2"
//! solana-sdk = "2"
//! tar = "0.4"
//! zstd = "0.13"
//! memmap2 = "0.9"
//! ```
//!
//! Pin to whatever `solana-program` workspace version we already use, since
//! these crates pin transitively to each other.
//!
//! ## Hot paths to watch
//!
//! * **Index generation.** `AccountsDb::generate_index` is the main cost.
//!   On a 200 GB snapshot it's typically 30–90 minutes single-threaded;
//!   worth using its parallel mode.
//! * **AppendVec mmap.** OS page cache thrash if you mmap them all at once.
//!   Process AppendVecs in batches; munmap as soon as you're done iterating.
//! * **String allocations.** Don't base58-encode pubkeys in the hot loop —
//!   we're moving raw bytes through to `staccana_genesis`, no strings needed.
//! * **Allocator pressure.** With ~1B accounts, the per-AccountRecord
//!   allocation is dominant. Consider an arena (`bumpalo`) or a streaming
//!   iterator that reuses a single record slot if measurements show heap
//!   pressure.
//!
//! ## Determinism
//!
//! `staccana_genesis::build_genesis` is order-independent (see the
//! `deterministic_under_input_reordering` test in `genesis::builder`), so we
//! don't need to sort the output of this iterator. We just need to make sure
//! we surface each (latest-version) account exactly once.
//!
//! ## Testing the real reader
//!
//! Stand up a minimal Solana test-validator with a known account set, take a
//! snapshot, run snapshot-fork against it, and assert:
//! * total claimable lamports + treasury lamports == sum(snapshot lamports)
//!   (genesis SOL conservation, see `docs/SPEC.md` §I1).
//! * known fixture accounts land in the expected partition.

use anyhow::{bail, Result};
use std::path::{Path, PathBuf};

use crate::source::{AccountRecord, SnapshotSource};

/// Real Solana snapshot reader — not yet implemented.
///
/// Constructible (so the CLI can mention it in `--source` help text), but
/// invoking [`SnapshotSource::accounts`] returns a clear error pointing to
/// this module's docs and to [`MockSnapshot`](crate::mock::MockSnapshot) as
/// the available alternative.
pub struct SolanaSnapshot {
    #[allow(dead_code)] // path is read by the real impl, kept for API stability now.
    path: PathBuf,
}

impl SolanaSnapshot {
    pub fn new(path: impl AsRef<Path>) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
        }
    }
}

impl SnapshotSource for SolanaSnapshot {
    fn account_count_hint(&self) -> Option<usize> {
        // Real impl: peek at the index size from `bank.fields` if available.
        None
    }

    fn accounts(self: Box<Self>) -> Result<Box<dyn Iterator<Item = AccountRecord>>> {
        // TODO(snapshot-fork): wire in the real reader.
        //
        // See module docs for the full pipeline. Sketch:
        //
        // ```ignore
        // let unpacked_dir = solana_runtime::snapshot_utils::untar_snapshot_in(
        //     &self.path,
        //     &tempdir(),
        //     ArchiveFormat::TarZstd,
        // )?;
        // let accounts_dir = unpacked_dir.join("accounts");
        // let appendvecs = enumerate_appendvecs(&accounts_dir)?;
        //
        // // Option A (correct, slow): full AccountsDb.
        // let db = AccountsDb::new_with_config(...)?;
        // db.generate_index(...)?;
        // let iter = db.scan_pubkeys_and_data(|pubkey, account| {
        //     AccountRecord {
        //         pubkey: *pubkey,
        //         owner: *account.owner(),
        //         data_len: account.data().len() as u64,
        //         lamports: account.lamports(),
        //     }
        // });
        //
        // // Option B (lighter): walk AppendVecs by descending slot, skip
        // // already-seen pubkeys.
        // ```
        bail!(
            "SolanaSnapshot is not yet implemented. \
             Use --source mock with a JSON fixture for now. \
             See `staccana_snapshot_fork::solana` module docs for the \
             integration plan and required dependencies."
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constructs_but_iteration_returns_clear_error() {
        // `Box<dyn SnapshotSource>::accounts()` returns
        // `Result<Box<dyn Iterator<...>>, Error>`. The Ok variant doesn't impl Debug, so
        // `unwrap_err()` won't compile under newer rustc. Use a match instead.
        let stub: Box<dyn SnapshotSource> =
            Box::new(SolanaSnapshot::new("/tmp/some-snapshot.tar.zst"));
        let err = match stub.accounts() {
            Ok(_) => panic!("expected SolanaSnapshot stub to error, not yield an iterator"),
            Err(e) => e,
        };
        let msg = format!("{err:#}");
        assert!(msg.contains("not yet implemented"), "got: {msg}");
        assert!(msg.contains("--source mock"), "got: {msg}");
    }
}
