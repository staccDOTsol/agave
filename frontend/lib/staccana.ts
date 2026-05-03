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

/**
 * Lazy-claim program ID. Genesis-baked at the canonical placeholder pubkey,
 * matches `tools/genesis-bake/src/pdas.rs::LAZY_CLAIM_PROGRAM_ID`. After a
 * rebake the .so at this address contains the proof-buffer ix additions and
 * the upgrade authority is set to the bake operator's pubkey, so future
 * upgrades go through `solana program deploy` instead of another rebake.
 */
export const LAZY_CLAIM_PROGRAM_ID = new PublicKey("68fnSf8CZjxLM2xHmswktgz3a77KLQT2nbhjWbpKWsYU");

/** Bridge program ID. */
export const BRIDGE_PROGRAM_ID = new PublicKey("Bridge1111111111111111111111111111111111111");

/**
 * Mainnet (or devnet — for tonight's bring-up) bridge-vault program ID.
 *
 * This program lives on the OTHER chain (Solana mainnet/devnet), not staccana.
 * The deposit leg of the bridge calls `deposit` on this program; the mainnet
 * wallet adapter (see `MainnetWalletContextProviders` in lib/wallet.tsx) signs
 * + submits.
 */
export const BRIDGE_VAULT_PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_BRIDGE_VAULT_PROGRAM_ID ?? "F2AypZ8FDWnR5bdyLHzo4idof9YrBpdBmbgLwLBjLfVU",
);

/**
 * Secret-pump program ID. Genesis-baked at the canonical placeholder
 * pubkey. Post-rebake the .so is current source (empty `CreateArgs`) and
 * the upgrade authority is set to the bake operator's pubkey, so future
 * patches ship via `solana program deploy --upgrade-authority`.
 */
export const SECRET_PUMP_PROGRAM_ID = new PublicKey("SPump11111111111111111111111111111111111111");

/**
 * Megadrop program ID. Genesis-baked at the canonical placeholder pubkey;
 * the rebake includes the proof-buffer ix additions at this address with an
 * upgrade authority set, so future patches don't need another rebake.
 */
export const MEGADROP_PROGRAM_ID = new PublicKey("Megadrop11111111111111111111111111111111111");

/**
 * Validator-subsidy program ID.
 *
 * Disburses SOL from the treasury PDA (485M SOL pre-credited at genesis) to
 * registered validators based on `uptime_bps × delegated_stake × votes_cast`
 * weight per epoch. See `programs/validator-subsidy/`.
 */
export const VALIDATOR_SUBSIDY_PROGRAM_ID = new PublicKey("Subsidy111111111111111111111111111111111111");

/**
 * Placeholder treasury pubkey for secret-pump curve fees. Mirrors
 * `programs/secret-pump/src/lib.rs::TREASURY_PUBKEY_PLACEHOLDER` — the ASCII
 * string `staccana_treasury_placeholder___` packed as a 32-byte pubkey.
 * TODO(prod): swap to the real treasury PDA once SPEC §2.1 fills it in.
 */
export const SECRET_PUMP_TREASURY = new PublicKey(new TextEncoder().encode("staccana_treasury_placeholder___"));

/**
 * SPL Token-2022 program ID — canonical mainnet address. Baked at genesis on
 * staccana so Anchor's `Program<'info, Token2022>` checks pass and so wallet
 * libs that hardcode this constant work without any custom config.
 */
export const TOKEN_2022_PROGRAM_ID = new PublicKey(TOKEN_2022_PROGRAM_ID_2);

/**
 * SPL Associated Token Account program — canonical mainnet address. Baked at
 * genesis on staccana. (Was previously a fresh post-deploy address; the rebake
 * moved it to canonical so wallets + spl-token's `getAssociatedTokenAddress`
 * stop hitting `ProgramAccountNotFound` on buy/transfer txs.)
 */
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** SPL Token v3 (the original spl-token program) — canonical mainnet address. */
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/** SPL Memo v3 — canonical mainnet address. */
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

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

/**
 * Mainnet (or devnet) Solana RPC endpoint used by the SECOND wallet adapter
 * for the bridge deposit leg.
 *
 * For tonight's bring-up the bridge-vault program (`F2Ayp…`) lives on Solana
 * devnet, so the default points at devnet. Override via
 * `NEXT_PUBLIC_MAINNET_RPC_URL` once the vault is redeployed to mainnet.
 */
const DEFAULT_MAINNET_RPC_URL = "https://api.devnet.solana.com";
/** Resolved mainnet (or devnet) RPC endpoint for the deposit leg. */
export const MAINNET_RPC_URL =
  process.env.NEXT_PUBLIC_MAINNET_RPC_URL ?? DEFAULT_MAINNET_RPC_URL;

/** Optional explorer base URL for mainnet (or devnet). */
const DEFAULT_MAINNET_EXPLORER_URL = "https://explorer.solana.com";
/** Cluster query suffix for the mainnet explorer (e.g. `?cluster=devnet`). */
const DEFAULT_MAINNET_EXPLORER_CLUSTER = "?cluster=devnet";
export const MAINNET_EXPLORER_URL =
  process.env.NEXT_PUBLIC_MAINNET_EXPLORER_URL ?? DEFAULT_MAINNET_EXPLORER_URL;
export const MAINNET_EXPLORER_CLUSTER =
  process.env.NEXT_PUBLIC_MAINNET_EXPLORER_CLUSTER ?? DEFAULT_MAINNET_EXPLORER_CLUSTER;

/** Format a tx signature into the mainnet/devnet explorer URL. */
export function mainnetExplorerTxUrl(signature: string): string {
  return `${MAINNET_EXPLORER_URL.replace(/\/$/, "")}/tx/${signature}${MAINNET_EXPLORER_CLUSTER}`;
}

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

/**
 * Known genesis hash. Used by `components/wallet-help.tsx` to detect when
 * the user's wallet is on a different cluster (mainnet/devnet) and surface
 * the "add staccana RPC" banner. Updated to the post-rebake hash on
 * 2026-05-03; if you re-bake genesis, update this constant (or override
 * via `NEXT_PUBLIC_GENESIS_HASH`).
 */
export const GENESIS_HASH =
  process.env.NEXT_PUBLIC_GENESIS_HASH ?? "5B4McgxXGHjUNQAqnzxf8ZDnVenXAoe4dNJyp7ystWri";

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

/**
 * Derive the lazy-claim proof-buffer PDA at `["proof_buffer", pubkey, payer]`.
 *
 * Keying on payer (as well as the claim pubkey) lets multiple users concurrently
 * stage proofs for different leaves without colliding on the same PDA.
 */
export function lazyClaimProofBufferPda(pubkey: PublicKey, payer: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("proof_buffer"), pubkey.toBuffer(), payer.toBuffer()],
    LAZY_CLAIM_PROGRAM_ID,
  );
  return pda;
}

/**
 * Derive the megadrop proof-buffer PDA at
 * `["megadrop_proof_buffer", holder, payer]`. Same shape as the lazy-claim PDA
 * but distinct seed prefix to keep the two programs isolated.
 */
export function megadropProofBufferPda(holder: PublicKey, payer: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("megadrop_proof_buffer"), holder.toBuffer(), payer.toBuffer()],
    MEGADROP_PROGRAM_ID,
  );
  return pda;
}
