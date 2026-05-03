"use client";

/**
 * Reusable "secret balance + secret transfer" widget. Extracted from
 * `app/launch/[mint]/page.tsx` so it can mount on every page via the root
 * layout. Behaviour:
 *
 *  - With a `mint` prop: token-specific send panel (Token-22 confidential
 *    transfer attempted first, falls back to public TransferChecked).
 *  - Without a `mint` prop: aggregate view — picks up the mint from the URL
 *    if we're on /launch/[mint], otherwise prompts the user to pick a token.
 *
 * Designed to be SSR-safe: gates everything behind `useWallet().connected`
 * and a path-based hydration check, so server output is just an empty
 * placeholder div.
 */

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useToast } from "@/components/ui/use-toast";
import {
  ProofUnavailableError,
  buildTransferInstruction,
  deriveElGamalKeypair,
} from "@/lib/confidential";
import {
  buildCreateAtaIdempotentInstruction,
  token22Ata,
} from "@/lib/pump";
import { TOKEN_2022_PROGRAM_ID, explorerTxUrl } from "@/lib/staccana";
import { truncatePubkey } from "@/lib/utils";

interface SecretBalancePanelProps {
  /** When omitted, the panel will try to infer a mint from the URL. */
  mint?: PublicKey;
  /** Optional className passthrough — handy for sidebar mounting. */
  className?: string;
}

// Try to parse `/launch/<base58>` out of the current pathname so the sidebar
// version of the panel "follows" the user when they're on a token detail
// page without us having to thread a prop through every layout.
function useMintFromPathname(): PublicKey | null {
  const pathname = usePathname();
  return useMemo(() => {
    if (!pathname) return null;
    const m = /^\/launch\/([1-9A-HJ-NP-Za-km-z]{32,44})\/?$/.exec(pathname);
    if (!m) return null;
    try {
      return new PublicKey(m[1]);
    } catch {
      return null;
    }
  }, [pathname]);
}

export function SecretBalancePanel({
  mint: explicitMint,
  className,
}: SecretBalancePanelProps): JSX.Element | null {
  const inferredMint = useMintFromPathname();
  const mint = explicitMint ?? inferredMint;

  // Hydration guard — wallet adapter context is only meaningful on the
  // client. Returning `null` during SSR avoids a flash of "Connect a wallet".
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const { connected } = useWallet();

  if (!mounted) return null;

  if (!connected) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <span aria-hidden>🔒</span> Secret balance
          </CardTitle>
          <CardDescription>
            Connect a wallet to view and transfer your confidential token
            balances.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!mint) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <span aria-hidden>🔒</span> Secret balance
          </CardTitle>
          <CardDescription>
            Pick a token from the launchpad to send a confidential transfer.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/launch">
            <Button variant="secondary" className="w-full">
              Browse tokens
            </Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  return <SendPanelInner mint={mint} className={className} />;
}

function SendPanelInner({
  mint,
  className,
}: {
  mint: PublicKey;
  className?: string;
}): JSX.Element {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { publicKey, sendTransaction, connected } = wallet;
  const { toast } = useToast();

  const [recipientStr, setRecipientStr] = useState("");
  const [amountStr, setAmountStr] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confidential, setConfidential] = useState(true);
  const [usedFallback, setUsedFallback] = useState(false);

  const recipient = useMemo(() => {
    try {
      return new PublicKey(recipientStr.trim());
    } catch {
      return null;
    }
  }, [recipientStr]);

  const amount = useMemo(() => parseDecimalToBigInt(amountStr, 9), [amountStr]);

  const onSend = useCallback(async () => {
    setError(null);
    setUsedFallback(false);
    if (!publicKey || !connected) {
      setError("Connect a wallet first");
      return;
    }
    if (!recipient) {
      setError("Recipient address is invalid");
      return;
    }
    if (!amount || amount <= 0n) {
      setError("Enter an amount > 0");
      return;
    }
    if (recipient.equals(publicKey)) {
      setError("Recipient is your own wallet");
      return;
    }

    try {
      setSubmitting(true);
      const senderAta = token22Ata(publicKey, mint);
      const recipientAta = token22Ata(recipient, mint);

      const tx = new Transaction();

      tx.add(
        buildCreateAtaIdempotentInstruction({
          payer: publicKey,
          owner: recipient,
          mint,
        }),
      );

      let usedConfidential = false;
      if (confidential) {
        try {
          const senderKeys = await deriveElGamalKeypair(
            { publicKey, signMessage: wallet.signMessage },
            mint,
          );
          const ixs = await buildTransferInstruction({
            ata: senderAta,
            destinationAta: recipientAta,
            mint,
            owner: publicKey,
            amount,
            senderElgamalPubkey: senderKeys.secretSeed.slice(0, 32),
            recipientElgamalPubkey: new Uint8Array(32),
            auditorElgamalPubkey: new Uint8Array(32),
            newSourceDecryptableAvailableBalance: new Uint8Array(36),
            elgamalSeed: senderKeys.secretSeed,
          });
          for (const ix of ixs) tx.add(ix);
          usedConfidential = true;
        } catch (err) {
          if (!(err instanceof ProofUnavailableError)) {
            throw err;
          }
          // eslint-disable-next-line no-console
          console.warn(
            "[send] confidential path unavailable, falling back to public TransferChecked",
            err.code,
          );
        }
      }

      if (!usedConfidential) {
        const { createTransferCheckedInstruction } = await import(
          "@solana/spl-token"
        );
        tx.add(
          createTransferCheckedInstruction(
            senderAta,
            mint,
            recipientAta,
            publicKey,
            amount,
            9,
            [],
            TOKEN_2022_PROGRAM_ID,
          ),
        );
        setUsedFallback(true);
      }

      tx.feePayer = publicKey;
      tx.recentBlockhash = (
        await connection.getLatestBlockhash("confirmed")
      ).blockhash;
      const sig = await sendTransaction(tx, connection, {
        skipPreflight: true,
      });
      toast({
        variant: "success",
        title: usedConfidential
          ? "Encrypted transfer submitted"
          : "Transfer submitted (public)",
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
      setAmountStr("");
      setRecipientStr("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast({
        variant: "destructive",
        title: "Send failed",
        description: msg,
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    publicKey,
    connected,
    recipient,
    amount,
    mint,
    connection,
    sendTransaction,
    confidential,
    wallet.signMessage,
    toast,
  ]);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <span aria-hidden>🔒</span> Send
        </CardTitle>
        <CardDescription className="break-all font-mono text-[10px]">
          {truncatePubkey(mint.toBase58(), 6, 6)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">
            Recipient (pubkey)
          </span>
          <input
            type="text"
            value={recipientStr}
            onChange={(e) => setRecipientStr(e.target.value)}
            placeholder="Recipient address…"
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
            spellCheck={false}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">
            Amount (tokens)
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value)}
            placeholder="0.0"
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        <label className="flex items-center justify-between rounded-md border border-border/40 bg-secondary/20 px-3 py-2 text-xs">
          <span>Try encrypted transfer first</span>
          <input
            type="checkbox"
            checked={confidential}
            onChange={(e) => setConfidential(e.target.checked)}
            className="h-3.5 w-3.5 accent-emerald-500"
          />
        </label>
        <Button onClick={onSend} disabled={submitting} className="w-full">
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Sending…
            </>
          ) : (
            "Send"
          )}
        </Button>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {usedFallback ? (
          <p className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-200">
            Encrypted transfer rejected by chain — sent as public
            TransferChecked instead. The amount is visible on chain.
          </p>
        ) : null}
      </CardContent>
    </Card>
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
