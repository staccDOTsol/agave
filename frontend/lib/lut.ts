"use client";

/**
 * Address Lookup Table (LUT) helper.
 *
 * The validator-subsidy `init_subsidy` ix carries 32 federation-member pubkeys
 * (MAX_FEDERATION_MEMBERS) plus the SubsidyConfig + ValidatorRegistry PDAs +
 * the system program. As a legacy `Transaction` the serialized payload is
 * ~1412 bytes — over the legacy 1232 byte tx limit. Wallet adapters reject it
 * with "Transaction too large: 1412 > 1232".
 *
 * The fix is a v0 `VersionedTransaction` plus an Address Lookup Table that
 * indexes the recurring read-only accounts. Each LUT-resolved account swaps
 * 32 bytes of pubkey for a single 1-byte index in the message — typically
 * shrinking the tx to ~700-900 bytes, well under the legacy cap.
 *
 * LUT lifecycle:
 *
 *   1. createLookupTable(...)      — one tx, returns the LUT pubkey.
 *   2. extendLookupTable(...)      — appends addresses; pubkey unchanged.
 *   3. wait one slot               — LUT must be "warmed up" (visible at the
 *                                    slot the consumer tx targets) before it
 *                                    can be referenced.
 *   4. consumer tx references LUT  — accounts referenced by their (table,
 *                                    index) pair instead of inline.
 *
 * The LUT itself is rent-exempt and lives forever (until deactivated +
 * closed). For the staccana validator-subsidy bootstrap we only need a single
 * LUT per cluster — once any wallet has paid to create one, subsequent
 * `init_subsidy` callers can reuse it. We cache the LUT pubkey under the
 * cluster's RPC-keyed localStorage entry so a wallet that bootstrapped the
 * LUT in one session reuses it on the next.
 *
 * NB: this module is wallet-agnostic. The page passes its `sendTransaction`
 * closure (from `useWallet()`) — we do NOT touch the wallet adapter directly.
 */

import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type SendOptions,
} from "@solana/web3.js";

/** Minimal shape of `WalletContextState["sendTransaction"]` we depend on. */
export type SendTransaction = (
  transaction: Transaction,
  connection: Connection,
  options?: SendOptions,
) => Promise<string>;

/** Sysvars frequently appended to instructions. Cheap to extend even if unused. */
const SYSVAR_RENT = new PublicKey("SysvarRent111111111111111111111111111111111");
const SYSVAR_CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");

/**
 * The set of accounts to bake into the LUT for `init_subsidy`. The order
 * within the LUT does not matter — we just need every account the message
 * wants to index by table-and-index to appear at least once.
 */
export interface LutSeedAccounts {
  /** SubsidyConfig PDA (writable in init, but writability is per-instruction). */
  subsidyConfig: PublicKey;
  /** ValidatorRegistry PDA. */
  validatorRegistry: PublicKey;
  /** Federation members (already padded to MAX_FEDERATION_MEMBERS). */
  federationMembers: PublicKey[];
}

/**
 * localStorage key used to memoize the LUT pubkey, keyed by RPC endpoint so
 * devnet/staccana/mainnet don't trample each other.
 */
function lutCacheKey(rpcUrl: string): string {
  return `staccana.subsidyInitLut.v1.${rpcUrl}`;
}

/**
 * Read the cached LUT pubkey for this RPC endpoint, or `null` if missing or
 * unparseable. Safe to call from SSR (returns `null` if `window` is absent).
 */
export function readCachedLut(rpcUrl: string): PublicKey | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(lutCacheKey(rpcUrl));
    if (!raw) return null;
    return new PublicKey(raw);
  } catch {
    return null;
  }
}

/** Persist the LUT pubkey for reuse on the next bootstrap. */
export function writeCachedLut(rpcUrl: string, lut: PublicKey): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(lutCacheKey(rpcUrl), lut.toBase58());
  } catch {
    // localStorage may be disabled (private browsing) — non-fatal.
  }
}

/** Drop the cached LUT (e.g. after we discover it was deactivated). */
export function clearCachedLut(rpcUrl: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(lutCacheKey(rpcUrl));
  } catch {
    // ignore
  }
}

/**
 * Verify that a cached LUT still exists on chain and contains every required
 * address. Returns the loaded `AddressLookupTableAccount` if usable, else
 * `null` (which signals the caller to bootstrap a fresh LUT).
 */
export async function loadUsableLut(
  connection: Connection,
  lut: PublicKey,
  required: PublicKey[],
): Promise<AddressLookupTableAccount | null> {
  try {
    const resp = await connection.getAddressLookupTable(lut, { commitment: "confirmed" });
    const account = resp.value;
    if (!account) return null;
    // Reject deactivated tables — they can't be referenced once deactivation
    // slot is in the past.
    if (account.state.deactivationSlot !== BigInt("18446744073709551615")) {
      return null;
    }
    const have = new Set(account.state.addresses.map((a) => a.toBase58()));
    for (const r of required) {
      if (!have.has(r.toBase58())) return null;
    }
    return account;
  } catch {
    return null;
  }
}

/**
 * Build the deduplicated list of addresses to index in the LUT, in a stable
 * order (system program + sysvars first, then PDAs, then federation members).
 */
export function buildLutAddressList(seed: LutSeedAccounts): PublicKey[] {
  const seen = new Set<string>();
  const out: PublicKey[] = [];
  const push = (pk: PublicKey) => {
    const k = pk.toBase58();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(pk);
  };
  push(SystemProgram.programId);
  push(SYSVAR_RENT);
  push(SYSVAR_CLOCK);
  push(seed.subsidyConfig);
  push(seed.validatorRegistry);
  for (const m of seed.federationMembers) push(m);
  return out;
}

/**
 * Bootstrap a fresh Address Lookup Table:
 *
 *   1. `createLookupTable` (allocates the table, returns its address).
 *   2. `extendLookupTable` with every address from {@link buildLutAddressList}.
 *      Both ixes go in a single tx — well under the legacy 1232 cap because
 *      the payload is just (auth, payer, recent_slot, addresses[]).
 *   3. Wait one confirmed slot so the LUT is referenceable from the next tx.
 *
 * Returns the new LUT pubkey. Caller is responsible for caching it.
 */
export async function bootstrapLookupTable(opts: {
  connection: Connection;
  payer: PublicKey;
  authority?: PublicKey;
  addresses: PublicKey[];
  sendTransaction: SendTransaction;
}): Promise<PublicKey> {
  const { connection, payer, addresses, sendTransaction } = opts;
  const authority = opts.authority ?? payer;

  // recentSlot must be a slot for which we hold the blockhash; using a finalized
  // slot is the safe choice (createLookupTable derives the LUT pubkey from
  // [authority, recentSlot]).
  const recentSlot = await connection.getSlot("finalized");

  const [createIx, lutAddress] = AddressLookupTableProgram.createLookupTable({
    authority,
    payer,
    recentSlot,
  });

  // Anchor LUT extends are capped at ~30 addresses per ix because the message
  // itself has a size budget. Chunk to be safe.
  const ixes: TransactionInstruction[] = [createIx];
  const CHUNK = 24;
  for (let i = 0; i < addresses.length; i += CHUNK) {
    ixes.push(
      AddressLookupTableProgram.extendLookupTable({
        lookupTable: lutAddress,
        authority,
        payer,
        addresses: addresses.slice(i, i + CHUNK),
      }),
    );
  }

  const tx = new Transaction().add(...ixes);
  tx.feePayer = payer;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

  const sig = await sendTransaction(tx, connection);
  await connection.confirmTransaction(sig, "confirmed");

  // The LUT is created at slot N; it is referenceable from slot N+1 onward.
  // Poll briefly until we can read it back at the "confirmed" commitment.
  for (let attempt = 0; attempt < 20; attempt++) {
    const resp = await connection.getAddressLookupTable(lutAddress, {
      commitment: "confirmed",
    });
    if (resp.value && resp.value.state.addresses.length >= addresses.length) {
      return lutAddress;
    }
    await sleep(500);
  }

  // Even if our poll timed out, the tx confirmed — return the address. The
  // consumer will surface a clear error if the LUT genuinely isn't visible.
  return lutAddress;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
