import { NextResponse } from "next/server";

/**
 * GET /api/megadrop/<pubkey>
 *
 * Returns this wallet's megadrop allocation (if any) + Merkle proof against
 * the on-chain root `0x4cd7098ee9dec30f8fa3818401dbb74876302a1075b429d20c6e324c7f07d237`.
 *
 * The megadrop set is small (826 holders), so unlike `/api/claim/<pubkey>`
 * we can keep the whole allocations.json in /public/ and the edge function
 * just filters it to the requested pubkey. That keeps the response size
 * tiny (~200 bytes) regardless of how big the airdrop grows in future
 * iterations.
 *
 * Response shape:
 *   { pubkey, lamports, leafIndex, proof: [hex...] } on hit
 *   404 with explanation on miss
 */
export const runtime = "edge";

interface MegadropAllocation {
  pubkey: string;
  lamports: number | string;
  leafIndex?: number;
  proof?: string[];
}

export async function GET(
  request: Request,
  context: { params: Promise<{ pubkey: string }> },
): Promise<NextResponse> {
  const { pubkey } = await context.params;

  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pubkey)) {
    return NextResponse.json(
      { error: "invalid base58 pubkey" },
      { status: 400 },
    );
  }

  const origin = new URL(request.url).origin;
  const allocationsUrl = `${origin}/megadrop/allocations.json`;

  let allocations: MegadropAllocation[] = [];
  try {
    const r = await fetch(allocationsUrl, {
      // edge runtime caches responses by default; this is fine — the
      // allocations.json is immutable for the lifetime of a deploy
      cache: "force-cache",
    });
    if (!r.ok) {
      return NextResponse.json(
        {
          error: `failed to load allocations.json (${r.status})`,
          allocationsUrl,
        },
        { status: 500 },
      );
    }
    allocations = (await r.json()) as MegadropAllocation[];
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message, allocationsUrl },
      { status: 500 },
    );
  }

  const hit = allocations.find((a) => a.pubkey === pubkey);
  if (!hit) {
    return NextResponse.json(
      {
        error: "not in megadrop set",
        message:
          "This wallet did not hold based_stacc_0 NFTs or proofv3 tokens at the snapshot block.",
        pubkey,
        merkleRoot:
          "0x4cd7098ee9dec30f8fa3818401dbb74876302a1075b429d20c6e324c7f07d237",
      },
      { status: 404 },
    );
  }

  return NextResponse.json(hit);
}
