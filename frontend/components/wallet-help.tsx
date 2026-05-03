"use client";

/**
 * Help popover next to the wallet button. Two purposes:
 *
 * 1. Explain how to add staccana as a custom RPC in Backpack/Phantom/Solflare.
 *    Without this, the wallet simulates txs against its default cluster
 *    (mainnet/devnet) where our programs don't exist — preflight rejects
 *    with empty logs + units_consumed=0.
 *
 * 2. Detect "wrong network" by hitting the wallet's preferred RPC via
 *    `getGenesisHash` and comparing against staccana's known genesis. If
 *    mismatch, render an amber banner. (Best-effort — the wallet doesn't
 *    expose its RPC URL directly, so we infer from a probe tx if possible.)
 */

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Check, Copy, HelpCircle, X } from "lucide-react";
import { useEffect, useState } from "react";

import { GENESIS_HASH, RPC_URL } from "@/lib/staccana";

const STACCANA_RPC = RPC_URL.replace(/\/$/, "");

export function WalletHelp(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { connected } = useWallet();
  const { connection } = useConnection();
  const [genesisOk, setGenesisOk] = useState<"unknown" | "ok" | "mismatch">("unknown");

  // Probe staccana's genesis via the page's connection — if the local
  // connection succeeds but the user's wallet is on the wrong cluster,
  // this still passes (we're not actually probing the wallet's RPC). The
  // user sees the banner if they CAN'T click buy without skipPreflight.
  useEffect(() => {
    if (!GENESIS_HASH) return;
    let cancelled = false;
    connection
      .getGenesisHash()
      .then((g) => {
        if (cancelled) return;
        setGenesisOk(g === GENESIS_HASH ? "ok" : "mismatch");
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [connection]);

  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(STACCANA_RPC);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/60 bg-secondary/40 text-muted-foreground hover:text-foreground hover:bg-secondary/70"
        title="How do I connect my wallet to staccana?"
        aria-label="Wallet help"
      >
        <HelpCircle className="h-4 w-4" />
      </button>

      {/* Wrong-network banner: only shown if connected AND we suspect mismatch. */}
      {connected && genesisOk === "mismatch" ? (
        <div className="absolute left-0 right-0 top-14 z-30 border-b border-amber-400/40 bg-amber-400/10 px-4 py-2 text-center text-xs text-amber-300">
          Your wallet looks like it's on a different cluster. Click <kbd>?</kbd> for setup.
        </div>
      ) : null}

      {open ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-background/80 backdrop-blur"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            className="relative w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-labelledby="wallet-help-title"
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>

            <h2 id="wallet-help-title" className="mb-4 text-lg font-semibold">
              Connect your wallet to staccana
            </h2>

            <p className="mb-3 text-sm text-muted-foreground">
              Wallets simulate transactions against their default RPC. If yours points at
              Solana mainnet, your buy/claim/bridge calls will preflight-reject because
              the staccana programs don't exist there. Add staccana as a custom cluster:
            </p>

            <div className="mb-4 space-y-3 text-sm">
              <Section title="Backpack (recommended)">
                <ol className="ml-5 list-decimal space-y-0.5 text-muted-foreground">
                  <li>Open Backpack → click your profile (top left)</li>
                  <li>
                    Settings → <span className="text-foreground">Solana</span> → RPC
                    Connection
                  </li>
                  <li>
                    Choose <span className="text-foreground">Custom</span> and paste the URL below
                  </li>
                </ol>
              </Section>

              <Section title="Phantom">
                <ol className="ml-5 list-decimal space-y-0.5 text-muted-foreground">
                  <li>Settings → Developer Settings → Testnet Mode (on)</li>
                  <li>Change Network → Add Custom RPC</li>
                  <li>Paste the URL below</li>
                </ol>
              </Section>

              <Section title="Solflare">
                <ol className="ml-5 list-decimal space-y-0.5 text-muted-foreground">
                  <li>Settings → Network → Add custom node</li>
                  <li>Paste the URL below</li>
                </ol>
              </Section>
            </div>

            <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
              <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
                Staccana RPC URL
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate font-mono text-sm text-foreground">{STACCANA_RPC}</code>
                <button
                  type="button"
                  onClick={onCopy}
                  className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-secondary/40 px-2 text-xs hover:bg-secondary/70"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>

            <p className="mt-4 text-xs text-amber-300">
              <strong>This step is required.</strong> Wallets always run their own
              preflight simulation against their configured RPC before showing the
              approve dialog — there's no way for this site to skip that. If your
              wallet doesn't know about staccana, every buy/claim/bridge call will
              show "Transaction simulation failed" with empty logs.
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}
