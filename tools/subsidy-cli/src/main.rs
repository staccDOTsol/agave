//! Two subcommands:
//!
//!   - `init`              : runs `init_subsidy` once. SubsidyConfig + ValidatorRegistry PDAs.
//!   - `register-validator`: appends a validator pubkey to the registry.
//!
//! Both ixs are gated on the staccana ADMIN_AUTHORITY (= upgrade-authority key).
//! Same Anchor-1.x discriminator + borsh wire as the on-chain program; we
//! avoid pulling the program crate as a dep so this binary stays small and
//! decoupled from anchor-lang's heavy compile.

use anyhow::{anyhow, Context};
use borsh::BorshSerialize;
use clap::{Parser, Subcommand};
use sha2::{Digest, Sha256};
use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{read_keypair_file, Signer},
    system_program,
    sysvar::instructions::ID as SYSVAR_INSTRUCTIONS_ID,
    transaction::Transaction,
};
use std::{path::PathBuf, str::FromStr};

const SUBSIDY_PROGRAM_ID: &str = "Subsidy111111111111111111111111111111111111";

#[derive(Parser)]
struct Cli {
    /// Fee payer + signer (must be the program's ADMIN_AUTHORITY for `init`,
    /// must be `subsidy_config.governance` for `register-validator`).
    #[arg(long)]
    keypair: PathBuf,

    /// RPC URL.
    #[arg(long, default_value = "http://localhost:8899")]
    rpc: String,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// One-shot init of `SubsidyConfig` + `ValidatorRegistry`.
    Init {
        /// Governance pubkey to bind into SubsidyConfig (later signer for
        /// register/stake/unstake). Defaults to the keypair's pubkey.
        #[arg(long)]
        governance: Option<String>,

        /// Bridge program ID (read from /etc/staccana/program-ids.json or pass
        /// LA7h3hjvD62MeTtdeE4h2vq3EGxbU1oqzHtewp4xb9b for the live deploy).
        #[arg(long)]
        bridge_program_id: String,

        /// Productive vault account (placeholder OK in v1 — no productive
        /// position yet).
        #[arg(long, default_value = "11111111111111111111111111111111")]
        productive_vault: String,

        /// Bridge `asset_id` (u32) of the productive position. Placeholder
        /// 0 OK in v1 since no productive position is wired yet.
        #[arg(long, default_value_t = 0u32)]
        productive_asset_id: u32,

        /// Total treasury lamports the bootstrap-reserve math is sized
        /// against. Defaults to the actual on-chain balance of the
        /// program's treasury PDA at init time.
        #[arg(long)]
        treasury_total: Option<u64>,

        /// Federation members JSON ({ threshold: M, pubkeys: [...] }).
        #[arg(long)]
        federation: PathBuf,
    },

    /// Append a validator identity pubkey to the registry.
    RegisterValidator {
        /// Validator identity pubkey.
        #[arg(long)]
        validator: String,
    },

    /// Remove a validator identity pubkey from the registry. Closes the
    /// per-validator `ValidatorRecord` PDA and refunds rent to the signer.
    UnregisterValidator {
        /// Validator identity pubkey.
        #[arg(long)]
        validator: String,
    },
}

#[derive(BorshSerialize)]
struct UnregisterValidatorArgs {
    validator: [u8; 32],
}

#[derive(BorshSerialize)]
struct InitSubsidyArgs {
    governance: [u8; 32],
    bridge_program_id: [u8; 32],
    productive_vault: [u8; 32],
    productive_asset_id: u32, // bridge asset_id, NOT a pubkey
    treasury_total: u64,
    federation_m: u8,         // threshold first per on-chain struct order
    federation_n: u8,         // member count second
    federation_members: Vec<[u8; 32]>,
}

#[derive(BorshSerialize)]
struct RegisterValidatorArgs {
    validator: [u8; 32],
}

#[derive(serde::Deserialize)]
struct FederationFile {
    threshold: u8,
    pubkeys: Vec<String>,
}

fn discriminator(name: &str) -> [u8; 8] {
    let mut h = Sha256::new();
    h.update(format!("global:{name}").as_bytes());
    let r = h.finalize();
    let mut out = [0u8; 8];
    out.copy_from_slice(&r[..8]);
    out
}

fn pda(seeds: &[&[u8]], program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program_id).0
}

fn pubkey_arr(s: &str) -> anyhow::Result<[u8; 32]> {
    Ok(Pubkey::from_str(s)?.to_bytes())
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let payer =
        read_keypair_file(&cli.keypair).map_err(|e| anyhow!("read keypair {}: {}", cli.keypair.display(), e))?;
    let program_id = Pubkey::from_str(SUBSIDY_PROGRAM_ID)?;
    let rpc = RpcClient::new_with_commitment(cli.rpc.clone(), CommitmentConfig::confirmed());

    eprintln!("[subsidy-cli] program: {}", program_id);
    eprintln!("[subsidy-cli] payer:   {}", payer.pubkey());
    eprintln!("[subsidy-cli] rpc:     {}", cli.rpc);

    match cli.cmd {
        Cmd::Init {
            governance,
            bridge_program_id,
            productive_vault,
            productive_asset_id,
            treasury_total,
            federation,
        } => {
            let governance = match governance {
                Some(g) => Pubkey::from_str(&g)?,
                None => payer.pubkey(),
            };
            let fed: FederationFile = serde_json::from_slice(
                &std::fs::read(&federation).context("read federation file")?,
            )?;
            let federation_n = fed.pubkeys.len() as u8;
            let federation_m = fed.threshold;
            anyhow::ensure!(
                federation_m > 0 && federation_n >= federation_m,
                "federation: threshold {} > member count {}",
                federation_m,
                federation_n
            );
            let federation_members = fed
                .pubkeys
                .iter()
                .map(|p| pubkey_arr(p))
                .collect::<anyhow::Result<Vec<_>>>()?;

            let cfg_pda = pda(&[b"subsidy_config"], &program_id);
            let reg_pda = pda(&[b"validator_registry"], &program_id);
            let treasury_pda = pda(&[b"treasury"], &program_id);

            let treasury_total = match treasury_total {
                Some(t) => t,
                None => rpc.get_balance(&treasury_pda).unwrap_or(0),
            };
            eprintln!("[subsidy-cli] subsidy_config:    {}", cfg_pda);
            eprintln!("[subsidy-cli] validator_registry:{}", reg_pda);
            eprintln!("[subsidy-cli] treasury_pda:      {}", treasury_pda);
            eprintln!("[subsidy-cli] governance:        {}", governance);
            eprintln!("[subsidy-cli] bridge_program_id: {}", bridge_program_id);
            eprintln!("[subsidy-cli] treasury_total:    {} lamports", treasury_total);
            eprintln!(
                "[subsidy-cli] federation:        {}-of-{}",
                federation_m, federation_n
            );

            let args = InitSubsidyArgs {
                governance: governance.to_bytes(),
                bridge_program_id: pubkey_arr(&bridge_program_id)?,
                productive_vault: pubkey_arr(&productive_vault)?,
                productive_asset_id,
                treasury_total,
                federation_m,
                federation_n,
                federation_members,
            };
            let mut data = discriminator("init_subsidy").to_vec();
            args.serialize(&mut data)?;

            let ix = Instruction {
                program_id,
                accounts: vec![
                    AccountMeta::new(payer.pubkey(), true), // authority [signer, writable]
                    AccountMeta::new(cfg_pda, false),       // subsidy_config (init)
                    AccountMeta::new(reg_pda, false),       // validator_registry (init)
                    AccountMeta::new_readonly(system_program::ID, false),
                ],
                data,
            };

            let bh = rpc.get_latest_blockhash()?;
            let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], bh);
            eprintln!("[subsidy-cli] sending init_subsidy tx…");
            let sig = rpc.send_and_confirm_transaction(&tx)?;
            println!("[done] {}", sig);
            println!("subsidy_config:     {}", cfg_pda);
            println!("validator_registry: {}", reg_pda);
        }
        Cmd::RegisterValidator { validator } => {
            let validator_pk = Pubkey::from_str(&validator)?;
            let cfg_pda = pda(&[b"subsidy_config"], &program_id);
            let reg_pda = pda(&[b"validator_registry"], &program_id);
            let rec_pda = pda(&[b"validator", validator_pk.as_ref()], &program_id);
            eprintln!("[subsidy-cli] validator:          {}", validator_pk);
            eprintln!("[subsidy-cli] validator_record:   {}", rec_pda);

            let args = RegisterValidatorArgs {
                validator: validator_pk.to_bytes(),
            };
            let mut data = discriminator("register_validator").to_vec();
            args.serialize(&mut data)?;

            let ix = Instruction {
                program_id,
                accounts: vec![
                    AccountMeta::new(payer.pubkey(), true),    // authority [signer, writable]
                    AccountMeta::new_readonly(cfg_pda, false), // subsidy_config
                    AccountMeta::new(reg_pda, false),          // validator_registry
                    AccountMeta::new(rec_pda, false),          // validator_record (init)
                    AccountMeta::new_readonly(system_program::ID, false),
                ],
                data,
            };

            let bh = rpc.get_latest_blockhash()?;
            let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], bh);
            eprintln!("[subsidy-cli] sending register_validator tx…");
            let sig = rpc.send_and_confirm_transaction(&tx)?;
            println!("[done] {}", sig);
            println!("validator_record: {}", rec_pda);
        }
        Cmd::UnregisterValidator { validator } => {
            let validator_pk = Pubkey::from_str(&validator)?;
            let cfg_pda = pda(&[b"subsidy_config"], &program_id);
            let reg_pda = pda(&[b"validator_registry"], &program_id);
            let rec_pda = pda(&[b"validator", validator_pk.as_ref()], &program_id);
            eprintln!("[subsidy-cli] validator:          {}", validator_pk);
            eprintln!("[subsidy-cli] validator_record:   {}", rec_pda);

            let args = UnregisterValidatorArgs {
                validator: validator_pk.to_bytes(),
            };
            let mut data = discriminator("unregister_validator").to_vec();
            args.serialize(&mut data)?;

            let ix = Instruction {
                program_id,
                accounts: vec![
                    AccountMeta::new(payer.pubkey(), true), // authority (signer + rent recipient)
                    AccountMeta::new_readonly(cfg_pda, false), // subsidy_config
                    AccountMeta::new(reg_pda, false),       // validator_registry (mut for slot mutation)
                    AccountMeta::new(rec_pda, false),       // validator_record (mut + close)
                ],
                data,
            };

            let bh = rpc.get_latest_blockhash()?;
            let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], bh);
            eprintln!("[subsidy-cli] sending unregister_validator tx…");
            let sig = rpc.send_and_confirm_transaction(&tx)?;
            println!("[done] {}", sig);
            println!("closed validator_record: {}", rec_pda);
        }
    }
    let _ = SYSVAR_INSTRUCTIONS_ID; // keep the unused-import lint quiet for future flows
    Ok(())
}
