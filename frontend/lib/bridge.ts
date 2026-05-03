/**
 * Bridge wire-format helpers.
 *
 * Three pieces:
 *
 * 1. Asset registry (stSOL / ssUSDC) + per-asset PDA derivations. Mirrors
 *    `tools/bridge-cli/src/asset.rs`.
 * 2. `RatioState` reader (45-byte Anchor account at `["ratio", asset_id_le]`).
 *    SPEC §5.2.
 * 3. Staccana-side `burn` instruction builder. SPEC §5.5 — Anchor `#[program]
 *    mod staccana_bridge` so the ix data is `discriminator(8) || asset_id(4) ||
 *    amount(8) || mainnet_dest(32)`. Account ordering matches the
 *    `BridgeBurn<'info>` struct declared in `programs/bridge/src/instructions/burn.rs`.
 *
 * The mainnet-side deposit ix is intentionally NOT implemented here. Crossing
 * to mainnet requires a second wallet connection and the per-asset vault
 * program ID — left as a v1.1 follow-up. For v1 the bridge page exposes the
 * deposit ix payload as base58 for the user to paste into a mainnet wallet.
 */

import {
  PublicKey,
  TransactionInstruction,
  type AccountInfo as Web3AccountInfo,
} from "@solana/web3.js";

import {
  BRIDGE_BURN_DISCRIMINATOR,
  BRIDGE_VAULT_DEPOSIT_DISCRIMINATOR,
  RATIO_STATE_DISCRIMINATOR,
  concatBytes,
  readU128Le,
  readU32Le,
  readU64Le,
  u32LeBytes,
} from "./anchor";
import { u64LeBytes } from "./merkle";
import {
  BRIDGE_PROGRAM_ID,
  BRIDGE_VAULT_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "./staccana";

// SPL Token v3 mainnet program ID (canonical Solana mainnet/devnet). The
// bridge-vault on mainnet talks to the standard SPL token program for
// stSOL/ssUSDC, NOT to staccana's address-shifted Token-22 — that one only
// exists on the staccana fork.
const MAINNET_SPL_TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MAINNET_SYSTEM_PROGRAM_ID = SYSTEM_PROGRAM_ID;

// ---------------------------------------------------------------------------
// Asset registry
// ---------------------------------------------------------------------------

/** Bridge asset identifiers. Numeric value is the canonical `asset_id`. */
export enum BridgeAsset {
  StSol = 0,
  SsUsdc = 1,
  WSol = 2,
}

/** Static per-asset metadata. */
export interface BridgeAssetMeta {
  id: BridgeAsset;
  /** Human-readable label (matches `tools/bridge-cli/src/asset.rs`). */
  label: string;
  /** Descriptive label for the underlying held on mainnet. */
  underlying: string;
  /** Decimals of the staccana mint. Matches `AssetConfig.decimals`. */
  decimals: number;
  /**
   * If true, the mainnet vault holds NATIVE SOL in the VaultConfig PDA's
   * lamports rather than an SPL token account. The deposit ix takes the
   * `system_program::transfer` path and skips `underlying_mint` /
   * `vault_token_account` / `user_token_account`. Mirrors
   * `bridge-vault::AssetFlag::NATIVE_SOL`.
   */
  isNativeSol: boolean;
}

/** Static asset registry. Mirrors `AssetId::from_label` / `default_decimals`. */
export const BRIDGE_ASSETS: BridgeAssetMeta[] = [
  { id: BridgeAsset.StSol, label: "stSOL", underlying: "SOL (mainnet pSYRUP)", decimals: 9, isNativeSol: false },
  { id: BridgeAsset.SsUsdc, label: "ssUSDC", underlying: "USDC (mainnet)", decimals: 6, isNativeSol: false },
  { id: BridgeAsset.WSol, label: "wSOL", underlying: "SOL (native)", decimals: 9, isNativeSol: true },
];

/** Look up asset metadata by numeric id. */
export function bridgeAssetById(id: BridgeAsset): BridgeAssetMeta {
  const meta = BRIDGE_ASSETS.find((a) => a.id === id);
  if (!meta) throw new Error(`unknown bridge asset id: ${id}`);
  return meta;
}

/** Derive the per-asset `AssetConfig` PDA. SPEC §5.1. */
export function assetConfigPda(asset: BridgeAsset): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("asset"), Buffer.from(u32LeBytes(asset))],
    BRIDGE_PROGRAM_ID,
  );
  return pda;
}

/** Derive the per-asset `RatioState` PDA. SPEC §5.2. */
export function ratioStatePda(asset: BridgeAsset): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("ratio"), Buffer.from(u32LeBytes(asset))],
    BRIDGE_PROGRAM_ID,
  );
  return pda;
}

/** Derive the per-asset outbound-nonce counter PDA. SPEC §5.5. */
export function nonceOutPda(asset: BridgeAsset): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("nonce_out"), Buffer.from(u32LeBytes(asset))],
    BRIDGE_PROGRAM_ID,
  );
  return pda;
}

// ---------------------------------------------------------------------------
// RatioState reader
// ---------------------------------------------------------------------------

/** Q64.64 representation of `1.0`. Sanity check + initial value at register. */
export const ONE_Q64 = 1n << 64n;

/** Decoded view of the on-chain `RatioState` PDA. SPEC §5.2. */
export interface RatioState {
  assetId: number;
  /** Q64.64 fixed-point ratio. */
  rQ64: bigint;
  lastPublishedSlot: bigint;
  lastNonce: bigint;
  bump: number;
}

/** Encoded length of `RatioState` per SPEC §5.2 (45 bytes). */
export const RATIO_STATE_LEN = 45;

/**
 * Decode a `RatioState` from the canonical Anchor account layout.
 *
 * Layout (45 bytes):
 * - 0..8:  discriminator
 * - 8..12: asset_id (u32 LE)
 * - 12..28: r_q64 (u128 LE)
 * - 28..36: last_published_slot (u64 LE)
 * - 36..44: last_nonce (u64 LE)
 * - 44: bump
 */
export function decodeRatioState(bytes: Uint8Array): RatioState {
  if (bytes.length !== RATIO_STATE_LEN) {
    throw new Error(`ratio state must be ${RATIO_STATE_LEN} bytes (got ${bytes.length})`);
  }
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== RATIO_STATE_DISCRIMINATOR[i]) {
      throw new Error("ratio state discriminator mismatch");
    }
  }
  return {
    assetId: readU32Le(bytes, 8),
    rQ64: readU128Le(bytes, 12),
    lastPublishedSlot: readU64Le(bytes, 28),
    lastNonce: readU64Le(bytes, 36),
    bump: bytes[44],
  };
}

/**
 * Convert a Q64.64 ratio to an approximate `f64`. Lossy by construction —
 * use only for human-readable display.
 */
export function q64ToFloat(q: bigint): number {
  const high = q >> 64n;
  const low = q & ((1n << 64n) - 1n);
  // Number(low) is lossy past 2^53 but acceptable for display since the lower
  // bits encode sub-ulp precision the user cannot perceive anyway.
  return Number(high) + Number(low) / 2 ** 64;
}

/** Mint amount for a deposit at the current ratio: `(value << 64) / R_q64`. */
export function mintAmountForValue(value: bigint, rQ64: bigint): bigint {
  if (rQ64 === 0n) throw new Error("zero ratio");
  return ((value << 64n) / rQ64);
}

/** Underlying released for burning `amount` at the current ratio: `(amount * R_q64) >> 64`. */
export function releaseAmountForBurn(amount: bigint, rQ64: bigint): bigint {
  return (amount * rQ64) >> 64n;
}

/** Apply a bps fee (deducted): `gross * (10_000 - fee_bps) / 10_000`. */
export function applyBpsFee(gross: bigint, feeBps: number): bigint {
  const bps = BigInt(Math.min(Math.max(feeBps, 0), 10_000));
  return (gross * (10_000n - bps)) / 10_000n;
}

// ---------------------------------------------------------------------------
// Burn instruction (staccana side)
// ---------------------------------------------------------------------------

/** Inputs needed to construct a `burn` ix on the staccana bridge program. */
export interface BurnIxArgs {
  asset: BridgeAsset;
  /** Mint tokens to burn from the user's ATA, in base units. */
  amount: bigint;
  /** Recipient pubkey on mainnet. Echoed in the `Burn` event for the federation. */
  mainnetDest: PublicKey;
  /** Burn authority (token-account owner) — must sign. */
  user: PublicKey;
  /** Staccana Token-22 mint for this asset. Read from `AssetConfig.staccana_mint`. */
  staccanaMint: PublicKey;
  /** User's ATA holding the mint balance. */
  userAta: PublicKey;
}

/**
 * Encode `BurnArgs` as Anchor instruction data.
 *
 * Layout: `[disc:8 | asset_id:4 LE | amount:8 LE | mainnet_dest:32]` = 52 bytes.
 *
 * SPEC §5.5 burn ix.
 */
export function encodeBurnArgs(asset: BridgeAsset, amount: bigint, mainnetDest: PublicKey): Uint8Array {
  return concatBytes(
    BRIDGE_BURN_DISCRIMINATOR,
    u32LeBytes(asset),
    u64LeBytes(amount),
    mainnetDest.toBytes(),
  );
}

/**
 * Build the staccana bridge `burn` instruction.
 *
 * Account order matches `BridgeBurn<'info>` in
 * `programs/bridge/src/instructions/burn.rs`:
 *
 * 0. user                [signer]
 * 1. asset_config        [readonly PDA]
 * 2. ratio_state         [readonly PDA]
 * 3. staccana_mint       [writable]
 * 4. user_ata            [writable]
 * 5. nonce_out           [writable PDA]
 * 6. token_program       [readonly]
 *
 * Token program is hard-coded to Token-2022 since bridge mints have CTE.
 */
export function buildBurnInstruction(args: BurnIxArgs): TransactionInstruction {
  if (args.amount <= 0n) {
    throw new Error("burn amount must be > 0");
  }
  const data = encodeBurnArgs(args.asset, args.amount, args.mainnetDest);
  return new TransactionInstruction({
    programId: BRIDGE_PROGRAM_ID,
    keys: [
      { pubkey: args.user, isWritable: false, isSigner: true },
      { pubkey: assetConfigPda(args.asset), isWritable: false, isSigner: false },
      { pubkey: ratioStatePda(args.asset), isWritable: false, isSigner: false },
      { pubkey: args.staccanaMint, isWritable: true, isSigner: false },
      { pubkey: args.userAta, isWritable: true, isSigner: false },
      { pubkey: nonceOutPda(args.asset), isWritable: true, isSigner: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isWritable: false, isSigner: false },
    ],
    data: Buffer.from(data),
  });
}

// ---------------------------------------------------------------------------
// Mainnet deposit payload (for paste-into-other-wallet workflow)
// ---------------------------------------------------------------------------

/**
 * Encode the mainnet vault `Deposit` ix data, matching
 * `tools/bridge-cli/src/deposit.rs`.
 *
 * Layout (45 bytes):
 *   `[ disc:u8=0 | asset_id:u32 LE | amount:u64 LE | dest_on_staccana:[u8;32] ]`
 *
 * The mainnet vault programs are minimal single-instruction programs at v0;
 * `0` is `Deposit`. The actual `AccountMeta` list depends on the per-asset
 * vault program; this function only emits the data payload that any vault
 * program would consume.
 */
export function encodeMainnetDepositArgs(
  asset: BridgeAsset,
  amount: bigint,
  destOnStaccana: PublicKey,
): Uint8Array {
  return concatBytes(
    new Uint8Array([0]),
    u32LeBytes(asset),
    u64LeBytes(amount),
    destOnStaccana.toBytes(),
  );
}

// ---------------------------------------------------------------------------
// Mainnet bridge-vault deposit ix (live wallet path)
// ---------------------------------------------------------------------------

/**
 * Derive the per-asset `VaultConfig` PDA on the mainnet bridge-vault program.
 * Mirrors `programs/bridge-vault/src/state.rs` — seeds: `["vault", asset_id_le]`.
 */
export function vaultConfigPda(asset: BridgeAsset): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), Buffer.from(u32LeBytes(asset))],
    BRIDGE_VAULT_PROGRAM_ID,
  );
  return pda;
}

/**
 * Derive the per-asset inbound nonce counter PDA on the mainnet bridge-vault.
 * Seeds: `["nonce_in", asset_id_le]`.
 */
export function nonceInPda(asset: BridgeAsset): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("nonce_in"), Buffer.from(u32LeBytes(asset))],
    BRIDGE_VAULT_PROGRAM_ID,
  );
  return pda;
}

/**
 * Encode the Anchor `deposit` ix args for the bridge-vault program.
 *
 * Layout (52 bytes): `[disc:8 | asset_id:u32 LE | amount:u64 LE | dest_on_staccana:[u8;32]]`.
 * The discriminator is `sha256("global:deposit")[..8]` (NOT the legacy
 * single-byte `0` discriminator from the wire-only `tools/bridge-cli`; the
 * production program is Anchor and uses the standard 8-byte prefix).
 */
export function encodeVaultDepositArgs(
  asset: BridgeAsset,
  amount: bigint,
  destOnStaccana: PublicKey,
): Uint8Array {
  return concatBytes(
    BRIDGE_VAULT_DEPOSIT_DISCRIMINATOR,
    u32LeBytes(asset),
    u64LeBytes(amount),
    destOnStaccana.toBytes(),
  );
}

/** Inputs needed to build the mainnet `deposit` ix. */
export interface VaultDepositIxArgs {
  asset: BridgeAsset;
  /** Gross amount in base units of the underlying. */
  amount: bigint;
  /** Mainnet wallet (signer / payer). */
  user: PublicKey;
  /** Recipient pubkey on staccana — typically the user's staccana wallet. */
  destOnStaccana: PublicKey;
  /**
   * SPL underlying mint (REQUIRED for stSOL / ssUSDC). For wSOL pass `null`
   * — the on-chain handler skips the SPL branch entirely (see
   * `programs/bridge-vault/src/instructions/deposit.rs`).
   */
  underlyingMint: PublicKey | null;
  /**
   * User's source SPL token account (REQUIRED for stSOL / ssUSDC). For wSOL
   * pass `null`; the handler ignores this slot.
   */
  userTokenAccount: PublicKey | null;
  /**
   * Vault PDA-owned ATA for the underlying (REQUIRED for stSOL / ssUSDC).
   * Read from `VaultConfig.vault_token_account` on-chain. For wSOL pass
   * `null`.
   */
  vaultTokenAccount: PublicKey | null;
}

/**
 * Build the mainnet bridge-vault `deposit` instruction.
 *
 * Account order matches `Deposit<'info>` in
 * `programs/bridge-vault/src/instructions/deposit.rs`:
 *
 * 0. user                 [signer, writable]
 * 1. vault_config         [writable PDA]
 * 2. nonce_in             [writable PDA]
 * 3. underlying_mint      [readonly]            (system_program for wSOL — handler ignores)
 * 4. user_token_account   [writable]            (system_program for wSOL — handler ignores)
 * 5. vault_token_account  [writable]            (system_program for wSOL — handler ignores)
 * 6. token_program        [readonly]            (mainnet SPL token v3)
 * 7. system_program       [readonly]
 *
 * The handler enforces `is_native_sol()` to decide which branch runs; for
 * wSOL we still have to supply SOMETHING in the SPL slots (Anchor needs a
 * concrete `AccountMeta` per the IDL), so we pass the system program as a
 * harmless filler exactly as `tools/bridge-cli` does.
 */
export function buildVaultDepositInstruction(args: VaultDepositIxArgs): TransactionInstruction {
  if (args.amount <= 0n) {
    throw new Error("deposit amount must be > 0");
  }
  const meta = bridgeAssetById(args.asset);
  if (!meta.isNativeSol) {
    if (!args.underlyingMint || !args.userTokenAccount || !args.vaultTokenAccount) {
      throw new Error(
        `Asset ${meta.label} requires underlyingMint, userTokenAccount, and vaultTokenAccount`,
      );
    }
  }

  const data = encodeVaultDepositArgs(args.asset, args.amount, args.destOnStaccana);

  // Filler for unused SPL slots on the wSOL path. The on-chain handler skips
  // them entirely; we just need PDA-typed `AccountMeta`s present.
  const filler = MAINNET_SYSTEM_PROGRAM_ID;

  return new TransactionInstruction({
    programId: BRIDGE_VAULT_PROGRAM_ID,
    keys: [
      { pubkey: args.user, isWritable: true, isSigner: true },
      { pubkey: vaultConfigPda(args.asset), isWritable: true, isSigner: false },
      { pubkey: nonceInPda(args.asset), isWritable: true, isSigner: false },
      {
        pubkey: meta.isNativeSol ? filler : (args.underlyingMint as PublicKey),
        isWritable: false,
        isSigner: false,
      },
      {
        pubkey: meta.isNativeSol ? filler : (args.userTokenAccount as PublicKey),
        isWritable: !meta.isNativeSol,
        isSigner: false,
      },
      {
        pubkey: meta.isNativeSol ? filler : (args.vaultTokenAccount as PublicKey),
        isWritable: !meta.isNativeSol,
        isSigner: false,
      },
      { pubkey: MAINNET_SPL_TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: MAINNET_SYSTEM_PROGRAM_ID, isWritable: false, isSigner: false },
    ],
    data: Buffer.from(data),
  });
}

// ---------------------------------------------------------------------------
// Account fetch helper
// ---------------------------------------------------------------------------

/**
 * Tiny adapter — `connection.getAccountInfo` returns a `Buffer` data field on
 * Node and a `Uint8Array`-like in browsers. Both expose `.length` and indexing,
 * but to call our typed decoders we want a raw `Uint8Array`.
 */
export function accountDataAsUint8(account: Web3AccountInfo<Buffer> | null): Uint8Array | null {
  if (!account) return null;
  // Buffer is a Uint8Array subtype; `Uint8Array.from` copies it into a plain
  // typed array.
  return new Uint8Array(account.data);
}
