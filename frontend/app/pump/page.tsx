"use client";

/**
 * Secret-pump page.
 *
 * Three sub-views, surfaced as tabs:
 *
 * - Browse — list every active bonding curve via getProgramAccounts filtered
 *   by the BondingCurve discriminator. Each row shows symbol/mint, current
 *   spot price, market-cap proxy (real_sol_reserves), graduation progress.
 * - Trade — pick a curve, buy/sell along it. Inputs are SOL-in (buy) or
 *   tokens-in (sell); we quote outputs via the pure curve math port in
 *   `lib/pump.ts`. Submits the corresponding `buy` / `sell` ix.
 * - Create — form to create a new bonding curve / Token-22 mint with
 *   Confidential Transfer extension active.
 *
 * Curve math is byte-equal to the on-chain Rust impl (verified via
 * `tests/pump-curve.test.ts`), so the previewed outputs match what the chain
 * will actually compute.
 */

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/use-toast";
import {
  GRADUATION_THRESHOLD_SOL,
  bondingCurvePda,
  buildBuyInstruction,
  buildCreateAtaIdempotentInstruction,
  buildCreateInstruction,
  buildSellInstruction,
  decodeBondingCurve,
  initialReserves,
  q64ToFloatPump,
  quoteBuy,
  quoteSell,
  spotPriceQ64,
  token22Ata,
  type BondingCurve,
} from "@/lib/pump";
import { BONDING_CURVE_DISCRIMINATOR } from "@/lib/anchor";
import { explorerTxUrl, SECRET_PUMP_PROGRAM_ID } from "@/lib/staccana";
import { truncatePubkey } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type Tab = "browse" | "trade" | "create";

export default function PumpPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>("browse");
  const [selectedMint, setSelectedMint] = useState<PublicKey | null>(null);

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">pump</p>
        <h1 className="text-3xl font-semibold tracking-tight">Launch a confidential token</h1>
        <p className="max-w-2xl text-muted-foreground">
          secret-pump is a bonding-curve launchpad on top of Token-22 with the Confidential
          Transfer Extension active by default. Per-trade SOL deltas are visible (Solana exposes
          lamports at the protocol level), but token amounts on subsequent confidential
          transfers are encrypted, defeating naive copy-trading and anti-snipe bots.
        </p>
      </header>

      <div className="flex gap-2">
        <TabButton selected={tab === "browse"} onClick={() => setTab("browse")}>
          Browse
        </TabButton>
        <TabButton
          selected={tab === "trade"}
          onClick={() => setTab("trade")}
        >
          Trade
        </TabButton>
        <TabButton selected={tab === "create"} onClick={() => setTab("create")}>
          Create
        </TabButton>
      </div>

      {tab === "browse" ? (
        <BrowseTab
          onPick={(mint) => {
            setSelectedMint(mint);
            setTab("trade");
          }}
        />
      ) : null}
      {tab === "trade" ? <TradeTab mint={selectedMint} setMint={setSelectedMint} /> : null}
      {tab === "create" ? <CreateTab /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Browse: getProgramAccounts → list of BondingCurve
// ---------------------------------------------------------------------------

interface CurveRow {
  pubkey: PublicKey;
  curve: BondingCurve;
}

function BrowseTab({ onPick }: { onPick: (mint: PublicKey) => void }): JSX.Element {
  const { connection } = useConnection();
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; rows: CurveRow[] }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const fetchAll = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      // Discriminator filter — Anchor accounts always start with their 8-byte
      // discriminator. memcmp with offset 0.
      // Convert to base58 since `getProgramAccounts` filter expects that.
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
      const rows: CurveRow[] = [];
      for (const r of raw) {
        try {
          const curve = decodeBondingCurve(new Uint8Array(r.account.data));
          rows.push({ pubkey: r.pubkey, curve });
        } catch {
          // Skip accounts that don't decode (e.g. sized differently in future).
        }
      }
      // Sort by graduation progress descending.
      rows.sort((a, b) =>
        Number(b.curve.realSolReserves - a.curve.realSolReserves),
      );
      setState({ kind: "ready", rows });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [connection]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Active bonding curves</CardTitle>
          <CardDescription>
            Listed via `getProgramAccounts` filtered by the BondingCurve Anchor discriminator.
            Click a row to trade against it.
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={fetchAll}>
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {state.kind === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading curves…</p>
        ) : null}
        {state.kind === "error" ? (
          <p className="text-sm text-destructive">{state.message}</p>
        ) : null}
        {state.kind === "ready" && state.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No bonding curves found. The secret-pump program has not been deployed on this
            cluster yet, or no one has called `create` against it.
          </p>
        ) : null}
        {state.kind === "ready" && state.rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="pb-2">Mint</th>
                  <th className="pb-2">Spot price (Q64.64)</th>
                  <th className="pb-2 text-right">Real SOL</th>
                  <th className="pb-2 text-right">Graduation</th>
                  <th className="pb-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {state.rows.map((r) => {
                  const r0 = {
                    realSolReserves: r.curve.realSolReserves,
                    realTokenReserves: r.curve.realTokenReserves,
                  };
                  const price = q64ToFloatPump(spotPriceQ64(r0));
                  const progress = Number(
                    (r.curve.realSolReserves * 100n) / GRADUATION_THRESHOLD_SOL,
                  );
                  return (
                    <tr key={r.pubkey.toBase58()} className="border-t border-border/40">
                      <td className="py-2">
                        <button
                          type="button"
                          className="font-mono text-xs hover:underline"
                          onClick={() => onPick(r.curve.mint)}
                        >
                          {truncatePubkey(r.curve.mint.toBase58())}
                        </button>
                      </td>
                      <td className="py-2 font-mono text-xs">{price.toExponential(3)}</td>
                      <td className="py-2 text-right font-mono text-xs">
                        {(Number(r.curve.realSolReserves) / 1e9).toFixed(4)} SOL
                      </td>
                      <td className="py-2 text-right">
                        <div className="inline-flex w-32 items-center gap-2">
                          <div className="h-2 flex-1 rounded bg-secondary/40">
                            <div
                              className="h-2 rounded bg-primary"
                              style={{
                                width: `${Math.min(100, progress)}%`,
                              }}
                            />
                          </div>
                          <span className="font-mono text-xs">{progress}%</span>
                        </div>
                      </td>
                      <td className="py-2 text-right">
                        <Button size="sm" variant="outline" onClick={() => onPick(r.curve.mint)}>
                          Trade
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Trade: buy/sell against a single curve
// ---------------------------------------------------------------------------

function TradeTab({
  mint,
  setMint,
}: {
  mint: PublicKey | null;
  setMint: (m: PublicKey | null) => void;
}): JSX.Element {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const { toast } = useToast();

  const [mintInputStr, setMintInputStr] = useState(mint?.toBase58() ?? "");
  const [tokenAccountStr, setTokenAccountStr] = useState("");
  const [overrideAta, setOverrideAta] = useState(false);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amountStr, setAmountStr] = useState("");
  const [slipBps, setSlipBps] = useState(100); // 1% default
  const [curveState, setCurveState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; curve: BondingCurve }
    | { kind: "missing" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [submit, setSubmit] = useState<
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "success"; signature: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  // Sync the textbox with the parent-supplied mint when "Browse" pre-selected one.
  useEffect(() => {
    if (mint) setMintInputStr(mint.toBase58());
  }, [mint]);

  // Fetch the BondingCurve PDA whenever the mint changes.
  useEffect(() => {
    if (!mint) {
      setCurveState({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setCurveState({ kind: "loading" });
    const pda = bondingCurvePda(mint);
    connection
      .getAccountInfo(pda, "confirmed")
      .then((acct) => {
        if (cancelled) return;
        if (!acct) {
          setCurveState({ kind: "missing" });
          return;
        }
        try {
          const decoded = decodeBondingCurve(new Uint8Array(acct.data));
          setCurveState({ kind: "ready", curve: decoded });
        } catch (err) {
          setCurveState({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setCurveState({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mint, connection]);

  const onSetMint = useCallback(() => {
    try {
      const next = new PublicKey(mintInputStr.trim());
      setMint(next);
    } catch {
      toast({ variant: "destructive", title: "Invalid mint pubkey" });
    }
  }, [mintInputStr, setMint, toast]);

  const baseAmount = useMemo<bigint | null>(() => {
    const trimmed = amountStr.trim();
    if (!trimmed) return null;
    if (side === "buy") {
      // SOL in — 9 decimals.
      return parseDecimalToBigInt(trimmed, 9);
    }
    // Sell — token amount, also 9 decimals on this mint per `create.rs::initialize_mint2`.
    return parseDecimalToBigInt(trimmed, 9);
  }, [amountStr, side]);

  const quote = useMemo(() => {
    if (curveState.kind !== "ready" || !baseAmount || baseAmount <= 0n) return null;
    const reserves = {
      realSolReserves: curveState.curve.realSolReserves,
      realTokenReserves: curveState.curve.realTokenReserves,
    };
    if (side === "buy") {
      const r = quoteBuy(reserves, baseAmount, 0n, curveState.curve.graduated);
      if ("error" in r) return { error: r.error };
      // Apply slippage tolerance to derive min_tokens_out.
      const minOut = (r.tokensOut * (10_000n - BigInt(slipBps))) / 10_000n;
      return { ok: r, minOut };
    }
    const r = quoteSell(reserves, baseAmount, 0n, curveState.curve.graduated);
    if ("error" in r) return { error: r.error };
    const minOut = (r.solToSeller * (10_000n - BigInt(slipBps))) / 10_000n;
    return { ok: r, minOut };
  }, [curveState, baseAmount, side, slipBps]);

  const onSubmit = useCallback(async () => {
    setSubmit({ kind: "idle" });
    if (!publicKey || !connected) {
      setSubmit({ kind: "error", message: "Wallet not connected" });
      return;
    }
    if (!mint) {
      setSubmit({ kind: "error", message: "Pick a mint first" });
      return;
    }
    if (!quote || "error" in quote) {
      setSubmit({
        kind: "error",
        message: quote && "error" in quote ? `Quote error: ${quote.error}` : "Bad quote",
      });
      return;
    }
    // ATA resolution. Default: derive the wallet's Token-22 ATA for this mint
    // and prepend a `CreateIdempotent` ix on buys so first-time buyers don't
    // need a separate setup step. Power users can paste an explicit account
    // by toggling "use a different token account" and supplying a pubkey.
    let tokenAccount: PublicKey;
    if (overrideAta) {
      const trimmed = tokenAccountStr.trim();
      if (!trimmed) {
        setSubmit({
          kind: "error",
          message: "Enter a Token-22 account pubkey or untoggle the override",
        });
        return;
      }
      try {
        tokenAccount = new PublicKey(trimmed);
      } catch {
        setSubmit({ kind: "error", message: "Invalid token account pubkey" });
        return;
      }
    } else {
      tokenAccount = token22Ata(publicKey, mint);
    }

    try {
      const tx = new Transaction();
      // Lazily ensure the ATA exists on buy. No-op if already present (the
      // SPL ATA program's `CreateIdempotent` ix returns success without
      // mutating state). Skipped for sells since selling requires the ATA
      // already hold tokens.
      if (side === "buy" && !overrideAta) {
        tx.add(
          buildCreateAtaIdempotentInstruction({
            payer: publicKey,
            owner: publicKey,
            mint,
          }),
        );
      }
      if (side === "buy") {
        tx.add(
          buildBuyInstruction({
            mint,
            buyerTokenAccount: tokenAccount,
            buyer: publicKey,
            solIn: baseAmount!,
            minTokensOut: quote.minOut,
          }),
        );
      } else {
        tx.add(
          buildSellInstruction({
            mint,
            sellerTokenAccount: tokenAccount,
            seller: publicKey,
            tokensIn: baseAmount!,
            minSolOut: quote.minOut,
          }),
        );
      }
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

      setSubmit({ kind: "submitting" });
      const sig = await sendTransaction(tx, connection);
      setSubmit({ kind: "success", signature: sig });
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSubmit({ kind: "error", message });
      toast({ variant: "destructive", title: "Trade failed", description: message });
    }
  }, [
    publicKey,
    connected,
    mint,
    quote,
    tokenAccountStr,
    overrideAta,
    side,
    baseAmount,
    connection,
    sendTransaction,
    toast,
  ]);

  // Auto-derived ATA preview, surfaced read-only when the override is off.
  const derivedAta = useMemo(() => {
    if (!publicKey || !mint) return null;
    return token22Ata(publicKey, mint);
  }, [publicKey, mint]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trade against a curve</CardTitle>
        <CardDescription>
          Quotes are computed via the same constant-product math as on-chain. Slippage
          tolerance is applied to derive `min_out` for the ix; the program reverts if the
          curve would deliver less.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1">
            <Field
              label="Mint"
              value={mintInputStr}
              onChange={setMintInputStr}
              placeholder="paste a Token-22 mint pubkey"
              mono
            />
          </div>
          <Button onClick={onSetMint} variant="outline">
            Load curve
          </Button>
        </div>

        {curveState.kind === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading bonding curve…</p>
        ) : null}
        {curveState.kind === "missing" ? (
          <p className="text-sm text-amber-400">
            No bonding curve PDA found for this mint. Check that the mint exists on this
            cluster and that `create` has been called against it.
          </p>
        ) : null}
        {curveState.kind === "error" ? (
          <p className="text-sm text-destructive">{curveState.message}</p>
        ) : null}
        {curveState.kind === "ready" ? (
          <CurveStateReadout curve={curveState.curve} />
        ) : null}

        <div className="flex gap-2">
          <TabButton selected={side === "buy"} onClick={() => setSide("buy")}>
            Buy
          </TabButton>
          <TabButton selected={side === "sell"} onClick={() => setSide("sell")}>
            Sell
          </TabButton>
        </div>

        <Field
          label={side === "buy" ? "SOL in" : "Tokens in"}
          value={amountStr}
          onChange={setAmountStr}
          placeholder={side === "buy" ? "1.5" : "1000000"}
        />
        <div className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">
            Token-22 account for this mint
          </span>
          {overrideAta ? (
            <input
              type="text"
              value={tokenAccountStr}
              onChange={(e) => setTokenAccountStr(e.target.value)}
              placeholder="paste an explicit Token-22 account pubkey"
              className="block w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          ) : (
            <p className="break-all rounded-md border border-input bg-secondary/30 px-3 py-2 font-mono text-xs text-muted-foreground">
              {derivedAta ? derivedAta.toBase58() : "connect a wallet to derive your ATA"}
            </p>
          )}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={overrideAta}
              onChange={(e) => setOverrideAta(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            <span>
              Use a different token account
              {side === "buy" ? null : (
                <> (sells require an account that already holds tokens)</>
              )}
            </span>
          </label>
          {side === "buy" && !overrideAta ? (
            <p className="text-xs text-muted-foreground">
              First-time buy includes a `CreateIdempotent` ix to open this ATA if it
              doesn’t exist yet — no separate setup needed.
            </p>
          ) : null}
        </div>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">
            Slippage tolerance (bps)
          </span>
          <input
            type="number"
            value={slipBps}
            min={0}
            max={5000}
            onChange={(e) => setSlipBps(Number(e.target.value))}
            className="block w-32 rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </label>

        <QuoteReadout quote={quote} side={side} />

        <Button
          onClick={onSubmit}
          disabled={
            submit.kind === "submitting" ||
            !quote ||
            (quote && "error" in quote) ||
            curveState.kind !== "ready"
          }
          className="w-full sm:w-auto"
        >
          {submit.kind === "submitting" ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Submitting
            </>
          ) : side === "buy" ? (
            "Submit buy"
          ) : (
            "Submit sell"
          )}
        </Button>
        {submit.kind === "success" ? (
          <p className="text-sm text-emerald-400">
            Submitted.{" "}
            <a
              className="underline underline-offset-2"
              href={explorerTxUrl(submit.signature)}
              target="_blank"
              rel="noreferrer"
            >
              View on explorer
            </a>
          </p>
        ) : null}
        {submit.kind === "error" ? (
          <p className="text-sm text-destructive">{submit.message}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CurveStateReadout({ curve }: { curve: BondingCurve }): JSX.Element {
  const reserves = {
    realSolReserves: curve.realSolReserves,
    realTokenReserves: curve.realTokenReserves,
  };
  const price = q64ToFloatPump(spotPriceQ64(reserves));
  const progress = Number(
    (curve.realSolReserves * 10_000n) / GRADUATION_THRESHOLD_SOL,
  ) / 100;
  return (
    <dl className="grid grid-cols-2 gap-2 rounded-md border bg-secondary/20 p-3 text-xs">
      <dt className="text-muted-foreground">Real SOL</dt>
      <dd className="font-mono">{(Number(curve.realSolReserves) / 1e9).toFixed(6)} SOL</dd>
      <dt className="text-muted-foreground">Real tokens</dt>
      <dd className="font-mono">{curve.realTokenReserves.toString()}</dd>
      <dt className="text-muted-foreground">Spot price (lamports/token, Q64.64 ÷ 2⁶⁴)</dt>
      <dd className="font-mono">{price.toExponential(4)}</dd>
      <dt className="text-muted-foreground">Graduation progress</dt>
      <dd className="font-mono">
        {progress.toFixed(2)}% of 85 SOL{curve.graduated ? " (graduated)" : ""}
      </dd>
      <dt className="text-muted-foreground">Total fees collected</dt>
      <dd className="font-mono">{(Number(curve.totalFeesCollected) / 1e9).toFixed(6)} SOL</dd>
    </dl>
  );
}

function QuoteReadout({
  quote,
  side,
}: {
  quote:
    | null
    | { ok: { tokensOut: bigint; solFee: bigint; solIntoCurve: bigint; graduates: boolean }; minOut: bigint }
    | { ok: { solOutGross: bigint; solFee: bigint; solToSeller: bigint }; minOut: bigint }
    | { error: string };
  side: "buy" | "sell";
}): JSX.Element {
  if (!quote) return <p className="text-xs text-muted-foreground">Enter an amount to quote.</p>;
  if ("error" in quote) {
    return <p className="text-xs text-destructive">Quote error: {quote.error}</p>;
  }
  if (side === "buy") {
    const ok = quote.ok as { tokensOut: bigint; solFee: bigint; solIntoCurve: bigint; graduates: boolean };
    return (
      <dl className="grid grid-cols-2 gap-2 rounded-md border bg-secondary/20 p-3 text-xs">
        <dt className="text-muted-foreground">Tokens out (estimated)</dt>
        <dd className="font-mono">{ok.tokensOut.toString()}</dd>
        <dt className="text-muted-foreground">SOL fee (1%)</dt>
        <dd className="font-mono">{(Number(ok.solFee) / 1e9).toFixed(6)} SOL</dd>
        <dt className="text-muted-foreground">SOL into curve</dt>
        <dd className="font-mono">{(Number(ok.solIntoCurve) / 1e9).toFixed(6)} SOL</dd>
        <dt className="text-muted-foreground">min_tokens_out (with slippage)</dt>
        <dd className="font-mono">{quote.minOut.toString()}</dd>
        {ok.graduates ? (
          <>
            <dt className="text-amber-400">Graduates curve</dt>
            <dd className="text-amber-400">yes — last trade before Raydium pool migration</dd>
          </>
        ) : null}
      </dl>
    );
  }
  const ok = quote.ok as { solOutGross: bigint; solFee: bigint; solToSeller: bigint };
  return (
    <dl className="grid grid-cols-2 gap-2 rounded-md border bg-secondary/20 p-3 text-xs">
      <dt className="text-muted-foreground">SOL out gross</dt>
      <dd className="font-mono">{(Number(ok.solOutGross) / 1e9).toFixed(6)} SOL</dd>
      <dt className="text-muted-foreground">SOL fee (1%)</dt>
      <dd className="font-mono">{(Number(ok.solFee) / 1e9).toFixed(6)} SOL</dd>
      <dt className="text-muted-foreground">SOL to seller</dt>
      <dd className="font-mono">{(Number(ok.solToSeller) / 1e9).toFixed(6)} SOL</dd>
      <dt className="text-muted-foreground">min_sol_out (with slippage)</dt>
      <dd className="font-mono">{(Number(quote.minOut) / 1e9).toFixed(6)} SOL</dd>
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Create: spin up a new curve
// ---------------------------------------------------------------------------

function CreateTab(): JSX.Element {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [uri, setUri] = useState("");
  const [submit, setSubmit] = useState<
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "success"; signature: string; mint: PublicKey }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const onCreate = useCallback(async () => {
    setSubmit({ kind: "idle" });
    if (!publicKey || !connected) {
      setSubmit({ kind: "error", message: "Wallet not connected" });
      return;
    }
    if (!name.trim() || !symbol.trim()) {
      setSubmit({ kind: "error", message: "Name and symbol are required" });
      return;
    }
    try {
      // Generate a fresh keypair for the mint. The `create` ix initializes the
      // Token-22 mint at this pubkey and the keypair must sign the tx.
      const mintKp = Keypair.generate();
      const ix = buildCreateInstruction({
        name: name.trim(),
        symbol: symbol.trim(),
        uri: uri.trim(),
        mint: mintKp.publicKey,
        creator: publicKey,
      });
      const tx = new Transaction();
      tx.add(ix);
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      tx.partialSign(mintKp);

      setSubmit({ kind: "submitting" });
      const sig = await sendTransaction(tx, connection, {
        signers: [mintKp],
      });
      setSubmit({ kind: "success", signature: sig, mint: mintKp.publicKey });
      toast({
        variant: "success",
        title: `Curve created: ${symbol}`,
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSubmit({ kind: "error", message });
      toast({ variant: "destructive", title: "Create failed", description: message });
    }
  }, [publicKey, connected, name, symbol, uri, connection, sendTransaction, toast]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create a bonding curve</CardTitle>
        <CardDescription>
          Spins up a fresh Token-22 mint with the Confidential Transfer extension active by
          default. Mint authority is the curve PDA — no rug authority. Initial reserves are{" "}
          {(Number(initialReserves().realTokenReserves) / 1e18).toFixed(2)}B virtual tokens
          and 30 SOL of virtual liquidity.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Field label="Token name (≤32 bytes)" value={name} onChange={setName} placeholder="My Token" />
        <Field
          label="Symbol (≤10 bytes)"
          value={symbol}
          onChange={setSymbol}
          placeholder="MYT"
        />
        <Field
          label="Off-chain metadata URI (optional, ≤200 bytes)"
          value={uri}
          onChange={setUri}
          placeholder="https://..."
        />
        <Button onClick={onCreate} disabled={submit.kind === "submitting"}>
          {submit.kind === "submitting" ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Submitting
            </>
          ) : (
            "Create curve"
          )}
        </Button>
        {submit.kind === "success" ? (
          <div className="space-y-1 text-sm">
            <p className="text-emerald-400">Created.</p>
            <p className="text-muted-foreground">
              Mint:{" "}
              <span className="font-mono text-foreground" title={submit.mint.toBase58()}>
                {submit.mint.toBase58()}
              </span>
            </p>
            <p className="text-muted-foreground">
              Tx:{" "}
              <a
                className="underline underline-offset-2 font-mono"
                href={explorerTxUrl(submit.signature)}
                target="_blank"
                rel="noreferrer"
              >
                {truncatePubkey(submit.signature, 8, 8)}
              </a>
            </p>
          </div>
        ) : null}
        {submit.kind === "error" ? (
          <p className="text-sm text-destructive">{submit.message}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Local primitives
// ---------------------------------------------------------------------------

function TabButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
        selected
          ? "border-primary bg-primary/20 text-foreground"
          : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary/70"
      }`}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
  help,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  help?: React.ReactNode;
}): JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring ${
          mono ? "font-mono" : ""
        }`}
      />
      {help ? <span className="block text-xs text-muted-foreground">{help}</span> : null}
    </label>
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
