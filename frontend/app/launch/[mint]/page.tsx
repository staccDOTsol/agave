"use client";

/**
 * Token detail view.
 *
 * Layout:
 *  - Header: avatar, name/symbol, mint pubkey + copy button, social links
 *  - Stats grid: price / mcap / progress / virtual reserves
 *  - Sparkline chart (curve preview — see components/pump/sparkline.tsx)
 *  - Buy/Sell tabbed trade widget (mirrors the canonical math in lib/pump.ts)
 *  - Recent trades feed (parsed from program logs)
 *  - Top holders list (Token-22 getProgramAccounts)
 *  - Comments placeholder ("Coming soon")
 */

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  MessageCircle,
  Twitter,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { CurveSparkline } from "@/components/pump/sparkline";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/use-toast";
import {
  GRADUATION_THRESHOLD_SOL,
  bondingCurvePda,
  buildBuyInstruction,
  buildCreateAtaIdempotentInstruction,
  buildSellInstruction,
  decodeBondingCurve,
  quoteBuy,
  quoteSell,
  spotPriceQ64,
  token22Ata,
  type BondingCurve,
} from "@/lib/pump";
import {
  fetchPumpMetadata,
  fetchRecentTrades,
  fetchTopHolders,
  fmtCompact,
  fmtRelative,
  fmtSol,
  graduationPct,
  marketCapSol,
  priceLamportsPerBaseUnitToSolPerToken,
  type HolderRow,
  type ParsedTrade,
  type PumpTokenMetadata,
} from "@/lib/pump-extra";
import {
  SECRET_PUMP_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  explorerTxUrl,
} from "@/lib/staccana";
import { cn, truncatePubkey } from "@/lib/utils";

export default function TokenDetailPage(): JSX.Element {
  const params = useParams<{ mint: string }>();
  const { connection } = useConnection();
  const { toast } = useToast();

  const mint = useMemo(() => {
    try {
      return new PublicKey(params.mint);
    } catch {
      return null;
    }
  }, [params.mint]);

  const [curve, setCurve] = useState<BondingCurve | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<PumpTokenMetadata | null>(null);
  const [trades, setTrades] = useState<ParsedTrade[] | null>(null);
  const [holders, setHolders] = useState<HolderRow[] | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Load curve PDA.
  useEffect(() => {
    if (!mint) {
      setLoadState("error");
      setErrorMsg("Invalid mint pubkey in URL");
      return;
    }
    let cancelled = false;
    setLoadState("loading");
    const pda = bondingCurvePda(mint);
    connection
      .getAccountInfo(pda, "confirmed")
      .then((acct) => {
        if (cancelled) return;
        if (!acct) {
          setLoadState("missing");
          return;
        }
        try {
          const decoded = decodeBondingCurve(new Uint8Array(acct.data));
          setCurve(decoded);
          setLoadState("ready");
        } catch (err) {
          setLoadState("error");
          setErrorMsg(err instanceof Error ? err.message : String(err));
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadState("error");
        setErrorMsg(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [mint, connection, refreshNonce]);

  // Load trades.
  useEffect(() => {
    if (!mint) return;
    let cancelled = false;
    fetchRecentTrades(connection, SECRET_PUMP_PROGRAM_ID, { mint, limit: 50 }).then((t) => {
      if (!cancelled) setTrades(t);
    });
    const id = setInterval(() => {
      fetchRecentTrades(connection, SECRET_PUMP_PROGRAM_ID, { mint, limit: 50 }).then((t) => {
        if (!cancelled) setTrades(t);
      });
    }, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [mint, connection, refreshNonce]);

  // Load holders.
  useEffect(() => {
    if (!mint) return;
    let cancelled = false;
    fetchTopHolders(connection, mint, TOKEN_2022_PROGRAM_ID, 20).then((h) => {
      if (!cancelled) setHolders(h);
    });
    return () => {
      cancelled = true;
    };
  }, [mint, connection, refreshNonce]);

  // Try to load metadata. The on-chain BondingCurve PDA doesn't store the
  // URI, but if the user supplied an image / socials at create time the
  // launchpad would have packed them into the Token-2022 MetadataPointer.
  // TODO(metadata): wire MetadataPointer → JSON URI dereferencing. For now we
  // don't have a way to discover the URI from this page alone; metadata
  // remains null and we render placeholder identity.
  useEffect(() => {
    let cancelled = false;
    if (!mint) return;
    // Cheap probe: try the data: URI we'd derive from a default-named token.
    // No-op for now; intentionally left as a stub so the call site is wired.
    (async () => {
      const meta = await fetchPumpMetadata(""); // returns null
      if (!cancelled) setMetadata(meta);
    })();
    return () => {
      cancelled = true;
    };
  }, [mint]);

  if (!mint) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Card>
          <CardContent className="p-6 text-sm text-destructive">
            Invalid mint pubkey in URL.
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loadState === "loading") return <DetailSkeleton mint={mint} />;
  if (loadState === "missing") {
    return (
      <div className="space-y-4">
        <BackLink />
        <Card>
          <CardHeader>
            <CardTitle>Curve not found</CardTitle>
            <CardDescription>
              No BondingCurve PDA exists for this mint on the staccana cluster yet.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-xs font-mono text-muted-foreground">{mint.toBase58()}</p>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (loadState === "error" || !curve) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Card>
          <CardContent className="p-6 text-sm text-destructive">
            Failed to load curve: {errorMsg ?? "unknown error"}
          </CardContent>
        </Card>
      </div>
    );
  }

  const mintB58 = mint.toBase58();
  const reserves = {
    realSolReserves: curve.realSolReserves,
    realTokenReserves: curve.realTokenReserves,
  };
  const priceSol = priceLamportsPerBaseUnitToSolPerToken(spotPriceQ64(reserves), 9);
  const mcap = marketCapSol(curve);
  const progress = graduationPct(curve);
  const realSol = Number(curve.realSolReserves) / 1e9;
  const name = metadata?.name?.trim() || `Token ${truncatePubkey(mintB58, 4, 4)}`;
  const symbol = metadata?.symbol?.trim() || mintB58.slice(0, 4).toUpperCase();

  const onTradeSuccess = () => {
    setRefreshNonce((n) => n + 1);
    toast({ variant: "success", title: "Trade submitted, refreshing curve…" });
  };

  return (
    <div className="space-y-6">
      <BackLink />

      <DetailHeader
        mint={mint}
        name={name}
        symbol={symbol}
        image={metadata?.image}
        twitter={metadata?.twitter}
        telegram={metadata?.telegram}
        website={metadata?.website}
        graduated={curve.graduated}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-2">
              <div>
                <CardTitle className="text-lg">Bonding-curve preview</CardTitle>
                <CardDescription>
                  Deterministic price function — this curve <em>must</em> follow this
                  trajectory. Plot is the spot price as a function of real SOL deposited.
                </CardDescription>
              </div>
              <span className="rounded bg-secondary/40 px-2 py-1 text-[10px] font-mono uppercase text-muted-foreground">
                Synthetic
              </span>
            </CardHeader>
            <CardContent>
              <div className="h-32 w-full">
                <CurveSparkline reserves={reserves} />
              </div>
            </CardContent>
          </Card>

          <StatsGrid
            priceSol={priceSol}
            mcap={mcap}
            progress={progress}
            realSol={realSol}
            curve={curve}
          />

          <RecentTrades trades={trades} />

          <HoldersPanel holders={holders} />

          <Card>
            <CardHeader>
              <CardTitle>Comments</CardTitle>
              <CardDescription>Coming soon — chat lives off-chain.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                We&apos;ll wire a lightweight chat backend (Postgres + websockets) once the
                launchpad has enough live mints to justify the moderation lift. For now,
                use Twitter / Telegram links above to coordinate.
              </p>
            </CardContent>
          </Card>
        </div>

        <aside>
          <TradePanel mint={mint} curve={curve} onSuccess={onTradeSuccess} />
        </aside>
      </div>
    </div>
  );
}

function BackLink(): JSX.Element {
  return (
    <Link
      href="/launch"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" />
      Back to launchpad
    </Link>
  );
}

function DetailHeader({
  mint,
  name,
  symbol,
  image,
  twitter,
  telegram,
  website,
  graduated,
}: {
  mint: PublicKey;
  name: string;
  symbol: string;
  image?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  graduated: boolean;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    navigator.clipboard.writeText(mint.toBase58()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Card className="overflow-hidden">
      <CardContent className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center">
        {image ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={image}
            alt={symbol}
            className="h-20 w-20 shrink-0 rounded-2xl border-2 border-border/60 object-cover"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl border-2 border-border/60 bg-gradient-to-br from-primary/30 via-primary/10 to-secondary/40 text-2xl font-bold uppercase">
            {symbol.slice(0, 3)}
          </div>
        )}
        <div className="flex-1 space-y-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <h1 className="text-2xl font-semibold sm:text-3xl">{name}</h1>
            <span className="text-lg text-muted-foreground">${symbol}</span>
            {graduated ? (
              <span className="rounded bg-amber-400/20 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-300">
                Graduated
              </span>
            ) : (
              <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-300">
                Live
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono text-muted-foreground">
              {truncatePubkey(mint.toBase58(), 8, 8)}
            </span>
            <button
              type="button"
              onClick={onCopy}
              className="inline-flex items-center gap-1 rounded border border-border/60 bg-secondary/40 px-2 py-0.5 text-[10px] uppercase text-muted-foreground hover:bg-secondary"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? "Copied" : "Copy"}
            </button>
            {twitter ? (
              <SocialLink href={twitter} icon={<Twitter className="h-3.5 w-3.5" />} label="Twitter" />
            ) : null}
            {telegram ? (
              <SocialLink href={telegram} icon={<MessageCircle className="h-3.5 w-3.5" />} label="Telegram" />
            ) : null}
            {website ? (
              <SocialLink href={website} icon={<Globe className="h-3.5 w-3.5" />} label="Website" />
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SocialLink({
  href,
  icon,
  label,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
}): JSX.Element {
  // Sanity-filter: only follow http(s) URLs to avoid executing javascript: URIs.
  const safe = /^https?:\/\//.test(href) ? href : "#";
  return (
    <a
      href={safe}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded border border-border/60 bg-secondary/40 px-2 py-0.5 text-[10px] uppercase text-muted-foreground hover:bg-secondary"
    >
      {icon} {label}
    </a>
  );
}

function StatsGrid({
  priceSol,
  mcap,
  progress,
  realSol,
  curve,
}: {
  priceSol: number;
  mcap: number;
  progress: number;
  realSol: number;
  curve: BondingCurve;
}): JSX.Element {
  return (
    <Card>
      <CardContent className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Price (SOL)" value={fmtSol(priceSol, 6)} />
        <Stat label="Mcap" value={`${fmtCompact(mcap)} SOL`} />
        <Stat label="Raised" value={`${realSol.toFixed(3)} SOL`} />
        <Stat label="To graduate" value={`${(85 - realSol).toFixed(3)} SOL`} />
        <Stat label="Virtual SOL" value={"30.000 SOL"} />
        <Stat
          label="Curve tokens"
          value={fmtCompact(Number(curve.realTokenReserves) / 1e9)}
        />
        <div className="col-span-full">
          <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
            <span>Graduation progress (85 SOL threshold)</span>
            <span className="font-mono">{progress.toFixed(2)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-secondary/60">
            <div
              className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-primary to-amber-400 transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-md border border-border/40 bg-secondary/20 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}

function RecentTrades({ trades }: { trades: ParsedTrade[] | null }): JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent trades</CardTitle>
        <CardDescription>Last 50 trades against this curve. Refreshes every 10s.</CardDescription>
      </CardHeader>
      <CardContent>
        {trades === null ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-8 w-full animate-pulse rounded bg-secondary/40" />
            ))}
          </div>
        ) : trades.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No trades yet. Be the first to swap against this curve.
          </p>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="pb-2 font-normal">Side</th>
                  <th className="pb-2 font-normal">User</th>
                  <th className="pb-2 text-right font-normal">SOL</th>
                  <th className="pb-2 text-right font-normal">When</th>
                  <th className="pb-2 text-right font-normal">Tx</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.signature} className="border-t border-border/40">
                    <td className="py-2">
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-bold uppercase",
                          t.side === "buy"
                            ? "bg-emerald-500/20 text-emerald-300"
                            : "bg-rose-500/20 text-rose-300",
                        )}
                      >
                        {t.side}
                      </span>
                    </td>
                    <td className="py-2 font-mono text-muted-foreground">
                      {truncatePubkey(t.user, 4, 4)}
                    </td>
                    <td className="py-2 text-right font-mono">
                      {(Number(t.solLamports) / 1e9).toFixed(4)}
                    </td>
                    <td className="py-2 text-right text-muted-foreground">
                      {fmtRelative(t.blockTime)}
                    </td>
                    <td className="py-2 text-right">
                      <a
                        href={explorerTxUrl(t.signature)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        {truncatePubkey(t.signature, 4, 4)}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HoldersPanel({ holders }: { holders: HolderRow[] | null }): JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top holders</CardTitle>
        <CardDescription>
          Top 20 by Token-2022 balance. Curve PDA holds the unsold reserve.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {holders === null ? (
          <p className="text-xs text-muted-foreground">
            Holder lookup pending — Token-2022 confidential balances may be opaque to off-chain
            indexers.
          </p>
        ) : holders.length === 0 ? (
          <p className="text-xs text-muted-foreground">No holders yet.</p>
        ) : (
          <div className="space-y-1.5">
            {holders.map((h, i) => (
              <div
                key={h.owner}
                className="flex items-center justify-between rounded border border-border/40 bg-secondary/20 px-3 py-1.5 text-xs"
              >
                <div className="flex items-center gap-2">
                  <span className="w-5 text-[10px] text-muted-foreground">#{i + 1}</span>
                  <span className="font-mono">{truncatePubkey(h.owner, 6, 6)}</span>
                </div>
                <span className="font-mono text-muted-foreground">{h.pct.toFixed(2)}%</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Trade panel
// ---------------------------------------------------------------------------

function TradePanel({
  mint,
  curve,
  onSuccess,
}: {
  mint: PublicKey;
  curve: BondingCurve;
  onSuccess: () => void;
}): JSX.Element {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const { toast } = useToast();

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amountStr, setAmountStr] = useState("");
  const [slipBps, setSlipBps] = useState(100);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const baseAmount = useMemo(() => parseDecimalToBigInt(amountStr, 9), [amountStr]);

  const quote = useMemo(() => {
    if (!baseAmount || baseAmount <= 0n) return null;
    const reserves = {
      realSolReserves: curve.realSolReserves,
      realTokenReserves: curve.realTokenReserves,
    };
    if (side === "buy") {
      const r = quoteBuy(reserves, baseAmount, 0n, curve.graduated);
      if ("error" in r) return { error: r.error };
      const minOut = (r.tokensOut * (10_000n - BigInt(slipBps))) / 10_000n;
      return { ok: r, minOut, kind: "buy" as const };
    }
    const r = quoteSell(reserves, baseAmount, 0n, curve.graduated);
    if ("error" in r) return { error: r.error };
    const minOut = (r.solToSeller * (10_000n - BigInt(slipBps))) / 10_000n;
    return { ok: r, minOut, kind: "sell" as const };
  }, [baseAmount, side, slipBps, curve]);

  const onSubmit = useCallback(async () => {
    setError(null);
    if (!publicKey || !connected) {
      setError("Connect a wallet first");
      return;
    }
    if (curve.graduated) {
      setError("Curve has already graduated — no further trades.");
      return;
    }
    if (!quote || "error" in quote) {
      setError(quote && "error" in quote ? `Quote: ${quote.error}` : "Enter an amount");
      return;
    }
    if (!baseAmount) return;
    try {
      const tx = new Transaction();
      const ata = token22Ata(publicKey, mint);
      if (side === "buy") {
        tx.add(buildCreateAtaIdempotentInstruction({ payer: publicKey, owner: publicKey, mint }));
        tx.add(
          buildBuyInstruction({
            mint,
            buyerTokenAccount: ata,
            buyer: publicKey,
            solIn: baseAmount,
            minTokensOut: quote.minOut,
          }),
        );
      } else {
        tx.add(
          buildSellInstruction({
            mint,
            sellerTokenAccount: ata,
            seller: publicKey,
            tokensIn: baseAmount,
            minSolOut: quote.minOut,
          }),
        );
      }
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      setSubmitting(true);
      const sig = await sendTransaction(tx, connection);
      setSubmitting(false);
      toast({
        variant: "success",
        title: side === "buy" ? "Buy submitted" : "Sell submitted",
        description: (
          <a
            className="font-mono text-xs underline underline-offset-2"
            href={explorerTxUrl(sig)}
            target="_blank"
            rel="noreferrer"
          >
            {truncatePubkey(sig, 8, 8)}
          </a>
        ),
      });
      onSuccess();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setSubmitting(false);
      toast({ variant: "destructive", title: "Trade failed", description: msg });
    }
  }, [publicKey, connected, curve.graduated, quote, baseAmount, side, mint, connection, sendTransaction, toast, onSuccess]);

  return (
    <Card className="sticky top-24">
      <CardHeader>
        <CardTitle>Trade</CardTitle>
        <CardDescription>1% fee · slippage check on-chain</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-border/60 bg-secondary/20 p-1">
          <button
            type="button"
            onClick={() => setSide("buy")}
            className={cn(
              "rounded-md py-2 text-sm font-semibold transition-colors",
              side === "buy"
                ? "bg-emerald-500/20 text-emerald-300"
                : "text-muted-foreground hover:bg-secondary/40",
            )}
          >
            Buy
          </button>
          <button
            type="button"
            onClick={() => setSide("sell")}
            className={cn(
              "rounded-md py-2 text-sm font-semibold transition-colors",
              side === "sell"
                ? "bg-rose-500/20 text-rose-300"
                : "text-muted-foreground hover:bg-secondary/40",
            )}
          >
            Sell
          </button>
        </div>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">
            {side === "buy" ? "SOL in" : "Tokens in"}
          </span>
          <div className="relative">
            <input
              type="text"
              inputMode="decimal"
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              placeholder="0.0"
              className="w-full rounded-md border border-input bg-background px-3 py-2 pr-14 font-mono text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
              {side === "buy" ? "SOL" : "TOK"}
            </span>
          </div>
        </label>

        {side === "buy" ? (
          <div className="flex flex-wrap gap-1.5">
            {[0.1, 0.5, 1, 5].map((v) => (
              <button
                type="button"
                key={v}
                onClick={() => setAmountStr(v.toString())}
                className="rounded-md border border-border/60 bg-secondary/40 px-2 py-1 text-[10px] uppercase text-muted-foreground hover:bg-secondary"
              >
                {v} SOL
              </button>
            ))}
          </div>
        ) : null}

        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Slippage tolerance (bps)</span>
          <input
            type="number"
            min={0}
            max={5000}
            value={slipBps}
            onChange={(e) => setSlipBps(Number(e.target.value))}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>

        {quote ? (
          "error" in quote ? (
            <p className="text-xs text-destructive">Quote: {quote.error}</p>
          ) : quote.kind === "buy" ? (
            <dl className="grid grid-cols-2 gap-1.5 rounded-md border border-border/40 bg-secondary/20 p-3 text-xs">
              <dt className="text-muted-foreground">Tokens out</dt>
              <dd className="text-right font-mono">{(Number(quote.ok.tokensOut) / 1e9).toFixed(4)}</dd>
              <dt className="text-muted-foreground">Fee</dt>
              <dd className="text-right font-mono">{(Number(quote.ok.solFee) / 1e9).toFixed(6)} SOL</dd>
              <dt className="text-muted-foreground">Min received</dt>
              <dd className="text-right font-mono">{(Number(quote.minOut) / 1e9).toFixed(4)}</dd>
              {quote.ok.graduates ? (
                <>
                  <dt className="text-amber-300">Graduates</dt>
                  <dd className="text-right text-amber-300">yes</dd>
                </>
              ) : null}
            </dl>
          ) : (
            <dl className="grid grid-cols-2 gap-1.5 rounded-md border border-border/40 bg-secondary/20 p-3 text-xs">
              <dt className="text-muted-foreground">SOL out gross</dt>
              <dd className="text-right font-mono">{(Number(quote.ok.solOutGross) / 1e9).toFixed(6)}</dd>
              <dt className="text-muted-foreground">Fee</dt>
              <dd className="text-right font-mono">{(Number(quote.ok.solFee) / 1e9).toFixed(6)} SOL</dd>
              <dt className="text-muted-foreground">SOL to you</dt>
              <dd className="text-right font-mono">{(Number(quote.ok.solToSeller) / 1e9).toFixed(6)}</dd>
              <dt className="text-muted-foreground">Min received</dt>
              <dd className="text-right font-mono">{(Number(quote.minOut) / 1e9).toFixed(6)}</dd>
            </dl>
          )
        ) : (
          <p className="text-xs text-muted-foreground">Enter an amount to see a quote.</p>
        )}

        <Button
          onClick={onSubmit}
          disabled={submitting || curve.graduated || !quote || (quote && "error" in quote)}
          className={cn(
            "w-full",
            side === "buy"
              ? "bg-emerald-500 text-emerald-950 hover:bg-emerald-400"
              : "bg-rose-500 text-rose-950 hover:bg-rose-400",
          )}
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Submitting…
            </>
          ) : side === "buy" ? (
            "Buy"
          ) : (
            "Sell"
          )}
        </Button>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {curve.graduated ? (
          <p className="rounded border border-amber-400/40 bg-amber-400/10 p-2 text-[11px] text-amber-200">
            This curve has graduated. Trading on the bonding curve is closed; the Raydium pool
            migration runs out-of-band.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function DetailSkeleton({ mint }: { mint: PublicKey }): JSX.Element {
  return (
    <div className="space-y-6">
      <BackLink />
      <Card>
        <CardContent className="flex items-center gap-4 p-6">
          <div className="h-20 w-20 animate-pulse rounded-2xl bg-secondary/60" />
          <div className="flex-1 space-y-2">
            <div className="h-6 w-1/2 animate-pulse rounded bg-secondary/60" />
            <div className="h-4 w-1/3 animate-pulse rounded bg-secondary/40" />
            <div className="font-mono text-xs text-muted-foreground">{truncatePubkey(mint.toBase58(), 8, 8)}</div>
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-md bg-secondary/40" />
        ))}
      </div>
    </div>
  );
}

function parseDecimalToBigInt(input: string, decimals: number): bigint | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.startsWith("-")) return null;
  const dot = trimmed.indexOf(".");
  let intPart = dot < 0 ? trimmed : trimmed.slice(0, dot);
  let fracPart = dot < 0 ? "" : trimmed.slice(dot + 1);
  if (intPart && !/^\d+$/.test(intPart)) return null;
  if (fracPart && !/^\d+$/.test(fracPart)) return null;
  let intVal = 0n;
  if (intPart) intVal = BigInt(intPart);
  if (fracPart.length < decimals) fracPart = fracPart.padEnd(decimals, "0");
  else fracPart = fracPart.slice(0, decimals);
  let fracVal = 0n;
  if (fracPart) fracVal = BigInt(fracPart);
  const total = intVal * 10n ** BigInt(decimals) + fracVal;
  if (total < 0n || total > (1n << 64n) - 1n) return null;
  return total;
}

// Force this page to be client-rendered with dynamic params (no SSG attempts).
// Nothing extra needed — using `useParams()` already opts us out of static
// generation for this route.
