import { NextResponse } from "next/server";

/**
 * GET /api/claim/<pubkey>
 *
 * Returns this wallet's lazy-claim leaf + Merkle proof + amount, if it was
 * included in the genesis snapshot.
 *
 * Why an edge function and not a static JSON: the genesis snapshot has
 * 85,655,757 claimable leaves. Bundling that in /public/ would be ~3 GB and
 * the browser would have to download all of it just to find one row. The edge
 * function looks up the single row for the requested pubkey.
 *
 * Storage backing (TODO — currently returns 404 for everyone):
 *   The full leaf set is sharded by the first 2 hex chars of the pubkey
 *   (256 shards, ~330k leaves each, ~30 MB per shard) and uploaded to
 *   Vercel Blob. This handler reads the right shard, finds the matching leaf,
 *   recomputes the proof on-demand, and returns:
 *     { pubkey, lamports, leafIndex, proof: [hex...], leafHash: hex }
 *
 * Tonight's deploy ships the route with the placeholder behavior so the
 * frontend stops fetching the giant snapshot. Real shard-backed lookup lands
 * once `tools/snapshot-fork` is re-run against the live mainnet snapshot
 * and the shards are uploaded.
 */
export const runtime = "edge";

export async function GET(
  _request: Request,
  context: { params: Promise<{ pubkey: string }> },
): Promise<NextResponse> {
  const { pubkey } = await context.params;

  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pubkey)) {
    return NextResponse.json(
      { error: "invalid base58 pubkey" },
      { status: 400 },
    );
  }

  // TODO(snapshot-shards): query the matching shard from Vercel Blob, look
  // up the leaf by pubkey, recompute the proof, return it. For now: 404 so
  // the frontend renders "not eligible / snapshot index pending".
  return NextResponse.json(
    {
      error: "snapshot index pending",
      message:
        "The lazy-claim snapshot index is being re-uploaded. Single-pubkey lookup will return your leaf + Merkle proof here once shard 00..ff are bundled.",
      pubkey,
    },
    { status: 404 },
  );
}
