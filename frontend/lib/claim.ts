/**
 * Claim transaction construction.
 *
 * Mirrors `tools/claim-cli/src/tx.rs` in TypeScript:
 *   - Builds the claim message per SPEC §4.2
 *   - Builds the ed25519 precompile instruction inspecting the inline signature
 *   - Builds the lazy-claim `claim` instruction per SPEC §4.1 (7 accounts)
 *
 * Wallets ship their own ed25519 signing entry points (`signMessage`) so we
 * never see the private key. We get the signature back, then lay out the
 * Solana built-in ed25519 precompile data ourselves.
 */

import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  type Connection,
} from "@solana/web3.js";

import type { InclusionProof } from "./merkle";
import {
  ED25519_PROGRAM_ID,
  LAZY_CLAIM_PROGRAM_ID,
  STACCANA_CLAIM_DOMAIN,
  SYSTEM_PROGRAM_ID,
  SYSVAR_INSTRUCTIONS_ID,
  claimedMarkerPda,
  programStatePda,
  treasuryPda,
} from "./staccana";
import { u64LeBytes } from "./merkle";

/**
 * Build the message that the user's mainnet keypair must sign for the claim.
 * Matches `build_claim_message` in Rust.
 *
 * `STACCANA_CLAIM_V1` || pubkey (32) || lamports.to_le_bytes() (8) || LAZY_CLAIM_PROGRAM_ID (32)
 */
export function buildClaimMessage(pubkey: PublicKey, lamports: bigint): Uint8Array {
  const domain = new TextEncoder().encode(STACCANA_CLAIM_DOMAIN);
  const out = new Uint8Array(domain.length + 32 + 8 + 32);
  let off = 0;
  out.set(domain, off);
  off += domain.length;
  out.set(pubkey.toBytes(), off);
  off += 32;
  out.set(u64LeBytes(lamports), off);
  off += 8;
  out.set(LAZY_CLAIM_PROGRAM_ID.toBytes(), off);
  return out;
}

/** Layout constants for the ed25519 precompile instruction data. */
const ED25519_PUBKEY_SIZE = 32;
const ED25519_SIGNATURE_SIZE = 64;
const ED25519_OFFSETS_SIZE = 14;
const ED25519_OFFSETS_START = 2;
const ED25519_DATA_START = ED25519_OFFSETS_SIZE + ED25519_OFFSETS_START;

/**
 * Build the ed25519 precompile instruction. Wire format:
 *
 * ```
 * [num_signatures: u8 (=1)] [padding: u8] [offsets: 14 bytes]
 * [pubkey: 32] [signature: 64] [message: variable]
 * ```
 *
 * The lazy-claim program reads this back via the Instructions sysvar (SPEC
 * §4.3 step 4). Mirrors `build_ed25519_precompile_instruction` in Rust.
 */
export function buildEd25519PrecompileInstruction(
  signerPubkey: PublicKey,
  signature: Uint8Array,
  message: Uint8Array,
): TransactionInstruction {
  if (signature.length !== ED25519_SIGNATURE_SIZE) {
    throw new Error(`ed25519 signature must be ${ED25519_SIGNATURE_SIZE} bytes (got ${signature.length})`);
  }
  const pubkeyBytes = signerPubkey.toBytes();
  if (pubkeyBytes.length !== ED25519_PUBKEY_SIZE) {
    throw new Error(`ed25519 pubkey must be ${ED25519_PUBKEY_SIZE} bytes (got ${pubkeyBytes.length})`);
  }

  const publicKeyOffset = ED25519_DATA_START;
  const signatureOffset = publicKeyOffset + ED25519_PUBKEY_SIZE;
  const messageDataOffset = signatureOffset + ED25519_SIGNATURE_SIZE;
  const total = messageDataOffset + message.length;

  const data = new Uint8Array(total);
  // [num_signatures, padding]
  data[0] = 1;
  data[1] = 0;
  // offsets struct (14 bytes, all u16 LE):
  //   signature_offset, signature_instruction_index (= u16::MAX = self),
  //   public_key_offset, public_key_instruction_index (= u16::MAX),
  //   message_data_offset, message_data_size,
  //   message_instruction_index (= u16::MAX)
  let off = ED25519_OFFSETS_START;
  writeU16Le(data, off, signatureOffset); off += 2;
  writeU16Le(data, off, 0xffff); off += 2;
  writeU16Le(data, off, publicKeyOffset); off += 2;
  writeU16Le(data, off, 0xffff); off += 2;
  writeU16Le(data, off, messageDataOffset); off += 2;
  writeU16Le(data, off, message.length); off += 2;
  writeU16Le(data, off, 0xffff); off += 2;

  data.set(pubkeyBytes, publicKeyOffset);
  data.set(signature, signatureOffset);
  data.set(message, messageDataOffset);

  return new TransactionInstruction({
    programId: ED25519_PROGRAM_ID,
    keys: [],
    data: Buffer.from(data),
  });
}

function writeU16Le(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
}

/**
 * Encode `ClaimArgs` per SPEC §4.1:
 *
 * 1. pubkey            (32 bytes)
 * 2. lamports          (8 bytes LE)
 * 3. proof_len         (2 bytes LE u16)
 * 4. proof             (32 * proof_len bytes)
 * 5. proof_flags       (ceil(proof_len / 8) bytes)
 *
 * Mirrors `ClaimArgs::to_wire_bytes` in Rust.
 */
export function encodeClaimArgs(proof: InclusionProof): Uint8Array {
  const proofLen = proof.proof.length;
  if (proofLen > 0xffff) {
    throw new RangeError(`proof_len does not fit in u16: ${proofLen}`);
  }
  const expectedFlagBytes = Math.ceil(proofLen / 8);
  if (proof.proofFlags.length !== expectedFlagBytes) {
    throw new Error(
      `proof_flags length mismatch: got ${proof.proofFlags.length}, expected ${expectedFlagBytes}`,
    );
  }
  const total = 32 + 8 + 2 + 32 * proofLen + proof.proofFlags.length;
  const out = new Uint8Array(total);
  let off = 0;
  out.set(proof.pubkey.toBytes(), off); off += 32;
  out.set(u64LeBytes(proof.lamports), off); off += 8;
  writeU16Le(out, off, proofLen); off += 2;
  for (const sibling of proof.proof) {
    if (sibling.length !== 32) {
      throw new Error(`sibling hash must be 32 bytes (got ${sibling.length})`);
    }
    out.set(sibling, off);
    off += 32;
  }
  out.set(proof.proofFlags, off);
  return out;
}

/**
 * Build the lazy-claim `claim` instruction. Account ordering matches SPEC §4.1
 * (7 accounts):
 *
 * 0. recipient                 [writable]
 * 1. lazy-claim program state  [readonly]
 * 2. sysvar Instructions       [readonly]
 * 3. treasury PDA              [writable]
 * 4. claimed-marker PDA        [writable]
 * 5. fee payer                 [writable, signer]
 * 6. system program            [readonly]
 */
export function buildClaimInstruction(args: {
  proof: InclusionProof;
  payer: PublicKey;
}): TransactionInstruction {
  const recipient = args.proof.pubkey;
  const data = encodeClaimArgs(args.proof);
  return new TransactionInstruction({
    programId: LAZY_CLAIM_PROGRAM_ID,
    keys: [
      { pubkey: recipient, isWritable: true, isSigner: false },
      { pubkey: programStatePda(), isWritable: false, isSigner: false },
      { pubkey: SYSVAR_INSTRUCTIONS_ID, isWritable: false, isSigner: false },
      { pubkey: treasuryPda(), isWritable: true, isSigner: false },
      { pubkey: claimedMarkerPda(recipient), isWritable: true, isSigner: false },
      { pubkey: args.payer, isWritable: true, isSigner: true },
      { pubkey: SYSTEM_PROGRAM_ID, isWritable: false, isSigner: false },
    ],
    data: Buffer.from(data),
  });
}

/**
 * Assemble the full claim transaction: ed25519 precompile ix immediately
 * followed by the claim ix, with `payer` as the fee payer.
 *
 * Caller is responsible for fetching a recent blockhash (we do that here for
 * convenience but accept an injected one for tests).
 */
export async function buildClaimTransaction(args: {
  proof: InclusionProof;
  signature: Uint8Array;
  signerPubkey: PublicKey;
  message: Uint8Array;
  payer: PublicKey;
  connection: Connection;
  recentBlockhash?: string;
}): Promise<Transaction> {
  const ed25519Ix = buildEd25519PrecompileInstruction(args.signerPubkey, args.signature, args.message);
  const claimIx = buildClaimInstruction({ proof: args.proof, payer: args.payer });

  const tx = new Transaction();
  tx.add(ed25519Ix);
  tx.add(claimIx);
  tx.feePayer = args.payer;

  const blockhash = args.recentBlockhash ?? (await args.connection.getLatestBlockhash("confirmed")).blockhash;
  tx.recentBlockhash = blockhash;
  return tx;
}
