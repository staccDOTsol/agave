/**
 * Central staccana frontend configuration.
 *
 * Pulls runtime values from NEXT_PUBLIC_* env vars with production-URL fallbacks
 * so the bundle works out of the box if no .env.local is present.
 */

import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID as TOKEN_2022_PROGRAM_ID_2 } from "@solana/spl-token";

/** Domain bytes for the lazy-claim signed message. Matches SPEC §4.2. */
export const STACCANA_CLAIM_DOMAIN = "STACCANA_CLAIM_V1";

/** Domain-separation byte for Merkle leaf hashes. Matches genesis/src/merkle.rs. */
export const LEAF_DOMAIN = 0x00;

/** Domain-separation byte for Merkle internal-node hashes. Matches genesis/src/merkle.rs. */
export const NODE_DOMAIN = 0x01;

// --- Program IDs and Well-known Accounts (all as PublicKey, always standard form) ---

/** Lazy-claim program ID. */
export const LAZY_CLAIM_PROGRAM_ID = new PublicKey("ERadtJ7EHLJtMLqj3ar4Y6QriMptMnYEhDEVTJ3DaERj");

/** Bridge program ID. */
export const BRIDGE_PROGRAM_ID = new PublicKey("DkjhevtY54Sr5CPRvFE8Rr6CEaQni28BojKY2pBygzDc");

/** Secret-pump program ID. */
export const SECRET_PUMP_PROGRAM_ID = new PublicKey("7LVzPiRVdcgZUpwwgUxx1wJrNKqYWts6WRKPqgbb94We");

/** Megadrop program ID. */
export const MEGADROP_PROGRAM_ID = new PublicKey("4jNZDaMwuHXdS6hDt6P5vsLbagNQ5MY4LL1ushBcLwvM");

/**
 * Validator-subsidy program ID.
 *
 * Disburses SOL from the treasury PDA (485M SOL pre-credited at genesis) to
 * registered validators based on `uptime_bps × delegated_stake × votes_cast`
 * weight per epoch. See `programs/validator-subsidy/`.
 */
export const VALIDATOR_SUBSIDY_PROGRAM_ID = new PublicKey("6enmxbp7Vjb2JBRh5FBjpwSD1LnxzECBhgzEBgW3wAiY");

/**
 * Placeholder treasury pubkey for secret-pump curve fees. Mirrors
 * `programs/secret-pump/src/lib.rs::TREASURY_PUBKEY_PLACEHOLDER` — the ASCII
 * string `staccana_treasury_placeholder___` packed as a 32-byte pubkey.
 * TODO(prod): swap to the real treasury PDA once SPEC §2.1 fills it in.
 */
export const SECRET_PUMP_TREASURY = new PublicKey(new TextEncoder().encode("staccana_treasury_placeholder___"));

/**
 * SPL Token-2022 program ID. The `pump` and `bridge` mints are Token-22.
 * NOTE: staccana devnet deploys Token-22 v8 at a fresh address rather than mainnet's canonical.
 */
export const TOKEN_2022_PROGRAM_ID = new PublicKey(TOKEN_2022_PROGRAM_ID_2);

/**
 * SPL Associated Token Account program ID. Used to derive a wallet's ATA for
 * a given Token-2022 mint and to construct an idempotent create-ATA-if-missing ix.
 * Same address caveat as TOKEN_2022_PROGRAM_ID above.
 */
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("2osq4Xf5YxbpyR4nWqJkqpsyRYwPrVD6CjZztCHCvYd6");

/** SPL Token v3 (the original spl-token program). */
export const TOKEN_PROGRAM_ID = new PublicKey("4PsxvxhPuysYQAf8FrggZKQvxQkCVG6hQCVHVJFrmFRj");

/** SPL Memo v3. */
export const MEMO_PROGRAM_ID = new PublicKey("2o6EJBtsFaf4yBpgZ992zjaQPjukUFHZT7SmE2J8e9pG");

/**
 * System program ID (canonical Solana).
 * Used by the partition rule (claimable iff system-owned + zero data)
 * and as the system_program account passed to the claim ix.
 */
export const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

/**
 * ed25519 precompile program ID (Solana built-in).
 * Pinned literal here so the value is grep-able in this file alongside the other program IDs.
 */
export const ED25519_PROGRAM_ID = new PublicKey("Ed25519SigVerify111111111111111111111111111");

/** Sysvar Instructions ID. Used at account index 2 of the claim ix. */
export const SYSVAR_INSTRUCTIONS_ID = new PublicKey("Sysvar1nstructions1111111111111111111111111");

// --- Endpoint and URL Configuration ---

/** Default megadrop allocations URL. Override via NEXT_PUBLIC_MEGADROP_URL. */
const DEFAULT_MEGADROP_URL = "/megadrop/allocations.json";
/** Resolved megadrop allocations URL. */
export const MEGADROP_URL = process.env.NEXT_PUBLIC_MEGADROP_URL ?? DEFAULT_MEGADROP_URL;

/** Default RPC endpoint when NEXT_PUBLIC_RPC_URL is unset. */
const DEFAULT_RPC_URL = "https://rpc.mp.fun/";
/** Resolved staccana RPC endpoint. */
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? DEFAULT_RPC_URL;

/** Default snapshot URL when NEXT_PUBLIC_SNAPSHOT_URL is unset. */
const DEFAULT_SNAPSHOT_URL = "/snapshot/genesis-output.json";
/** Resolved snapshot URL. */
export const SNAPSHOT_URL = process.env.NEXT_PUBLIC_SNAPSHOT_URL ?? DEFAULT_SNAPSHOT_URL;

/** Default explorer URL when NEXT_PUBLIC_EXPLORER_URL is unset. */
const DEFAULT_EXPLORER_URL = "https://explorer.mp.fun";
/** Resolved block-explorer base URL. */
export const EXPLORER_URL = process.env.NEXT_PUBLIC_EXPLORER_URL ?? DEFAULT_EXPLORER_URL;

/** Default cluster label when NEXT_PUBLIC_CLUSTER_NAME is unset. */
const DEFAULT_CLUSTER_NAME = "mainnet-sigma";
/** Resolved cluster name (display only — staccana has no chain-id concept). */
export const CLUSTER_NAME = process.env.NEXT_PUBLIC_CLUSTER_NAME ?? DEFAULT_CLUSTER_NAME;

/** Optional: known genesis hash to display in the cluster banner. Empty string => unknown. */
export const GENESIS_HASH = process.env.NEXT_PUBLIC_GENESIS_HASH ?? "";

// --- URL Builders and PDA Helpers ---

/** Format a tx signature into the explorer URL. */
export function explorerTxUrl(signature: string): string {
  return `${EXPLORER_URL.replace(/\/$/, "")}/tx/${signature}`;
}

/**
 * Derive the per-pubkey claimed-marker PDA at `["claimed", pubkey]`.
 * Matches `tools/claim-cli/src/tx.rs::claimed_marker_pda`.
 */
export function claimedMarkerPda(pubkey: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("claimed"), pubkey.toBuffer()],
    LAZY_CLAIM_PROGRAM_ID,
  );
  return pda;
}

/**
 * Derive the lazy-claim program-state PDA at `["state"]`.
 *
 * The CLI defaults to this when --program-state is not passed.
 */
export function programStatePda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("state")],
    LAZY_CLAIM_PROGRAM_ID,
  );
  return pda;
}

/**
 * Derive the treasury PDA at `["treasury"]` against the lazy-claim program.
 *
 * TODO(prod): swap to TREASURY_PROGRAM_ID once SPEC §2.1 fills it in. The CLI
 * currently uses the lazy-claim program ID as the placeholder seed authority;
 * we mirror that to stay consistent.
 */
export function treasuryPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    LAZY_CLAIM_PROGRAM_ID,
  );
  return pda;
}
