//! CLI argument parsing and top-level [`run`] entrypoint.
//!
//! Kept in the library (rather than `main.rs`) so integration tests can drive
//! the whole pipeline through the same code path the binary uses.

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, ValueEnum};
use staccana_genesis::{build_genesis, GenesisOutput};

use crate::mock::MockSnapshot;
use crate::output::{write_to_path, OutputFormat};
use crate::solana::SolanaSnapshot;
use crate::source::SnapshotSource;

/// `staccana-snapshot-fork` CLI args.
#[derive(Parser, Clone, Debug)]
#[command(
    name = "staccana-snapshot-fork",
    about = "Partition a Solana mainnet snapshot into the Staccana genesis output (Merkle root + treasury + classic defaults).",
    version
)]
pub struct Args {
    /// Path to the snapshot input. For `--source mock`, a JSON fixture (see
    /// `crate::mock` docs). For `--source solana`, a `.tar.zst` snapshot
    /// archive — see `crate::solana` for the resource cost on mainnet.
    #[arg(long)]
    pub snapshot: PathBuf,

    /// Path to write the resulting `GenesisOutput` to.
    #[arg(long)]
    pub output: PathBuf,

    /// Output encoding.
    #[arg(long, value_enum, default_value_t = Format::Json)]
    pub format: Format,

    /// Snapshot source implementation.
    #[arg(long, value_enum, default_value_t = SourceKind::Mock)]
    pub source: SourceKind,
}

/// Output format flag, exposed as a clap-friendly enum so the help text
/// renders the variants automatically.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
#[clap(rename_all = "lowercase")]
pub enum Format {
    Json,
    Bincode,
}

impl From<Format> for OutputFormat {
    fn from(f: Format) -> Self {
        match f {
            Format::Json => OutputFormat::Json,
            Format::Bincode => OutputFormat::Bincode,
        }
    }
}

/// Snapshot source flag.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
#[clap(rename_all = "lowercase")]
pub enum SourceKind {
    /// JSON fixture (see [`crate::mock`]).
    Mock,
    /// Real `.tar.zst` Solana snapshot (see [`crate::solana`]).
    Solana,
}

/// Construct the appropriate [`SnapshotSource`] for the chosen flag.
pub fn build_source(kind: SourceKind, snapshot: PathBuf) -> Box<dyn SnapshotSource> {
    match kind {
        SourceKind::Mock => Box::new(MockSnapshot::new(snapshot)),
        SourceKind::Solana => Box::new(SolanaSnapshot::new(snapshot)),
    }
}

/// End-to-end pipeline. Loads accounts, partitions them, writes the result.
pub fn run(args: Args) -> Result<RunReport> {
    let source = build_source(args.source, args.snapshot);
    let accounts = source.accounts()?;
    let output = build_genesis(accounts);
    let format: OutputFormat = args.format.into();
    write_to_path(&output, &args.output, format)?;
    Ok(RunReport {
        output,
        output_path: args.output,
        format,
    })
}

/// Summary of a successful [`run`] — useful for the binary's stdout log and
/// for integration tests that want to assert on what was produced.
#[derive(Debug)]
pub struct RunReport {
    pub output: GenesisOutput,
    pub output_path: PathBuf,
    pub format: OutputFormat,
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_program::pubkey::Pubkey;
    use staccana_genesis::SYSTEM_PROGRAM_ID;
    use std::io::Write;

    fn b58(bytes: [u8; 32]) -> String {
        bs58::encode(bytes).into_string()
    }

    fn pk(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte; 32])
    }

    fn write_json_fixture(records: &[(Pubkey, Pubkey, u64, u64)]) -> tempfile::NamedTempFile {
        let mut s = String::from("[\n");
        for (i, (p, owner, data_len, lamports)) in records.iter().enumerate() {
            if i > 0 {
                s.push_str(",\n");
            }
            s.push_str(&format!(
                "  {{\"pubkey\":\"{}\",\"owner\":\"{}\",\"data_len\":{},\"lamports\":{}}}",
                b58(p.to_bytes()),
                b58(owner.to_bytes()),
                data_len,
                lamports
            ));
        }
        s.push_str("\n]\n");
        let mut f = tempfile::Builder::new()
            .suffix(".json")
            .tempfile()
            .expect("tempfile");
        f.write_all(s.as_bytes()).expect("write fixture");
        f
    }

    fn out_tempfile(suffix: &str) -> tempfile::NamedTempFile {
        tempfile::Builder::new()
            .suffix(suffix)
            .tempfile()
            .expect("tempfile")
    }

    #[test]
    fn end_to_end_via_mock_json_json_format() {
        // Three claimable EOAs (system-owned, zero data) and two treasury
        // accounts (token program-owned, has data).
        let token_program = pk(99);
        let fixture = write_json_fixture(&[
            (pk(1), SYSTEM_PROGRAM_ID, 0, 1_000_000_000),
            (pk(2), SYSTEM_PROGRAM_ID, 0, 2_000_000_000),
            (pk(3), token_program, 165, 2_039_280),
            (pk(4), token_program, 165, 2_039_280),
            (pk(5), SYSTEM_PROGRAM_ID, 0, 500_000_000),
        ]);
        let out_file = out_tempfile(".json");
        let args = Args {
            snapshot: fixture.path().to_path_buf(),
            output: out_file.path().to_path_buf(),
            format: Format::Json,
            source: SourceKind::Mock,
        };

        let report = run(args).expect("pipeline succeeds");

        // Partition routing.
        assert_eq!(report.output.claimable_count, 3);
        assert_eq!(report.output.treasury.account_count(), 2);
        assert_eq!(
            report.output.treasury.total_lamports(),
            2 * 2_039_280
        );
        // Classic defaults survived.
        assert!(report.output.inflation_disabled);
        assert_eq!(report.output.fee_governor.burn_percent, 50);
        assert_eq!(
            report.output.fee_governor.min_lamports_per_signature,
            27_000_000
        );

        // The output file was written and is parseable.
        let bytes = std::fs::read(out_file.path()).expect("read output");
        let dto = crate::output::decode(&bytes, OutputFormat::Json).expect("decode");
        assert_eq!(dto.claimable_count, 3);
        assert_eq!(dto.treasury.total_lamports(), 2 * 2_039_280);
    }

    #[test]
    fn end_to_end_via_mock_json_bincode_format() {
        let fixture = write_json_fixture(&[
            (pk(10), SYSTEM_PROGRAM_ID, 0, 100),
            (pk(11), SYSTEM_PROGRAM_ID, 0, 200),
            (pk(12), pk(99), 1, 50),
        ]);
        let out_file = out_tempfile(".bincode");
        let args = Args {
            snapshot: fixture.path().to_path_buf(),
            output: out_file.path().to_path_buf(),
            format: Format::Bincode,
            source: SourceKind::Mock,
        };

        let report = run(args).expect("pipeline succeeds");
        assert_eq!(report.output.claimable_count, 2);
        assert_eq!(report.output.treasury.account_count(), 1);
        assert_eq!(report.output.treasury.total_lamports(), 50);

        let bytes = std::fs::read(out_file.path()).expect("read");
        let dto = crate::output::decode(&bytes, OutputFormat::Bincode).expect("decode");
        assert_eq!(dto.claimable_count, 2);
    }

    #[test]
    fn solana_source_errors_clearly_when_archive_missing() {
        // We don't have a real snapshot fixture to test against in unit tests,
        // but we can confirm the source surfaces a clear error for a missing
        // archive — which is the most common operator misconfiguration.
        let out_file = out_tempfile(".bincode");
        let args = Args {
            snapshot: PathBuf::from("/nonexistent/snapshot-fork-test/snapshot.tar.zst"),
            output: out_file.path().to_path_buf(),
            format: Format::Bincode,
            source: SourceKind::Solana,
        };
        let err = run(args).unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("not found"), "got: {msg}");
    }

    #[test]
    fn args_parse_with_defaults() {
        let parsed = Args::try_parse_from([
            "staccana-snapshot-fork",
            "--snapshot",
            "/tmp/s.json",
            "--output",
            "/tmp/o.json",
        ])
        .expect("parse");
        assert_eq!(parsed.snapshot, PathBuf::from("/tmp/s.json"));
        assert_eq!(parsed.output, PathBuf::from("/tmp/o.json"));
        assert_eq!(parsed.format, Format::Json);
        assert_eq!(parsed.source, SourceKind::Mock);
    }

    #[test]
    fn args_parse_with_explicit_flags() {
        let parsed = Args::try_parse_from([
            "staccana-snapshot-fork",
            "--snapshot",
            "/tmp/s.tar.zst",
            "--output",
            "/tmp/o.bin",
            "--format",
            "bincode",
            "--source",
            "solana",
        ])
        .expect("parse");
        assert_eq!(parsed.format, Format::Bincode);
        assert_eq!(parsed.source, SourceKind::Solana);
    }
}
