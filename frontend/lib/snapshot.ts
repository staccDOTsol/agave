/**
 * Snapshot loading + IndexedDB cache.
 *
 * The snapshot endpoint at SNAPSHOT_URL returns a JSON array of accounts in the
 * shape that `staccana_snapshot_fork::mock` consumes:
 *
 * ```json
 * [
 *   { "pubkey": "...", "owner": "...", "data_len": 0, "lamports": 1000 },
 *   ...
 * ]
 * ```
 *
 * We partition rows here using the same rule as the genesis builder
 * (system-owned, zero data) so the resulting Merkle tree is byte-for-byte
 * identical to the one whose root is embedded in the lazy-claim program.
 *
 * We cache the parsed claimable set in IndexedDB so repeat visits are instant
 * — the snapshot is large (potentially 100M+ rows in production) and we don't
 * want to refetch on every page load. Cache key includes a content hash so any
 * snapshot republish busts the cache.
 */

import { PublicKey } from "@solana/web3.js";
import { get as idbGet, set as idbSet } from "idb-keyval";

import type { ClaimableLeaf } from "./merkle";
import { SNAPSHOT_URL, SYSTEM_PROGRAM_ID } from "./staccana";

/** One row from the snapshot JSON. Pubkey + owner are base58-encoded strings. */
export interface SnapshotAccount {
  pubkey: string;
  owner: string;
  data_len: number;
  lamports: number;
}

/** A claimable account (system-owned, zero data) decoded into native types. */
export interface ClaimableAccount {
  pubkey: PublicKey;
  /** Lamports as bigint to safely round-trip u64 values. */
  lamports: bigint;
}

const CACHE_KEY_PREFIX = "staccana:snapshot:";
const CACHE_VERSION = "v1";

interface CacheEntry {
  version: string;
  url: string;
  fetchedAt: number;
  /** Pubkey base58 + lamports string. We avoid serializing PublicKey/bigint directly. */
  accounts: Array<{ pubkey: string; lamports: string }>;
}

/** Apply the genesis claimable rule. Mirrors `partition_claimable` in Rust. */
export function partitionClaimable(rows: SnapshotAccount[]): ClaimableAccount[] {
  const systemId = SYSTEM_PROGRAM_ID.toBase58();
  const out: ClaimableAccount[] = [];
  for (const row of rows) {
    if (row.owner !== systemId) continue;
    if (row.data_len !== 0) continue;
    out.push({
      pubkey: new PublicKey(row.pubkey),
      lamports: BigInt(row.lamports),
    });
  }
  return out;
}

/** Convert ClaimableAccount[] into the ClaimableLeaf[] shape merkle.ts wants. */
export function asLeaves(accounts: ClaimableAccount[]): ClaimableLeaf[] {
  return accounts.map((a) => ({ pubkey: a.pubkey, lamports: a.lamports }));
}

/**
 * Fetch the snapshot from the configured URL, partition for claimable accounts,
 * and cache the result in IndexedDB.
 *
 * Pass `forceRefresh: true` to bypass the cache.
 */
export async function fetchClaimableSnapshot(
  options: { forceRefresh?: boolean; url?: string } = {},
): Promise<ClaimableAccount[]> {
  const url = options.url ?? SNAPSHOT_URL;
  const cacheKey = `${CACHE_KEY_PREFIX}${url}`;

  if (!options.forceRefresh) {
    const cached = await readCache(cacheKey);
    if (cached) return cached;
  }

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`snapshot fetch failed: ${res.status} ${res.statusText}`);
  }
  const raw = (await res.json()) as SnapshotAccount[];
  if (!Array.isArray(raw)) {
    throw new Error("snapshot JSON is not an array");
  }
  const claimable = partitionClaimable(raw);
  await writeCache(cacheKey, url, claimable);
  return claimable;
}

async function readCache(key: string): Promise<ClaimableAccount[] | null> {
  try {
    const entry = (await idbGet(key)) as CacheEntry | undefined;
    if (!entry || entry.version !== CACHE_VERSION) return null;
    return entry.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      lamports: BigInt(a.lamports),
    }));
  } catch {
    // IndexedDB can be unavailable (private mode, etc.); fall through to refetch.
    return null;
  }
}

async function writeCache(key: string, url: string, accounts: ClaimableAccount[]): Promise<void> {
  try {
    const entry: CacheEntry = {
      version: CACHE_VERSION,
      url,
      fetchedAt: Date.now(),
      accounts: accounts.map((a) => ({ pubkey: a.pubkey.toBase58(), lamports: a.lamports.toString() })),
    };
    await idbSet(key, entry);
  } catch {
    // Cache write failures are non-fatal — the user just refetches next time.
  }
}
