/**
 * Central staccana frontend configuration.
 *
 * Pulls runtime values from NEXT_PUBLIC_* env vars with production-URL fallbacks
 * so the bundle works out of the box if no .env.local is present.
 */

import { PublicKey } from "@solana/web3.js";

/** Domain bytes for the lazy-claim signed message. Matches SPEC §4.2. */
export const STACCANA_CLAIM_DOMAIN = "STACCANA_CLAIM_V1";

/** Domain-separation byte for Merkle leaf hashes. Matches genesis/src/merkle.rs. */
export const LEAF_DOMAIN = 0x00;

/** Domain-separation byte for Merkle internal-node hashes. Matches genesis/src/merkle.rs. */
export const NODE_DOMAIN = 0x01;

/**
 * Lazy-claim program ID. Live on staccana devnet (deployed 2026-05-02).
 */
export const LAZY_CLAIM_PROGRAM_ID = new PublicKey(
  "BK95n7mFdF7Wk5T8oiSFLtmULprQe6bRcpgLMQGC3oeK",
);

/**
 * Bridge program ID. Live on staccana devnet (deployed 2026-05-02).
 */
export const BRIDGE_PROGRAM_ID = new PublicKey("LA7h3hjvD62MeTtdeE4h2vq3EGxbU1oqzHtewp4xb9b");

/**
 * Secret-pump program ID. Live on staccana devnet (deployed 2026-05-02).
 */
export const SECRET_PUMP_PROGRAM_ID = new PublicKey(
  "3Pbv3bHBh7SvcMDZqBFjJ3T9jLdrpiednaTRdViitMWF",
);

/**
 * Megadrop program ID. Live on staccana devnet (deployed 2026-05-02).
 */
export const MEGADROP_PROGRAM_ID = new PublicKey(
  "Aicff1zk6b5ifYzFoyhenUD5ehhFYb8GiDbRCrWt9t34",
);

/**
 * Validator-subsidy program ID. Live on staccana devnet (deployed 2026-05-02).
 *
 * Disburses SOL from the treasury PDA (485M SOL pre-credited at genesis) to
 * registered validators based on `uptime_bps × delegated_stake × votes_cast`
 * weight per epoch. See `programs/validator-subsidy/`.
 */
export const VALIDATOR_SUBSIDY_PROGRAM_ID = new PublicKey(
  "Ef9YyzrsFx7sptmu8v3M6ju82krceHXhq6jfivw6BBgk",
);

/**
 * Placeholder treasury pubkey for secret-pump curve fees. Mirrors
 * `programs/secret-pump/src/lib.rs::TREASURY_PUBKEY_PLACEHOLDER` — the ASCII
 * string `staccana_treasury_placeholder___` packed as a 32-byte pubkey. The
 * on-chain `buy` / `sell` ix verify the treasury account against this constant,
 * so the same bytes must round-trip through TS.
 *
 * TODO(prod): swap to the real treasury PDA once SPEC §2.1 fills it in.
 */
export const SECRET_PUMP_TREASURY = new PublicKey(
  new TextEncoder().encode("staccana_treasury_placeholder___"),
);

/** SPL Token-2022 program ID. The `pump` and `bridge` mints are Token-22. */
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

/**
 * SPL Associated Token Account program ID. Used to derive a wallet's ATA for
 * a given Token-2022 mint and to construct an idempotent
 * `create-ATA-if-missing` ix on the secret-pump buy path.
 */
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

/** Default megadrop allocations URL. Override via NEXT_PUBLIC_MEGADROP_URL. */
const DEFAULT_MEGADROP_URL = "https://snapshot.mp.fun/megadrop/allocations.json";

/** Resolved megadrop allocations URL. */
export const MEGADROP_URL = process.env.NEXT_PUBLIC_MEGADROP_URL ?? DEFAULT_MEGADROP_URL;

/**
 * System program ID. Used by the partition rule (claimable iff system-owned + zero data)
 * and as the system_program account passed to the claim ix.
 */
export const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

/**
 * ed25519 precompile program ID. Solana built-in.
 *
 * Pinned literal here (rather than imported from @solana/web3.js's constants) so
 * the value is grep-able in this file alongside the other program IDs.
 */
export const ED25519_PROGRAM_ID = new PublicKey("Ed25519SigVerify111111111111111111111111111");

/** Sysvar Instructions ID. Used at account index 2 of the claim ix. */
export const SYSVAR_INSTRUCTIONS_ID = new PublicKey("Sysvar1nstructions1111111111111111111111111");

/** Default RPC endpoint when NEXT_PUBLIC_RPC_URL is unset. */
const DEFAULT_RPC_URL = "https://rpc.mp.fun/";

/** Default snapshot URL when NEXT_PUBLIC_SNAPSHOT_URL is unset. */
const DEFAULT_SNAPSHOT_URL = "https://snapshot.mp.fun/genesis-output.json";

/** Default explorer URL when NEXT_PUBLIC_EXPLORER_URL is unset. */
const DEFAULT_EXPLORER_URL = "https://explorer.mp.fun";

/** Default cluster label when NEXT_PUBLIC_CLUSTER_NAME is unset. */
const DEFAULT_CLUSTER_NAME = "mainnet-sigma";

/** Resolved staccana RPC endpoint. */
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? DEFAULT_RPC_URL;

/** Resolved snapshot URL. */
export const SNAPSHOT_URL = process.env.NEXT_PUBLIC_SNAPSHOT_URL ?? DEFAULT_SNAPSHOT_URL;

/** Resolved block-explorer base URL. */
export const EXPLORER_URL = process.env.NEXT_PUBLIC_EXPLORER_URL ?? DEFAULT_EXPLORER_URL;

/** Resolved cluster name (display only — staccana has no chain-id concept). */
export const CLUSTER_NAME = process.env.NEXT_PUBLIC_CLUSTER_NAME ?? DEFAULT_CLUSTER_NAME;

/** Optional: known genesis hash to display in the cluster banner. Empty string => unknown. */
export const GENESIS_HASH = process.env.NEXT_PUBLIC_GENESIS_HASH ?? "";

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
 * The CLI defaults to this when --program-state is not passed (see
 * tools/claim-cli/src/main.rs). Real value will be pinned in the lazy-claim
 * program's deployment notes once it ships.
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
 * currently uses the lazy-claim program ID as the placeholder seed authority
 * (tools/claim-cli/src/main.rs); we mirror that to stay consistent.
 */
export function treasuryPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    LAZY_CLAIM_PROGRAM_ID,
  );
  return pda;
}
