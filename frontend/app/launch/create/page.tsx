"use client";

/**
 * Polished create flow.
 *
 * One transaction can `create_curve` then optionally `buy` to seed the
 * curve with the creator's own initial position — pump.fun's "first-buy"
 * pattern. The data: URI carrying name/symbol/image/socials is passed as the
 * `uri` argument to `create_curve` (capped at 200 bytes by the on-chain
 * struct), so the create page MUST keep the JSON blob small or fall back to
 * a shorter URL the user supplies.
 */

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { ArrowLeft, Loader2, Rocket } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { ImageDropzone } from "@/components/pump/image-dropzone";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/use-toast";
import {
  buildBuyInstruction,
  buildCreateAtaIdempotentInstruction,
  buildCreateInstruction,
  initialReserves,
  quoteBuy,
  token22Ata,
} from "@/lib/pump";
import { buildDataUri, fmtSol, type PumpTokenMetadata } from "@/lib/pump-extra";
import { explorerTxUrl } from "@/lib/staccana";
import { truncatePubkey } from "@/lib/utils";

const RENT_ESTIMATE_SOL = 0.025; // empirical: mint + curve PDA + vault PDA rent on Solana ≈ 0.02–0.03

export default function CreatePage(): JSX.Element {
  const router = useRouter();
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [website, setWebsite] = useState("");
  const [externalUri, setExternalUri] = useState(""); // optional override (for hosted JSON)
  const [imageDataUri, setImageDataUri] = useState<string | null>(null);
  const [seedBuyEnabled, setSeedBuyEnabled] = useState(false);
  const [seedBuySol, setSeedBuySol] = useState("0.1");

  const [submit, setSubmit] = useState<
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "success"; signature: string; mint: PublicKey }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  // The data URI we'd encode on-chain. If `externalUri` is supplied we use
  // that verbatim (it had better resolve to a JSON document with these
  // fields). Otherwise we build a `data:application/json,...` blob inline.
  const computedUri = useMemo(() => {
    const meta: PumpTokenMetadata = {};
    if (name.trim()) meta.name = name.trim();
    if (symbol.trim()) meta.symbol = symbol.trim();
    if (description.trim()) meta.description = description.trim();
    if (twitter.trim()) meta.twitter = twitter.trim();
    if (telegram.trim()) meta.telegram = telegram.trim();
    if (website.trim()) meta.website = website.trim();
    // Skip image inline if the caller pasted an external URI, since we'll
    // be sending external_uri in `uri` and the off-chain blob is the source
    // of truth in that case.
    if (imageDataUri && !externalUri.trim()) meta.image = imageDataUri;

    if (externalUri.trim()) return externalUri.trim();
    const dataUri = buildDataUri(meta);
    return dataUri;
  }, [name, symbol, description, twitter, telegram, website, imageDataUri, externalUri]);

  const uriBytes = useMemo(
    () => new TextEncoder().encode(computedUri).length,
    [computedUri],
  );
  const uriOverflow = uriBytes > 200;

  const seedBuyLamports = useMemo<bigint | null>(() => {
    if (!seedBuyEnabled) return null;
    const parsed = parseDecimalToBigInt(seedBuySol, 9);
    if (!parsed || parsed === 0n) return null;
    return parsed;
  }, [seedBuyEnabled, seedBuySol]);

  // Quote the seed buy against an empty curve so we can show the user how
  // many tokens they'd net.
  const seedQuote = useMemo(() => {
    if (!seedBuyLamports) return null;
    const r = quoteBuy(initialReserves(), seedBuyLamports, 0n, false);
    return r;
  }, [seedBuyLamports]);

  const totalCostSol = useMemo(() => {
    const seed = seedBuyLamports ? Number(seedBuyLamports) / 1e9 : 0;
    return RENT_ESTIMATE_SOL + seed;
  }, [seedBuyLamports]);

  const onLaunch = useCallback(async () => {
    setSubmit({ kind: "idle" });
    if (!publicKey || !connected) {
      setSubmit({ kind: "error", message: "Connect a wallet to launch" });
      return;
    }
    if (!name.trim() || !symbol.trim()) {
      setSubmit({ kind: "error", message: "Name and symbol are required" });
      return;
    }
    if (uriOverflow) {
      setSubmit({
        kind: "error",
        message: `Metadata URI is ${uriBytes} bytes — exceeds the on-chain 200-byte limit. Drop the image, shorten the description, or paste a hosted JSON URL.`,
      });
      return;
    }

    try {
      const mintKp = Keypair.generate();
      const tx = new Transaction();

      tx.add(
        buildCreateInstruction({
          name: name.trim(),
          symbol: symbol.trim(),
          uri: computedUri,
          mint: mintKp.publicKey,
          creator: publicKey,
        }),
      );

      // Optional initial buy from the creator. We use minTokensOut=0 to
      // tolerate any quote drift between local quote and on-chain math (the
      // curve is empty at create time so they should match exactly; the
      // safety floor is overkill but harmless).
      if (seedBuyLamports && seedBuyLamports > 0n) {
        tx.add(
          buildCreateAtaIdempotentInstruction({
            payer: publicKey,
            owner: publicKey,
            mint: mintKp.publicKey,
          }),
        );
        tx.add(
          buildBuyInstruction({
            mint: mintKp.publicKey,
            buyerTokenAccount: token22Ata(publicKey, mintKp.publicKey),
            buyer: publicKey,
            solIn: seedBuyLamports,
            minTokensOut: 0n,
          }),
        );
      }

      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      tx.partialSign(mintKp);

      setSubmit({ kind: "submitting" });
      const sig = await sendTransaction(tx, connection, { signers: [mintKp] });
      setSubmit({ kind: "success", signature: sig, mint: mintKp.publicKey });
      toast({
        variant: "success",
        title: `Launched $${symbol.trim()}`,
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

      // Whisk the user to the token detail page so they can see their fresh launch.
      setTimeout(() => router.push(`/pump/${mintKp.publicKey.toBase58()}`), 1200);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSubmit({ kind: "error", message });
      toast({ variant: "destructive", title: "Launch failed", description: message });
    }
  }, [
    publicKey,
    connected,
    name,
    symbol,
    computedUri,
    uriOverflow,
    uriBytes,
    seedBuyLamports,
    connection,
    sendTransaction,
    toast,
    router,
  ]);

  return (
    <div className="space-y-6">
      <Link
        href="/launch"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to launchpad
      </Link>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Token identity</CardTitle>
              <CardDescription>
                Name and symbol are passed to the on-chain `create` ix as fixed-byte fields
                (32 / 10 bytes). Image and socials live in a JSON blob the launchpad packs
                into the metadata URI.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                <ImageDropzone onChange={setImageDataUri} />
                <div className="space-y-3">
                  <Field label="Name (≤ 32 bytes)" value={name} onChange={setName} placeholder="Pixel Pup" />
                  <Field
                    label="Symbol (≤ 10 bytes)"
                    value={symbol}
                    onChange={(s) => setSymbol(s.toUpperCase())}
                    placeholder="PUP"
                  />
                </div>
              </div>
              <Field
                label="Description"
                value={description}
                onChange={setDescription}
                placeholder="What's the story?"
                textarea
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Socials (optional)</CardTitle>
              <CardDescription>
                Stored alongside name/symbol/image in the metadata URI. Linked from the
                token detail page.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Field label="Twitter" value={twitter} onChange={setTwitter} placeholder="https://twitter.com/…" />
              <Field label="Telegram" value={telegram} onChange={setTelegram} placeholder="https://t.me/…" />
              <Field label="Website" value={website} onChange={setWebsite} placeholder="https://…" />
              <Field
                label="Or hosted metadata URI"
                value={externalUri}
                onChange={setExternalUri}
                placeholder="https://example.com/meta.json"
                help="If supplied, this URL is written to the on-chain `uri` field instead of the inline data: blob."
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Open with a buy?</CardTitle>
              <CardDescription>
                Atomically combine `create_curve` with a `buy` so you mint the curve and
                snipe the first lot in the same tx. Defends against drive-by snipers parking
                a buy on your fresh PDA.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={seedBuyEnabled}
                  onChange={(e) => setSeedBuyEnabled(e.target.checked)}
                  className="h-4 w-4"
                />
                <span>Seed the curve with my own buy</span>
              </label>
              {seedBuyEnabled ? (
                <>
                  <Field
                    label="SOL to spend"
                    value={seedBuySol}
                    onChange={setSeedBuySol}
                    placeholder="0.1"
                  />
                  <SeedQuoteReadout quote={seedQuote} />
                </>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-4">
          <Card className="sticky top-24">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Rocket className="h-5 w-5 text-primary" /> Launch summary
              </CardTitle>
              <CardDescription>
                Curve fees: 1% in/out. Initial reserves: 30 SOL virtual + 1.073B virtual
                tokens. Graduation at 85 real SOL.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <SummaryRow label="Mint authority" value="Curve PDA (no rug)" />
              <SummaryRow label="Confidential transfers" value="Active by default" />
              <SummaryRow label="Estimated rent" value={`~${RENT_ESTIMATE_SOL.toFixed(3)} SOL`} />
              {seedBuyLamports ? (
                <SummaryRow
                  label="Seed buy"
                  value={`${(Number(seedBuyLamports) / 1e9).toFixed(4)} SOL`}
                />
              ) : null}
              <div className="flex items-center justify-between rounded-md border border-border/60 bg-secondary/20 p-3">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">
                  Total estimate
                </span>
                <span className="font-mono text-sm font-semibold text-foreground">
                  ~{fmtSol(totalCostSol, 4)} SOL
                </span>
              </div>

              <div className="rounded-md border border-border/40 bg-secondary/10 p-3 text-xs">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-muted-foreground">Metadata URI bytes</span>
                  <span
                    className={uriOverflow ? "font-mono text-destructive" : "font-mono text-foreground"}
                  >
                    {uriBytes} / 200
                  </span>
                </div>
                {uriOverflow ? (
                  <p className="text-destructive">
                    Exceeds 200-byte limit. Remove the image or paste a hosted JSON URL.
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    Inline data: blob fits on-chain.
                  </p>
                )}
              </div>

              <Button
                onClick={onLaunch}
                disabled={submit.kind === "submitting" || !connected || uriOverflow}
                className="w-full gap-2"
                size="lg"
              >
                {submit.kind === "submitting" ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Submitting…
                  </>
                ) : (
                  <>
                    <Rocket className="h-4 w-4" />
                    Launch{seedBuyLamports ? " + Buy" : ""}
                  </>
                )}
              </Button>

              {submit.kind === "success" ? (
                <div className="space-y-1 text-xs">
                  <p className="text-emerald-400">Launched.</p>
                  <p className="text-muted-foreground">
                    Mint:{" "}
                    <span className="font-mono text-foreground">
                      {truncatePubkey(submit.mint.toBase58(), 6, 6)}
                    </span>
                  </p>
                  <a
                    href={explorerTxUrl(submit.signature)}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono underline underline-offset-2"
                  >
                    View tx
                  </a>
                </div>
              ) : null}
              {submit.kind === "error" ? (
                <p className="text-xs text-destructive">{submit.message}</p>
              ) : null}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  );
}

function SeedQuoteReadout({
  quote,
}: {
  quote: ReturnType<typeof quoteBuy> | null;
}): JSX.Element | null {
  if (!quote) return null;
  if ("error" in quote) {
    return <p className="text-xs text-destructive">Quote error: {quote.error}</p>;
  }
  return (
    <dl className="grid grid-cols-2 gap-2 rounded-md border border-border/40 bg-secondary/20 p-3 text-xs">
      <dt className="text-muted-foreground">Tokens you receive</dt>
      <dd className="font-mono">{(Number(quote.tokensOut) / 1e9).toFixed(4)} tokens</dd>
      <dt className="text-muted-foreground">SOL fee (1%)</dt>
      <dd className="font-mono">{(Number(quote.solFee) / 1e9).toFixed(6)} SOL</dd>
      <dt className="text-muted-foreground">Net into curve</dt>
      <dd className="font-mono">{(Number(quote.solIntoCurve) / 1e9).toFixed(6)} SOL</dd>
    </dl>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  help,
  textarea,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  help?: React.ReactNode;
  textarea?: boolean;
}): JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {textarea ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      )}
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
