/**
 * Confidential Transfer ZK proof generator (server-side).
 *
 * This route generates the ZK proofs needed by Token-22's
 * `ConfidentialTransfer` extension. The on-chain program expects pre-verified
 * proof bytes for: `PubkeyValidity` (configure_account), `ZeroCiphertext`
 * (configure_account, modern variant), `CiphertextCommitmentEquality` +
 * `BatchedRangeProofU128` + `BatchedGroupedCiphertext3HandlesValidity`
 * (transfer), and `CiphertextCommitmentEquality` + `BatchedRangeProofU64`
 * (withdraw).
 *
 * Status (2026-05): all six proof kinds + the `pedersen_commit` helper are
 * wired against `@staccoverflow/zk-proofs-wasm@0.3.0` — a wasm-bindgen build
 * of the Rust `solana-zk-sdk` proof generators. The `pedersen_commit` kind
 * is a synthetic helper (no proof, no secret) that returns the canonical
 * 32-byte commitment used by Transfer's range-proof lo/hi inputs.
 *
 * --- Trust model ---
 *
 * All of these proofs need the user's ElGamal *secret scalar*. The client POSTs
 * an `elgamalSeed` (the bytes of a wallet signature over a stable domain
 * string — see `lib/confidential.ts`). The seed never leaves this Node
 * runtime: no logging, no persistence, no third-party fetch. Callers that
 * want a stricter trust model should run this route on their own infra
 * (it's pure, no chain RPC) or move to a client-side wasm path (the same
 * crate can be built with `wasm-pack build --target web`; it's published in
 * the same npm package and ready to import dynamically from the browser when
 * the time comes — currently the package only ships the nodejs build).
 *
 * Wire format:
 *
 * Request:
 * ```json
 * {
 *   "proofKind": "pubkey_validity"
 *               | "zero_ciphertext"
 *               | "ciphertext_commitment_equality"
 *               | "batched_range_proof_u64"
 *               | "batched_range_proof_u128"
 *               | "batched_grouped_ciphertext_3_handles_validity",
 *   "params": { ...kind-specific... }
 * }
 * ```
 *
 * Response (success): `{ "proofData": <base64>, "contextData": <base64> }`
 * Response (bad input): 400 with `{ "error": "...", "details": "..." }`.
 * Response (proof generation failure): 500 with `{ "error": "proof_generation_failed", ... }`.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPPORTED_KINDS = new Set([
  "pubkey_validity",
  "zero_ciphertext",
  "ciphertext_commitment_equality",
  "batched_range_proof_u64",
  "batched_range_proof_u128",
  "batched_grouped_ciphertext_3_handles_validity",
  "pedersen_commit",
]);

/**
 * Synthetic kinds that don't need an ElGamal secret seed. `pedersen_commit`
 * is a deterministic helper: callers pass `(amount, opening)` and get back
 * the canonical 32-byte Pedersen commitment used by the BatchedRangeProofU128
 * lo/hi inputs in `Transfer`. We accept (and ignore) `elgamalSeed` for these
 * kinds so the existing client wrapper can stay uniform.
 */
const NO_SEED_KINDS = new Set(["pedersen_commit"]);

interface ProofRequestBody {
  proofKind?: unknown;
  params?: unknown;
}

function decodeB64(name: string, value: unknown, expectedLen?: number): Uint8Array {
  if (typeof value !== "string") {
    throw new Response(
      JSON.stringify({ error: "missing_param", details: `params.${name} must be base64 string.` }),
      { status: 400 },
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(value, "base64"));
  } catch {
    throw new Response(
      JSON.stringify({ error: "invalid_param", details: `params.${name} must be valid base64.` }),
      { status: 400 },
    );
  }
  if (expectedLen !== undefined && bytes.length !== expectedLen) {
    throw new Response(
      JSON.stringify({
        error: "invalid_param",
        details: `params.${name} must be ${expectedLen} bytes (got ${bytes.length}).`,
      }),
      { status: 400 },
    );
  }
  return bytes;
}

function decodeAmountU64(name: string, value: unknown): bigint {
  // Accept JSON numbers, strings, or bigint-likes.
  if (typeof value === "string") {
    try {
      return BigInt(value);
    } catch {
      throw new Response(
        JSON.stringify({ error: "invalid_param", details: `params.${name} must be a u64.` }),
        { status: 400 },
      );
    }
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "bigint") return value;
  throw new Response(
    JSON.stringify({ error: "invalid_param", details: `params.${name} must be a u64.` }),
    { status: 400 },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: ProofRequestBody;
  try {
    body = (await request.json()) as ProofRequestBody;
  } catch {
    return NextResponse.json(
      { error: "invalid_json", details: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const proofKind = body.proofKind;
  if (typeof proofKind !== "string") {
    return NextResponse.json(
      { error: "missing_proof_kind", details: "Body must include `proofKind`." },
      { status: 400 },
    );
  }

  if (!SUPPORTED_KINDS.has(proofKind)) {
    return NextResponse.json(
      {
        error: "unknown_proof_kind",
        details: `Unknown proofKind: ${proofKind}.`,
        supported: [...SUPPORTED_KINDS],
      },
      { status: 400 },
    );
  }

  const params = (body.params ?? {}) as Record<string, unknown>;

  // Every "real" proof kind needs an ElGamal seed (the user's secret).
  // `pedersen_commit` is a synthetic kind used to derive deterministic
  // commitment bytes for the range proof — no secret needed.
  const seedRequired = !NO_SEED_KINDS.has(proofKind);
  let elgamalSeed: Uint8Array = new Uint8Array(0);
  if (seedRequired) {
    try {
      elgamalSeed = decodeB64("elgamalSeed", params.elgamalSeed);
    } catch (resp) {
      if (resp instanceof Response) return NextResponse.json(JSON.parse(await resp.text()), { status: resp.status });
      throw resp;
    }
    if (elgamalSeed.length < 32) {
      return NextResponse.json(
        {
          error: "invalid_elgamal_seed",
          details: `elgamalSeed must be at least 32 bytes (got ${elgamalSeed.length}).`,
        },
        { status: 400 },
      );
    }
  }

  // Lazy-load the wasm module — keeps cold start down on routes that never
  // touch confidential transfer.
  let zk: typeof import("@staccoverflow/zk-proofs-wasm");
  try {
    zk = await import("@staccoverflow/zk-proofs-wasm");
  } catch (err) {
    return NextResponse.json(
      {
        error: "wasm_load_failed",
        details:
          "Failed to load @staccoverflow/zk-proofs-wasm. Run `pnpm install` " +
          "to fetch the wasm bundle. Cause: " +
          (err instanceof Error ? err.message : String(err)),
      },
      { status: 500 },
    );
  }

  try {
    let bundle: { context: Uint8Array; proof: Uint8Array };

    switch (proofKind) {
      case "pubkey_validity": {
        bundle = zk.pubkey_validity_proof(elgamalSeed);
        break;
      }
      case "zero_ciphertext": {
        const ct = decodeB64("ciphertext", params.ciphertext, 64);
        bundle = zk.zero_ciphertext_proof(elgamalSeed, ct);
        break;
      }
      case "ciphertext_commitment_equality": {
        const ct = decodeB64("ciphertext", params.ciphertext, 64);
        const commitment = decodeB64("commitment", params.commitment, 32);
        const opening = decodeB64("opening", params.opening, 32);
        const amount = decodeAmountU64("amount", params.amount);
        bundle = zk.ciphertext_commitment_equality_proof(
          elgamalSeed,
          ct,
          commitment,
          opening,
          amount,
        );
        break;
      }
      case "batched_range_proof_u64":
      case "batched_range_proof_u128": {
        // Both kinds share the same param shape; only the bit-length-sum
        // constraint and the underlying generator differ.
        const commitments = decodeB64("commitments", params.commitments);
        const openings = decodeB64("openings", params.openings);
        if (!Array.isArray(params.amounts)) {
          return NextResponse.json(
            { error: "invalid_param", details: "params.amounts must be an array of u64." },
            { status: 400 },
          );
        }
        if (!Array.isArray(params.bitLengths)) {
          return NextResponse.json(
            { error: "invalid_param", details: "params.bitLengths must be an array of u8." },
            { status: 400 },
          );
        }
        const amountsBig = new BigUint64Array(
          (params.amounts as unknown[]).map((v, i) => decodeAmountU64(`amounts[${i}]`, v)),
        );
        const bitLengths = new Uint8Array(params.bitLengths as number[]);
        bundle =
          proofKind === "batched_range_proof_u64"
            ? zk.batched_range_proof_u64(commitments, openings, amountsBig, bitLengths)
            : zk.batched_range_proof_u128(commitments, openings, amountsBig, bitLengths);
        break;
      }
      case "pedersen_commit": {
        // Synthetic kind: returns the canonical 32-byte Pedersen commitment
        // for `(amount, opening)` so callers can feed it as a range-proof
        // input. We pack the 32 bytes into `proofData` and leave
        // `contextData` empty, keeping the response shape uniform with
        // every other kind.
        const opening = decodeB64("opening", params.opening, 32);
        const amount = decodeAmountU64("amount", params.amount);
        const commitment = zk.pedersen_commit(amount, opening);
        bundle = { proof: commitment, context: new Uint8Array(0) };
        break;
      }
      case "batched_grouped_ciphertext_3_handles_validity": {
        const sourcePubkey = decodeB64("sourcePubkey", params.sourcePubkey, 32);
        const destPubkey = decodeB64("destinationPubkey", params.destinationPubkey, 32);
        const auditorPubkey = decodeB64("auditorPubkey", params.auditorPubkey, 32);
        const amountLo = decodeAmountU64("amountLo", params.amountLo);
        const amountHi = decodeAmountU64("amountHi", params.amountHi);
        const openingLo = decodeB64("openingLo", params.openingLo, 32);
        const openingHi = decodeB64("openingHi", params.openingHi, 32);
        bundle = zk.batched_grouped_ciphertext_3_handles_validity_proof(
          sourcePubkey,
          destPubkey,
          auditorPubkey,
          amountLo,
          amountHi,
          openingLo,
          openingHi,
        );
        break;
      }
      default:
        // Unreachable thanks to SUPPORTED_KINDS gate above, but keeps tsc honest.
        return NextResponse.json(
          { error: "unknown_proof_kind", details: `Unknown proofKind: ${proofKind}.` },
          { status: 400 },
        );
    }

    return NextResponse.json({
      proofData: Buffer.from(bundle.proof).toString("base64"),
      contextData: Buffer.from(bundle.context).toString("base64"),
    });
  } catch (err) {
    if (err instanceof Response) {
      return NextResponse.json(JSON.parse(await err.text()), { status: err.status });
    }
    return NextResponse.json(
      {
        error: "proof_generation_failed",
        details: err instanceof Error ? err.message : String(err),
        proofKind,
      },
      { status: 500 },
    );
  }
}

/** GET handler returns a small documentation/status payload. Useful for
 *  health-checks and curl-driven debugging. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    status: "live",
    backend: "@staccoverflow/zk-proofs-wasm@0.3.0",
    supportedKinds: [...SUPPORTED_KINDS],
    docs:
      "POST { proofKind, params: { elgamalSeed: base64, ...kind-specific } } " +
      "-> { proofData, contextData } (base64).",
  });
}
