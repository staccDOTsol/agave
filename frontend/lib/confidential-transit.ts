/**
 * Confidential transfer "transit account" hack.
 *
 * Lets a sender ship a Token-22 confidential transfer to a recipient who has
 * NOT yet pre-configured a `ConfidentialTransferAccount` extension on their
 * canonical ATA. The trick: the sender mints a fresh Keypair, allocates a
 * Token-22 account at that pubkey, runs `InitializeAccount3 + ConfigureAccount`
 * with a *transit* ElGamal keypair that BOTH sides can derive, runs the
 * confidential `Transfer` into that account, then `SetAuthority` flips the
 * AccountOwner to the recipient. A memo ix records the transit seed so the
 * recipient can later derive the same ElGamal keypair, decrypt their balance,
 * and `Withdraw + EmptyAccount + ConfigureAccount + Deposit + ApplyPending`
 * to migrate the funds onto their own canonical ATA.
 *
 * Seed-delivery model
 * -------------------
 * Solana wallets (Phantom/Backpack/Solflare) expose `signMessage` only — they
 * never give us a curve25519 ECDH primitive nor the ed25519 secret. We can't
 * encrypt to a wallet pubkey OOB without a wallet-side decrypt API. So we use
 * a **scoped obfuscation**, not real encryption:
 *
 *   shared_key = sha256("staccana-transit-shared-v1" || sender || recipient
 *                       || mint || rand_nonce)
 *   transit_seed = sha256("staccana-transit-seed-v1" || shared_key)
 *   memo payload = base64(rand_nonce(4) || aes_gcm(shared_key, transit_seed))
 *
 * Anyone who reads the memo + the on-chain accounts (sender, recipient, mint)
 * can recompute `shared_key` and decrypt the seed — but the seed is *also*
 * derivable directly from those public values, so the AES wrap is purely a
 * marker/format wrapper for the recipient detector to find. We keep the AES
 * step so future rotation to a real ECDH (when wallets support `decrypt`)
 * needs zero memo-format change.
 *
 * Trade-off: any on-chain observer can decrypt the transit balance once they
 * see the memo. That's strictly worse than recipient-only privacy but strictly
 * better than the public `TransferChecked` fallback (the amount stays in
 * ElGamal ciphertext on-chain, only the seed is leaked). Future work: when
 * Phantom ships the wallet-standard `decrypt` flow we swap to real
 * `nacl.box(ephemeral_sk, recipient_curve25519_pk)`.
 */

import {
  AuthorityType,
  createInitializeAccount3Instruction,
  createSetAuthorityInstruction,
  ExtensionType,
  getAccountLen,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

import {
  AE_CIPHERTEXT_LEN,
  CT_EXT_TAG,
  CT_IX,
  EXT_TYPE_CONFIDENTIAL_TRANSFER_ACCOUNT,
  TOKEN_BASE_ACCOUNT_SIZE,
  buildApplyPendingBalanceInstruction,
  buildConfigureAccountInstruction,
  buildTransferInstruction,
  buildWithdrawInstruction,
  findConfidentialTransferAccountExtension,
} from "./confidential";
import { MEMO_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "./staccana";

/**
 * Memo prefix so the recipient detector can `String.startsWith` and ignore
 * unrelated memos. Bump the version suffix when changing the wire format.
 */
export const TRANSIT_MEMO_PREFIX = "staccana:transit:v1:";

/**
 * Token-22 account size with the two extensions we need:
 * `ImmutableOwner` + `ConfidentialTransferAccount`. Computed once via
 * `getAccountLen(...)` and cached. ImmutableOwner makes the SetAuthority(...,
 * AccountOwner) ix atomic — without it the recipient could SetAuthority back
 * to anyone.
 *
 * Wait — ImmutableOwner would actually BLOCK our `SetAuthority` step. We need
 * the owner mutable from sender to recipient exactly once. So we deliberately
 * DO NOT include ImmutableOwner here. The size is just `ConfidentialTransfer
 * Account`.
 */
export const TRANSIT_ACCOUNT_SIZE = getAccountLen([
  ExtensionType.ConfidentialTransferAccount,
]);

/** Result of `prepareTransitSendIxs` — bundle of ixs + the new account keypair. */
export interface TransitSendBundle {
  /** Fresh keypair for the non-canonical Token-22 account. Must sign the tx. */
  newAccount: Keypair;
  /** Ordered ixs to assemble into a single v0 tx (LUT-required). */
  instructions: TransactionInstruction[];
  /** The transit ElGamal seed embedded in the memo (for diagnostics/test). */
  transitSeed: Uint8Array;
  /** The 4-byte random nonce used in seed derivation + memo prefix. */
  randNonce: Uint8Array;
}

/** Args for `prepareTransitSendIxs`. */
export interface PrepareTransitSendArgs {
  connection: Connection;
  sender: PublicKey;
  /** Sender's canonical ATA for `mint` — source of the confidential transfer. */
  senderAta: PublicKey;
  recipient: PublicKey;
  mint: PublicKey;
  /** Amount in raw token units (smallest, pre-decimal). */
  amount: bigint;
  /** Sender's ElGamal seed (derived via `deriveElGamalKeypair(sender, mint).secretSeed`). */
  senderElgamalSeed: Uint8Array;
  /** Sender's ElGamal pubkey (32 bytes). */
  senderElgamalPubkey: Uint8Array;
  /** Sender's new decryptable available balance after the transfer (36 bytes). */
  newSourceDecryptableAvailableBalance: Uint8Array;
  /**
   * Optional — caller provides a 4-byte nonce for determinism in tests. When
   * omitted we sample from `crypto.getRandomValues`.
   */
  randNonce?: Uint8Array;
  /** Optional fetch override for proof endpoint. */
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Crypto helpers — Web Crypto only, no extra deps.
// ---------------------------------------------------------------------------

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  let total = 0;
  for (const p of parts) total += p.length;
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

const TE = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "undefined") {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(s: string): Uint8Array {
  if (typeof atob !== "undefined") {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return Uint8Array.from(Buffer.from(s, "base64"));
}

/**
 * Deterministically derive the transit shared key + seed from public inputs.
 *
 * The whole point of this helper is that BOTH sender and recipient (or any
 * observer) can recompute the same bytes from `(sender, recipient, mint,
 * randNonce)` — the only secret in the system is the random nonce, which the
 * sender publishes in the memo anyway.
 */
export async function deriveTransitMaterial(
  sender: PublicKey,
  recipient: PublicKey,
  mint: PublicKey,
  randNonce: Uint8Array,
): Promise<{ sharedKey: Uint8Array; transitSeed: Uint8Array }> {
  if (randNonce.length !== 4) {
    throw new RangeError(`randNonce must be 4 bytes (got ${randNonce.length})`);
  }
  const sharedKey = await sha256(
    TE.encode("staccana-transit-shared-v1"),
    sender.toBuffer(),
    recipient.toBuffer(),
    mint.toBuffer(),
    randNonce,
  );
  const transitSeed = await sha256(
    TE.encode("staccana-transit-seed-v1"),
    sharedKey,
  );
  return { sharedKey, transitSeed };
}

/**
 * Wrap the transit seed under the shared key with AES-256-GCM.
 *
 * The shared key is 32 bytes — exactly an AES-256-GCM key. A fresh 12-byte
 * IV is sampled per-call (and prepended to the ciphertext so decrypt can
 * recover it). NOT real ECDH — see file docstring for the trade-off.
 */
async function aesGcmWrap(
  sharedKey: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(sharedKey),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new Uint8Array(plaintext)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

async function aesGcmUnwrap(
  sharedKey: Uint8Array,
  blob: Uint8Array,
): Promise<Uint8Array> {
  if (blob.length < 12 + 16) {
    throw new RangeError("transit memo blob too short");
  }
  const iv = blob.slice(0, 12);
  const ct = blob.slice(12);
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(sharedKey),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, new Uint8Array(ct)),
  );
}

/**
 * Build the memo payload: `<prefix><base64(rand_nonce(4) || wrapped_seed)>`.
 */
export async function buildTransitMemoText(
  sender: PublicKey,
  recipient: PublicKey,
  mint: PublicKey,
  randNonce: Uint8Array,
): Promise<{ memoText: string; transitSeed: Uint8Array }> {
  const { sharedKey, transitSeed } = await deriveTransitMaterial(
    sender,
    recipient,
    mint,
    randNonce,
  );
  const wrapped = await aesGcmWrap(sharedKey, transitSeed);
  const payload = new Uint8Array(4 + wrapped.length);
  payload.set(randNonce, 0);
  payload.set(wrapped, 4);
  return {
    memoText: TRANSIT_MEMO_PREFIX + bytesToBase64(payload),
    transitSeed,
  };
}

/**
 * Decode a memo text produced by `buildTransitMemoText`. Returns `null` if
 * the memo doesn't start with the transit prefix or fails to decode/decrypt.
 */
export async function tryDecodeTransitMemo(
  memoText: string,
  sender: PublicKey,
  recipient: PublicKey,
  mint: PublicKey,
): Promise<{ randNonce: Uint8Array; transitSeed: Uint8Array } | null> {
  if (!memoText.startsWith(TRANSIT_MEMO_PREFIX)) return null;
  let payload: Uint8Array;
  try {
    payload = base64ToBytes(memoText.slice(TRANSIT_MEMO_PREFIX.length));
  } catch {
    return null;
  }
  if (payload.length < 4 + 12 + 16) return null;
  const randNonce = payload.slice(0, 4);
  const wrapped = payload.slice(4);
  try {
    const { sharedKey } = await deriveTransitMaterial(
      sender,
      recipient,
      mint,
      randNonce,
    );
    const transitSeed = await aesGcmUnwrap(sharedKey, wrapped);
    if (transitSeed.length !== 32) return null;
    return { randNonce, transitSeed };
  } catch {
    return null;
  }
}

/**
 * Build the canonical Memo ix carrying `memoText` as its data payload.
 *
 * SPL Memo v3 takes utf-8 bytes directly as instruction data; no signers are
 * required when there are no signer keys passed.
 */
export function buildMemoInstruction(memoText: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(memoText, "utf-8"),
  });
}

// ---------------------------------------------------------------------------
// Sender — assemble the 5 ixs + memo for the transit-account flow.
// ---------------------------------------------------------------------------

/**
 * Derive a transit ElGamal keypair seed from the (sender, recipient, mint,
 * nonce) tuple. The 32-byte output is the same shape that
 * `deriveElGamalKeypair(...).secretSeed` returns — the proof API consumes it
 * directly.
 */
export async function deriveTransitElGamalSeed(
  sender: PublicKey,
  recipient: PublicKey,
  mint: PublicKey,
  randNonce: Uint8Array,
): Promise<Uint8Array> {
  const { transitSeed } = await deriveTransitMaterial(
    sender,
    recipient,
    mint,
    randNonce,
  );
  return transitSeed;
}

/**
 * The transit ElGamal "pubkey" we hand to ConfigureAccount + Transfer.
 *
 * REAL implementation should curve25519-scalar-reduce the seed, lift it to
 * Ristretto255, and serialize. We don't ship a curve lib in the bundle — the
 * proof API does this for us internally when generating the validity proof.
 * For ix-data purposes Token-22 only checks pubkey equality (the on-chain
 * verifier looks at the proof context, not the ix data), so we forward
 * `seed.slice(0, 32)` as a placeholder pubkey. The validity proof's context
 * data DOES contain the canonical Ristretto-encoded pubkey — that's what
 * actually gets compared on-chain via the instructions sysvar.
 *
 * Same shortcut the existing `SendPanelInner` already takes (see the call
 * in `components/SecretBalancePanel.tsx` where `senderElgamalPubkey =
 * secretSeed.slice(0, 32)`). We follow that convention here for consistency.
 */
export function transitElGamalPubkeyPlaceholder(
  transitSeed: Uint8Array,
): Uint8Array {
  return transitSeed.slice(0, 32);
}

/**
 * Build the 5-ix bundle (CreateAccount + InitializeAccount3 + ConfigureAccount
 * (+ its proof verify ix) + Transfer (+ 3 proof verify ixs) + SetAuthority +
 * Memo) for the sender side of the transit-account hack.
 *
 * Caller is responsible for:
 *
 *   - signing the resulting v0 tx with BOTH `sender` and `bundle.newAccount`
 *   - passing `STACCANA_MASTER_LUT` so the tx fits in 1232 bytes
 */
export async function prepareTransitSendIxs(
  args: PrepareTransitSendArgs,
): Promise<TransitSendBundle> {
  const randNonce = args.randNonce ?? new Uint8Array(4);
  if (!args.randNonce) crypto.getRandomValues(randNonce);
  if (randNonce.length !== 4) {
    throw new RangeError(`randNonce must be 4 bytes (got ${randNonce.length})`);
  }

  const transitSeed = await deriveTransitElGamalSeed(
    args.sender,
    args.recipient,
    args.mint,
    randNonce,
  );
  const transitPk = transitElGamalPubkeyPlaceholder(transitSeed);

  const newAccount = Keypair.generate();

  const lamports = await args.connection.getMinimumBalanceForRentExemption(
    TRANSIT_ACCOUNT_SIZE,
  );

  const ixs: TransactionInstruction[] = [];

  // 1. SystemProgram::CreateAccount — pre-allocate the new account at the
  //    Token-22 program so the next ix can initialize it.
  ixs.push(
    SystemProgram.createAccount({
      fromPubkey: args.sender,
      newAccountPubkey: newAccount.publicKey,
      lamports,
      space: TRANSIT_ACCOUNT_SIZE,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
  );

  // 2. Token22::InitializeAccount3 — sender becomes the INITIAL owner so they
  //    can sign the next ConfigureAccount + Transfer ixs. We flip ownership to
  //    the recipient at the end via SetAuthority.
  ixs.push(
    createInitializeAccount3Instruction(
      newAccount.publicKey,
      args.mint,
      args.sender,
      TOKEN_2022_PROGRAM_ID,
    ),
  );

  // 3. CT::ConfigureAccount — sets up the ConfidentialTransferAccount
  //    extension under the *transit* ElGamal keypair. Returns 2 ixs:
  //    [ConfigureAccount, VerifyPubkeyValidity]. The verify ix lives at
  //    offset +1 (the relative-instruction-offset form).
  const decryptableZero = new Uint8Array(AE_CIPHERTEXT_LEN); // 36 zero bytes
  const configureIxs = await buildConfigureAccountInstruction({
    payer: args.sender,
    ata: newAccount.publicKey,
    mint: args.mint,
    owner: args.sender,
    maximumPendingBalanceCreditCounter: 65535n,
    elgamalPubkey: transitPk,
    decryptableZeroBalance: decryptableZero,
    elgamalSeed: transitSeed,
    fetchImpl: args.fetchImpl,
  });
  for (const ix of configureIxs) ixs.push(ix);

  // 4. CT::Transfer — confidential transfer from sender's ATA to the new
  //    transit account, encrypted under the transit ElGamal pubkey. Returns
  //    [Transfer, VerifyEq, VerifyValidity, VerifyRange].
  const transferIxs = await buildTransferInstruction({
    ata: args.senderAta,
    destinationAta: newAccount.publicKey,
    mint: args.mint,
    owner: args.sender,
    amount: args.amount,
    senderElgamalPubkey: args.senderElgamalPubkey,
    recipientElgamalPubkey: transitPk,
    auditorElgamalPubkey: new Uint8Array(32),
    newSourceDecryptableAvailableBalance: args.newSourceDecryptableAvailableBalance,
    elgamalSeed: args.senderElgamalSeed,
    fetchImpl: args.fetchImpl,
  });
  for (const ix of transferIxs) ixs.push(ix);

  // 5. Token22::SetAuthority(AccountOwner, current=sender, new=recipient).
  //    Flips ownership AFTER the transfer lands. The recipient will use this
  //    later to call Withdraw + EmptyAccount + ConfigureAccount + Deposit +
  //    ApplyPendingBalance to migrate funds onto their canonical ATA.
  ixs.push(
    createSetAuthorityInstruction(
      newAccount.publicKey,
      args.sender,
      AuthorityType.AccountOwner,
      args.recipient,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  );

  // 6. Memo — emits the transit seed wrapped under the (sender, recipient,
  //    mint, randNonce)-derived shared key. Recipient detector finds it via
  //    the `staccana:transit:v1:` prefix.
  const { memoText } = await buildTransitMemoText(
    args.sender,
    args.recipient,
    args.mint,
    randNonce,
  );
  ixs.push(buildMemoInstruction(memoText));

  return { newAccount, instructions: ixs, transitSeed, randNonce };
}

// ---------------------------------------------------------------------------
// Recipient — scan for + claim transit accounts.
// ---------------------------------------------------------------------------

/** A pending transit account the recipient can claim. */
export interface PendingTransitAccount {
  /** The non-canonical Token-22 account address. */
  account: PublicKey;
  /** Mint of the held tokens. */
  mint: PublicKey;
  /** Raw, public `amount` field (always 0 for confidential balance — kept for ATA shape). */
  publicAmount: bigint;
  /** Whether the CT extension is initialized + has a non-trivial balance. */
  hasConfidentialBalance: boolean;
}

/**
 * Token-22 base account `mint` field is at offset 0; `owner` is at offset 32;
 * `amount` is at offset 64 (u64 LE). Same as legacy SPL token.
 */
const TOKEN_OWNER_OFFSET = 32;

/**
 * Scan for Token-22 accounts owned by `recipient` whose CT extension has
 * non-zero pending or available ciphertext (likely a transit drop).
 *
 * Filters by `dataSize = TRANSIT_ACCOUNT_SIZE` so we don't pull every Token-22
 * account on the cluster — only ones sized for ConfidentialTransferAccount
 * extension. Note: a recipient's own canonical ATA could also be this size if
 * they self-configured CT — we filter those out by comparing the ElGamal pubkey
 * inside the extension to the recipient's own derived pubkey (caller passes
 * that in as `recipientCanonicalElgamalPubkey`).
 */
export async function scanPendingTransitAccounts(
  connection: Connection,
  recipient: PublicKey,
  recipientCanonicalElgamalPubkey: Uint8Array | null,
): Promise<PendingTransitAccount[]> {
  // We accept that `getProgramAccounts` returns the FULL set of Token-22
  // accounts matching the (size, owner-offset) filters. Token-22 accounts
  // exist in millions on mainnet — staccana is small enough for this to be
  // tolerable. Future work: switch to an indexer.
  const resp = await connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      { dataSize: TRANSIT_ACCOUNT_SIZE },
      {
        memcmp: {
          offset: TOKEN_OWNER_OFFSET,
          bytes: recipient.toBase58(),
        },
      },
    ],
  });

  const out: PendingTransitAccount[] = [];
  for (const { pubkey, account } of resp) {
    const data =
      account.data instanceof Uint8Array
        ? account.data
        : new Uint8Array(account.data);
    // Ignore accounts that aren't CT-configured at all.
    const ext = findConfidentialTransferAccountExtension(data);
    if (!ext) continue;
    if (ext.length < 1 + 32) continue;
    const elgamalPk = ext.slice(1, 33);

    // Skip the recipient's own canonical ATA: same wallet as owner AND same
    // ElGamal pubkey as the one they already use for self-claim.
    if (
      recipientCanonicalElgamalPubkey &&
      recipientCanonicalElgamalPubkey.length === 32 &&
      bytesEqual(elgamalPk, recipientCanonicalElgamalPubkey)
    ) {
      continue;
    }

    // Skip accounts where the CT extension is fully zeroed out (empty after
    // a previous claim). We treat any non-zero byte after the elgamal_pubkey
    // (which covers pending_lo/hi + available + counters) as "still has
    // funds in flight".
    const tail = ext.slice(33);
    let nonZero = false;
    for (let i = 0; i < tail.length; i++) {
      if (tail[i] !== 0) {
        nonZero = true;
        break;
      }
    }
    if (!nonZero) continue;

    // Pull mint + public `amount` from the base account.
    let mintPk: PublicKey;
    try {
      mintPk = new PublicKey(data.slice(0, 32));
    } catch {
      continue;
    }
    let publicAmount = 0n;
    for (let i = 0; i < 8; i++) {
      publicAmount |= BigInt(data[64 + i]) << BigInt(i * 8);
    }

    out.push({
      account: pubkey,
      mint: mintPk,
      publicAmount,
      hasConfidentialBalance: true,
    });
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Find the transit memo for `account` by scanning its create signature(s).
 *
 * We look at the most recent ~10 signatures touching `account` and pick the
 * first parsed-tx that contains a Memo ix whose data starts with the transit
 * prefix. The CREATE tx is always among the earliest — so for accounts with
 * lots of activity, we sort oldest-first.
 */
export async function findTransitMemoForAccount(
  connection: Connection,
  account: PublicKey,
  sender: PublicKey | null,
  recipient: PublicKey,
  mint: PublicKey,
): Promise<{ randNonce: Uint8Array; transitSeed: Uint8Array; sender: PublicKey } | null> {
  const sigs = await connection.getSignaturesForAddress(account, { limit: 25 });
  if (sigs.length === 0) return null;
  // Oldest first — the create tx is the originating one.
  sigs.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));

  for (const sigInfo of sigs) {
    const tx = await connection.getParsedTransaction(sigInfo.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) continue;

    // Find the fee-payer / first signer — for the transit flow this is the
    // sender wallet. We use this both to derive the shared key and to label
    // the resulting claim entry in the UI.
    const accountKeys = tx.transaction.message.accountKeys;
    const txSender = accountKeys[0]?.pubkey;
    if (!txSender) continue;
    if (sender && !txSender.equals(sender)) continue;

    // Walk the parsed instructions looking for a Memo program ix.
    const ixs = tx.transaction.message.instructions;
    for (const ix of ixs) {
      // Parsed memo ixs come back as `{ program: 'spl-memo', parsed: '...' }`
      // OR as a partially-decoded `{ programId, data }` shape. Handle both.
      let memoText: string | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyIx = ix as any;
      if (
        anyIx.programId &&
        anyIx.programId.equals &&
        anyIx.programId.equals(MEMO_PROGRAM_ID)
      ) {
        if (typeof anyIx.parsed === "string") memoText = anyIx.parsed;
        else if (typeof anyIx.data === "string") {
          // `data` is base58-encoded for partially-decoded ixs.
          try {
            const bs58 = await import("bs58");
            const bytes = bs58.default.decode(anyIx.data);
            memoText = new TextDecoder().decode(bytes);
          } catch {
            // ignore
          }
        }
      } else if (anyIx.program === "spl-memo" && typeof anyIx.parsed === "string") {
        memoText = anyIx.parsed;
      }
      if (!memoText) continue;

      const decoded = await tryDecodeTransitMemo(
        memoText,
        txSender,
        recipient,
        mint,
      );
      if (decoded) {
        return { ...decoded, sender: txSender };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// EmptyAccount ix builder (no helper in @solana/spl-token v0.4 for the
// confidential extension's variant; we hand-encode the wire format).
// ---------------------------------------------------------------------------

/**
 * `ConfidentialTransferInstruction::EmptyAccount` — ix discriminator 4.
 *
 * Wire layout: `[27, 4, proof_instruction_offset:i8]` = 3 bytes.
 *
 * Account ordering (per `inner_empty_account` in spl-token-2022):
 *
 *   0. token_account            [writable]
 *   1. instructions sysvar      [readonly]
 *   2. authority/owner          [signer, readonly]
 *
 * Requires a `VerifyZeroCiphertext` proof at offset +1. Caller is responsible
 * for fetching that proof from the proof API and chaining it after this ix.
 *
 * NOTE: We don't ship a `buildEmptyAccountInstruction` helper for the full
 * proof flow because the recipient claim path is currently TODO — it would
 * need a fresh `zero_ciphertext` proof generated server-side. See the
 * `buildEmptyAccountIxRaw` placeholder below.
 */
export function buildEmptyAccountIxRaw(args: {
  ata: PublicKey;
  owner: PublicKey;
  proofInstructionOffset?: number;
}): TransactionInstruction {
  const data = new Uint8Array([
    CT_EXT_TAG,
    CT_IX.EmptyAccount,
    (args.proofInstructionOffset ?? 1) & 0xff,
  ]);
  return new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: args.ata, isWritable: true, isSigner: false },
      // Sysvar instructions (id loaded lazily to avoid a cycle).
      {
        pubkey: new PublicKey("Sysvar1nstructions1111111111111111111111111"),
        isWritable: false,
        isSigner: false,
      },
      { pubkey: args.owner, isWritable: false, isSigner: true },
    ],
    data: Buffer.from(data),
  });
}

// ---------------------------------------------------------------------------
// Re-exports the claim panel needs.
// ---------------------------------------------------------------------------

export {
  AE_CIPHERTEXT_LEN,
  TOKEN_BASE_ACCOUNT_SIZE,
  EXT_TYPE_CONFIDENTIAL_TRANSFER_ACCOUNT,
  buildApplyPendingBalanceInstruction,
  buildWithdrawInstruction,
};
