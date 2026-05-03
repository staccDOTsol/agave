//! Ed25519 precompile inspection for federation release-attestation verification.
//!
//! Mirrors `programs/bridge/src/ed25519.rs` byte-for-byte except for the error type. The
//! Solana ed25519 precompile is the cheap, correct way to verify ed25519 signatures
//! from on-chain code: the federation publishes M precompile ixs immediately preceding
//! the `release_with_attestation` ix in the same transaction, and this module reads
//! them back from the Instructions sysvar to confirm what was actually verified.
//!
//! Wire format reference:
//! <https://docs.solanalabs.com/runtime/programs#ed25519-program>

use crate::error::VaultError;
use anchor_lang::prelude::*;
use solana_instructions_sysvar::load_instruction_at_checked;
use solana_sdk_ids::ed25519_program;
use solana_sdk_ids::sysvar::instructions::ID as INSTRUCTIONS_SYSVAR_ID;

const ED25519_HEADER_SIZE: usize = 16;
const ED25519_SIG_LEN: usize = 64;
const ED25519_PUBKEY_LEN: usize = 32;
/// `instruction_index == u16::MAX` means "this same instruction" — required for our
/// usage where the pubkey, signature, and message are all packed into the precompile
/// ix data itself.
const SAME_INSTRUCTION: u16 = u16::MAX;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedEd25519 {
    pub pubkey: [u8; ED25519_PUBKEY_LEN],
    pub signature: [u8; ED25519_SIG_LEN],
    pub message: Vec<u8>,
}

/// Confirm the supplied account is the canonical Instructions sysvar.
pub fn require_instructions_sysvar(account: &AccountInfo) -> Result<()> {
    require_keys_eq!(
        *account.key,
        INSTRUCTIONS_SYSVAR_ID,
        VaultError::BadInstructionsSysvar
    );
    Ok(())
}

/// Decode a single-signature ed25519 precompile ix from the Instructions sysvar at
/// `index`. See `programs/bridge/src/ed25519.rs` for the full layout commentary —
/// kept in lockstep with that module.
pub fn parse_ed25519_at(
    sysvar: &AccountInfo,
    index: usize,
) -> std::result::Result<ParsedEd25519, VaultError> {
    let ix = load_instruction_at_checked(index, sysvar)
        .map_err(|_| VaultError::BadEd25519Precompile)?;
    if ix.program_id != ed25519_program::ID {
        return Err(VaultError::BadEd25519Precompile);
    }

    let data = ix.data.as_slice();
    if data.len() < ED25519_HEADER_SIZE {
        return Err(VaultError::BadEd25519Precompile);
    }

    let num_signatures = data[0];
    if num_signatures != 1 {
        return Err(VaultError::BadEd25519Precompile);
    }

    let sig_offset = u16::from_le_bytes([data[2], data[3]]) as usize;
    let sig_ix_index = u16::from_le_bytes([data[4], data[5]]);
    let pk_offset = u16::from_le_bytes([data[6], data[7]]) as usize;
    let pk_ix_index = u16::from_le_bytes([data[8], data[9]]);
    let msg_offset = u16::from_le_bytes([data[10], data[11]]) as usize;
    let msg_size = u16::from_le_bytes([data[12], data[13]]) as usize;
    let msg_ix_index = u16::from_le_bytes([data[14], data[15]]);

    if sig_ix_index != SAME_INSTRUCTION
        || pk_ix_index != SAME_INSTRUCTION
        || msg_ix_index != SAME_INSTRUCTION
    {
        return Err(VaultError::BadEd25519Precompile);
    }

    let sig_end = sig_offset
        .checked_add(ED25519_SIG_LEN)
        .ok_or(VaultError::BadEd25519Precompile)?;
    let pk_end = pk_offset
        .checked_add(ED25519_PUBKEY_LEN)
        .ok_or(VaultError::BadEd25519Precompile)?;
    let msg_end = msg_offset
        .checked_add(msg_size)
        .ok_or(VaultError::BadEd25519Precompile)?;
    if sig_end > data.len() || pk_end > data.len() || msg_end > data.len() {
        return Err(VaultError::BadEd25519Precompile);
    }

    let mut signature = [0u8; ED25519_SIG_LEN];
    signature.copy_from_slice(&data[sig_offset..sig_end]);
    let mut pubkey = [0u8; ED25519_PUBKEY_LEN];
    pubkey.copy_from_slice(&data[pk_offset..pk_end]);
    let message = data[msg_offset..msg_end].to_vec();

    Ok(ParsedEd25519 {
        pubkey,
        signature,
        message,
    })
}
