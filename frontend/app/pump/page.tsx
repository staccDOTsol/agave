"use client";

/**
 * Secret-pump launchpad landing page.
 *
 * Shows:
 *  - The live trade ticker (top-of-page horizontal scroll)
 *  - The "King of the Hill" hero (curve closest to graduation)
 *  - Sort tabs (New / Trending / About to Graduate / Top Volume)
 *  - Search filter (name / symbol / mint)
 *  - Token grid of every active bonding curve, with optional metadata
 *  - "Launch" CTA → /pump/create
 *
 * Curve enumeration uses `getProgramAccounts` filtered by the BondingCurve
 * Anchor discriminator. The on-chain program does not expose name/symbol/uri
 * via the curve PDA directly — those live on the Token-2022 mint metadata —
 * so for now we render placeholder identities derived from the mint pubkey
 * and the create flow's data: URI metadata blob (TODO: wire MetadataPointer).
 */

import { useConnection } from "@solana/wallet-adapter-react";
import { Plus, Search, Sparkles } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { KingOfTheHill, type KothCandidate } from "@/components/pump/king-of-the-hill";
import { TokenCard, TokenCardSkeleton } from "@/components/pump/token-card";
import { TradeTicker } from "@/components/pump/trade-ticker";
import { Button } from "@/components/ui/button";
import { BONDING_CURVE_DISCRIMINATOR } from "@/lib/anchor";
import {
  decodeBondingCurve,
  type BondingCurve,
} from "@/lib/pump";
import {
  fetchPumpMetadata,
  graduationPct,
  type ParsedTrade,
  type PumpTokenMetadata,
} from "@/lib/pump-extra";
import { SECRET_PUMP_PROGRAM_ID } from "@/lib/staccana";
import { cn } from "@/lib/utils";

interface CurveRow {
  pubkey: string;
  curve: BondingCurve;
  metadata: PumpTokenMetadata | null;
  /** Last-trade timestamp + side for the per-card flash indicator. */
  tickMs?: number;
  tickSide?: "buy" | "sell";
}

type Sort = "new" | "trending" | "graduating" | "volume";

const SORTS: { id: Sort; label: string; hint: string }[] = [
  { id: "trending", label: "Trending", hint: "by SOL raised" },
  { id: "new", label: "New", hint: "freshest curves" },
  { id: "graduating", label: "About to graduate", hint: "≥ 80% to threshold" },
  { id: "volume", label: "Top volume", hint: "by tokens dispensed" },
];

export default function PumpPage(): JSX.Element {
  const { connection } = useConnection();
  const [rows, setRows] = useState<CurveRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("trending");
  const [query, setQuery] = useState("");

  const fetchAll = useCallback(async () => {
    setError(null);
    try {
      const bs58 = (await import("bs58")).default;
      const raw = await connection.getProgramAccounts(SECRET_PUMP_PROGRAM_ID, {
        commitment: "confirmed",
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: bs58.encode(BONDING_CURVE_DISCRIMINATOR),
            },
          },
        ],
      });
      const decoded: CurveRow[] = [];
      for (const r of raw.slice(0, 100)) {
        try {
          const curve = decodeBondingCurve(new Uint8Array(r.account.data));
          decoded.push({
            pubkey: r.pubkey.toBase58(),
            curve,
            metadata: null,
          });
        } catch {
          /* skip non-decodable */
        }
      }
      setRows(decoded);
      // Kick off metadata fetches lazily — none if no URI is known. For now
      // the on-chain BondingCurve doesn't carry the URI, so this is a no-op
      // until the MetadataPointer wiring lands. (Curves created via the
      // updated /pump/create flow can write their metadata into the token
      // mint's MetadataPointer extension; not implemented in this pass.)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [connection]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Live trade ticks → flash matching cards.
  const onTickerTrade = useCallback((t: ParsedTrade) => {
    if (!t.mint) return;
    setRows((prev) =>
      prev
        ? prev.map((r) =>
            r.curve.mint.toBase58() === t.mint
              ? { ...r, tickMs: Date.now(), tickSide: t.side }
              : r,
          )
        : prev,
    );
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = query.trim().toLowerCase();
    let r = rows.filter((row) => {
      if (!q) return true;
      const mint = row.curve.mint.toBase58().toLowerCase();
      const meta = row.metadata;
      return (
        mint.includes(q) ||
        (meta?.name ?? "").toLowerCase().includes(q) ||
        (meta?.symbol ?? "").toLowerCase().includes(q)
      );
    });
    switch (sort) {
      case "trending":
        r = r
          .slice()
          .sort((a, b) => Number(b.curve.realSolReserves - a.curve.realSolReserves));
        break;
      case "new":
        // No creation timestamp on-chain. Use graduationSlot=0 (i.e. all
        // non-graduated) sorted by descending pubkey lex order as a stable
        // proxy. TODO: derive creation slot via getSignaturesForAddress.
        r = r
          .slice()
          .sort((a, b) => (a.pubkey < b.pubkey ? 1 : -1));
        break;
      case "graduating":
        r = r
          .filter((row) => graduationPct(row.curve) >= 80 && !row.curve.graduated)
          .sort((a, b) => Number(b.curve.realSolReserves - a.curve.realSolReserves));
        break;
      case "volume":
        r = r
          .slice()
          .sort((a, b) => Number(b.curve.totalTokensDispensed - a.curve.totalTokensDispensed));
        break;
    }
    return r;
  }, [rows, query, sort]);

  const kothCandidates: KothCandidate[] = useMemo(
    () =>
      (rows ?? []).map((r) => ({
        pubkey: r.pubkey,
        curve: r.curve,
        metadata: r.metadata,
      })),
    [rows],
  );

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <p className="font-mono text-xs uppercase tracking-widest text-primary">pump</p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Confidential launchpad
          </h1>
          <p className="max-w-2xl text-muted-foreground">
            Bonding-curve token launches on staccana. Token-2022 with the Confidential
            Transfer extension active by default — token amounts on subsequent transfers are
            encrypted, structurally defeating sniper bots and copy-trading.
          </p>
        </div>
        <Link href="/pump/create">
          <Button size="lg" className="gap-2">
            <Plus className="h-4 w-4" />
            Launch a token
          </Button>
        </Link>
      </header>

      <TradeTicker onTrade={onTickerTrade} />

      {rows && rows.length > 0 ? <KingOfTheHill candidates={kothCandidates} /> : null}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {SORTS.map((s) => (
            <button
              type="button"
              key={s.id}
              onClick={() => setSort(s.id)}
              title={s.hint}
              className={cn(
                "rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                sort === s.id
                  ? "border-primary/60 bg-primary/15 text-foreground"
                  : "border-border/60 bg-secondary/40 text-muted-foreground hover:bg-secondary/70",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, symbol, or mint…"
            className="w-full rounded-full border border-border bg-card/60 py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground/70 focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load curves: {error}{" "}
          <button
            type="button"
            onClick={fetchAll}
            className="ml-2 underline underline-offset-2"
          >
            Retry
          </button>
        </div>
      ) : null}

      {!rows ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <TokenCardSkeleton key={i} />
          ))}
        </div>
      ) : filtered && filtered.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((r) => (
            <TokenCard
              key={r.pubkey}
              pubkey={r.pubkey}
              curve={r.curve}
              metadata={r.metadata}
              lastTickMs={r.tickMs}
              lastTickSide={r.tickSide}
            />
          ))}
        </div>
      ) : (
        <EmptyState query={query} sort={sort} />
      )}
    </div>
  );
}

function EmptyState({ query, sort }: { query: string; sort: Sort }): JSX.Element {
  const isFiltered = query.trim().length > 0 || sort === "graduating";
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-card/40 p-12 text-center">
      <Sparkles className="h-10 w-10 text-primary/70" />
      {isFiltered ? (
        <>
          <h3 className="text-lg font-semibold">No matching tokens yet</h3>
          <p className="max-w-md text-sm text-muted-foreground">
            Try clearing your filters or switching back to Trending. New launches show up here
            as soon as the create tx confirms.
          </p>
        </>
      ) : (
        <>
          <h3 className="text-lg font-semibold">No tokens have launched yet</h3>
          <p className="max-w-md text-sm text-muted-foreground">
            Be the first. Spinning up a curve costs only the rent for the mint, vault, and
            curve PDA — and you get the entire virtual allocation seeded into the AMM
            automatically.
          </p>
          <Link href="/pump/create">
            <Button className="gap-2">
              <Plus className="h-4 w-4" />
              Launch the first token
            </Button>
          </Link>
        </>
      )}
    </div>
  );
}
