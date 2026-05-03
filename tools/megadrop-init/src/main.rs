//! `staccana-megadrop-init` — one-shot CLI to invoke the megadrop program's
//! `init_megadrop` instruction, creating the singleton `MegadropConfig` PDA.
//!
//! After step 40 deploys the megadrop .so, the on-chain config still has to be
//! initialized once before any user can claim. This binary does that — pass the
//! deployed program ID + the genesis month + the snapshot Merkle root + the
//! treasury authority, and it sends a single tx as the `--keypair` signer.
//!
//! For tonight's devnet shake-out the snapshot Merkle root can be all-zero
//! (`--placeholder-root`); the on-chain validator only checks plausibility of
//! `genesis_month` and that `total_allocation_lamports > 0`. Real allocation
//! data lands in a follow-up `init_megadrop` re-run with the real root once
//! `tools/megadrop-snapshot` has produced it (the program's `init_megadrop`
//! instruction creates the PDA — it's a one-shot, so for re-init you'd close
//! and re-create, or land a `update_megadrop` ix in v1.1).
//!
//! Usage:
//!   staccana-megadrop-init \
//!     --keypair /etc/staccana/keys/identity.json \
//!     --rpc http://localhost:8899 \
//!     --program-id Aicff1zk6b5ifYzFoyhenUD5ehhFYb8GiDbRCrWt9t34 \
//!     --treasury-authority <pubkey> \
//!     --genesis-month 202605 \
//!     --total-allocation-sol 30000000 \
//!     --placeholder-root

use std::path::PathBuf;
use std::str::FromStr;

use anyhow::{anyhow, Context, Result};
use borsh::BorshSerialize;
use clap::Parser;
use sha2::{Digest, Sha256};
use solana_client::rpc_client::RpcClient;
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{read_keypair_file, Signer};
use solana_sdk::system_program;
use solana_sdk::transaction::Transaction;

/// Anchor instruction discriminator: first 8 bytes of sha256("global:init_megadrop").
fn init_megadrop_discriminator() -> [u8; 8] {
    let mut h = Sha256::new();
    h.update(b"global:init_megadrop");
    let out = h.finalize();
    let mut d = [0u8; 8];
    d.copy_from_slice(&out[..8]);
    d
}

/// Borsh-equivalent layout of `InitMegadropArgs` per
/// `programs/megadrop/src/instructions/init_megadrop.rs`.
#[derive(BorshSerialize)]
struct InitMegadropArgs {
    claimable_root: [u8; 32],
    genesis_month: u32,
    total_allocation_lamports: u64,
    treasury_authority: [u8; 32],
}

/// `["megadrop_config"]` PDA seed, matches `programs/megadrop/src/state.rs::MEGADROP_CONFIG_SEED`.
const MEGADROP_CONFIG_SEED: &[u8] = b"megadrop_config";

#[derive(Parser, Debug)]
#[command(name = "staccana-megadrop-init", about = "init MegadropConfig PDA on-chain")]
struct Cli {
    /// Fee payer + authority for the init ix.
    #[arg(long)]
    keypair: PathBuf,

    /// RPC URL (e.g. http://localhost:8899 or https://rpc.mp.fun).
    #[arg(long, default_value = "http://localhost:8899")]
    rpc: String,

    /// Deployed megadrop program ID (from /etc/staccana/program-ids.json).
    #[arg(long)]
    program_id: String,

    /// Treasury authority PDA (signer for treasury debits during claim). Typically the
    /// validator-subsidy program's treasury PDA, or a governance multisig.
    #[arg(long)]
    treasury_authority: String,

    /// Genesis month, ISO yyyymm (e.g. 202605 = May 2026).
    #[arg(long, default_value_t = 202605)]
    genesis_month: u32,

    /// Total megadrop allocation in SOL (gets multiplied by 1_000_000_000 for lamports).
    /// docs/MEGADROP.md locks this at 30M for the v1 design.
    #[arg(long, default_value_t = 30_000_000)]
    total_allocation_sol: u64,

    /// Use an all-zero placeholder Merkle root. For tonight's devnet only — replace
    /// with `--root <hex>` once `tools/megadrop-snapshot` has produced the real root.
    #[arg(long, conflicts_with = "root")]
    placeholder_root: bool,

    /// Hex-encoded 32-byte Merkle root from `tools/megadrop-snapshot`.
    #[arg(long, conflicts_with = "placeholder_root")]
    root: Option<String>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    let payer = read_keypair_file(&cli.keypair)
        .map_err(|e| anyhow!("reading keypair {}: {}", cli.keypair.display(), e))?;
    let program_id = Pubkey::from_str(&cli.program_id).context("parsing --program-id")?;
    let treasury_authority =
        Pubkey::from_str(&cli.treasury_authority).context("parsing --treasury-authority")?;

    let claimable_root: [u8; 32] = if cli.placeholder_root {
        eprintln!("[init] WARNING: using all-zero placeholder Merkle root. Re-init with the real root before mainnet.");
        [0u8; 32]
    } else {
        let hex = cli
            .root
            .ok_or_else(|| anyhow!("must pass either --root <hex> or --placeholder-root"))?;
        let bytes = hex::decode(hex.trim_start_matches("0x"))
            .context("decoding --root hex")?;
        if bytes.len() != 32 {
            return Err(anyhow!("--root must be exactly 32 bytes (got {})", bytes.len()));
        }
        let mut r = [0u8; 32];
        r.copy_from_slice(&bytes);
        r
    };

    let total_allocation_lamports = cli
        .total_allocation_sol
        .checked_mul(1_000_000_000)
        .ok_or_else(|| anyhow!("--total-allocation-sol overflow"))?;

    let (megadrop_config, _bump) =
        Pubkey::find_program_address(&[MEGADROP_CONFIG_SEED], &program_id);

    eprintln!("[init] megadrop program:    {}", program_id);
    eprintln!("[init] MegadropConfig PDA:  {}", megadrop_config);
    eprintln!("[init] payer / authority:   {}", payer.pubkey());
    eprintln!("[init] treasury authority:  {}", treasury_authority);
    eprintln!("[init] genesis_month:       {}", cli.genesis_month);
    eprintln!(
        "[init] total allocation:    {} lamports ({} SOL)",
        total_allocation_lamports, cli.total_allocation_sol
    );
    eprintln!("[init] claimable_root:      0x{}", hex::encode(claimable_root));

    // Build instruction data: 8-byte discriminator + Borsh(InitMegadropArgs)
    let args = InitMegadropArgs {
        claimable_root,
        genesis_month: cli.genesis_month,
        total_allocation_lamports,
        treasury_authority: treasury_authority.to_bytes(),
    };
    let mut data = Vec::with_capacity(8 + 32 + 4 + 8 + 32);
    data.extend_from_slice(&init_megadrop_discriminator());
    args.serialize(&mut data).context("borsh-serialize args")?;

    let accounts = vec![
        AccountMeta::new(payer.pubkey(), true),         // authority (signer, writable)
        AccountMeta::new(megadrop_config, false),       // megadrop_config (PDA, writable)
        AccountMeta::new_readonly(system_program::id(), false), // system_program
    ];

    let ix = Instruction { program_id, accounts, data };

    let rpc = RpcClient::new_with_commitment(cli.rpc.clone(), CommitmentConfig::confirmed());
    let blockhash = rpc.get_latest_blockhash().context("get_latest_blockhash")?;
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], blockhash);

    eprintln!("[init] sending tx...");
    let sig = rpc
        .send_and_confirm_transaction(&tx)
        .context("send_and_confirm_transaction (already initialized? close + retry)")?;
    eprintln!("[init] confirmed: {}", sig);
    println!("MegadropConfig PDA initialized: {}", megadrop_config);
    Ok(())
}
