//! On-chain account layouts owned by the lazy-claim program.
//!
//! Two accounts:
//!
//! 1. [`LazyClaimConfig`] — singleton account holding the embedded `claimable_root` and the
//!    well-known treasury PDA address. Created at genesis; immutable after that.
//! 2. [`ClaimedMarker`] — per-pubkey PDA at seeds `["claimed", pubkey]`. Existence proves a
//!    given pubkey has already claimed; non-existence is the precondition for a new claim.
//!
//! Both layouts are fixed-size and packed via manual byte encoding so the program never
//! needs `borsh` or `bincode` at runtime — keeps compute units down. Off-chain tooling can
//! deserialize via the `from_slice` helpers.

use solana_program::hash::Hash;
use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;

use crate::error::LazyClaimError;

/// PDA seed prefix for per-pubkey claim markers. Combined with the claimed pubkey to
/// derive `["claimed", pubkey]`.
pub const CLAIMED_MARKER_SEED: &[u8] = b"claimed";

/// Singleton config account holding the genesis-embedded `claimable_root` and the treasury
/// PDA address.
///
/// Layout (66 bytes, fixed):
/// * `[0..1]`   discriminator (constant `0x01`)
/// * `[1..2]`   version (currently `0x01`)
/// * `[2..34]`  `claimable_root` (32 bytes)
/// * `[34..66]` `treasury_pda`   (32 bytes)
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LazyClaimConfig {
    pub claimable_root: Hash,
    pub treasury_pda: Pubkey,
}

impl LazyClaimConfig {
    pub const DISCRIMINATOR: u8 = 0x01;
    pub const VERSION: u8 = 0x01;
    pub const SIZE: usize = 1 + 1 + 32 + 32;

    pub fn pack(&self, out: &mut [u8]) -> Result<(), ProgramError> {
        if out.len() < Self::SIZE {
            return Err(LazyClaimError::BadConfigAccount.into());
        }
        out[0] = Self::DISCRIMINATOR;
        out[1] = Self::VERSION;
        out[2..34].copy_from_slice(self.claimable_root.as_ref());
        out[34..66].copy_from_slice(self.treasury_pda.as_ref());
        Ok(())
    }

    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::SIZE {
            return Err(LazyClaimError::BadConfigAccount.into());
        }
        if data[0] != Self::DISCRIMINATOR || data[1] != Self::VERSION {
            return Err(LazyClaimError::BadConfigAccount.into());
        }
        let mut root_bytes = [0u8; 32];
        root_bytes.copy_from_slice(&data[2..34]);
        let mut treasury_bytes = [0u8; 32];
        treasury_bytes.copy_from_slice(&data[34..66]);
        Ok(Self {
            claimable_root: Hash::new_from_array(root_bytes),
            treasury_pda: Pubkey::new_from_array(treasury_bytes),
        })
    }
}

/// Per-pubkey marker initialized at the moment of claim. Existence is the one-shot guard.
///
/// Layout (41 bytes, fixed):
/// * `[0..1]`   discriminator (constant `0x02`)
/// * `[1..33]`  claimed pubkey (echo for sanity / off-chain inspection)
/// * `[33..41]` lamports credited (LE u64)
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ClaimedMarker {
    pub pubkey: Pubkey,
    pub lamports: u64,
}

impl ClaimedMarker {
    pub const DISCRIMINATOR: u8 = 0x02;
    pub const SIZE: usize = 1 + 32 + 8;

    pub fn pack(&self, out: &mut [u8]) -> Result<(), ProgramError> {
        if out.len() < Self::SIZE {
            return Err(LazyClaimError::BadClaimedMarkerPda.into());
        }
        out[0] = Self::DISCRIMINATOR;
        out[1..33].copy_from_slice(self.pubkey.as_ref());
        out[33..41].copy_from_slice(&self.lamports.to_le_bytes());
        Ok(())
    }

    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::SIZE || data[0] != Self::DISCRIMINATOR {
            return Err(LazyClaimError::BadClaimedMarkerPda.into());
        }
        let mut pubkey_bytes = [0u8; 32];
        pubkey_bytes.copy_from_slice(&data[1..33]);
        let mut lamport_bytes = [0u8; 8];
        lamport_bytes.copy_from_slice(&data[33..41]);
        Ok(Self {
            pubkey: Pubkey::new_from_array(pubkey_bytes),
            lamports: u64::from_le_bytes(lamport_bytes),
        })
    }
}

/// Derive the per-pubkey claimed-marker PDA address and bump seed.
pub fn find_claimed_marker_pda(pubkey: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CLAIMED_MARKER_SEED, pubkey.as_ref()], program_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pk(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte; 32])
    }

    #[test]
    fn config_round_trip() {
        let cfg = LazyClaimConfig {
            claimable_root: Hash::new_from_array([0x42; 32]),
            treasury_pda: pk(7),
        };
        let mut buf = [0u8; LazyClaimConfig::SIZE];
        cfg.pack(&mut buf).unwrap();
        let decoded = LazyClaimConfig::unpack(&buf).unwrap();
        assert_eq!(cfg, decoded);
    }

    #[test]
    fn config_rejects_wrong_discriminator() {
        let mut buf = [0u8; LazyClaimConfig::SIZE];
        buf[0] = 0xFF;
        buf[1] = LazyClaimConfig::VERSION;
        assert!(LazyClaimConfig::unpack(&buf).is_err());
    }

    #[test]
    fn config_rejects_short_buffer() {
        let buf = [0u8; LazyClaimConfig::SIZE - 1];
        assert!(LazyClaimConfig::unpack(&buf).is_err());
    }

    #[test]
    fn marker_round_trip() {
        let m = ClaimedMarker {
            pubkey: pk(9),
            lamports: 1_234_567_890,
        };
        let mut buf = [0u8; ClaimedMarker::SIZE];
        m.pack(&mut buf).unwrap();
        let decoded = ClaimedMarker::unpack(&buf).unwrap();
        assert_eq!(m, decoded);
    }

    #[test]
    fn marker_rejects_wrong_discriminator() {
        let mut buf = [0u8; ClaimedMarker::SIZE];
        buf[0] = 0xFF;
        assert!(ClaimedMarker::unpack(&buf).is_err());
    }
}
