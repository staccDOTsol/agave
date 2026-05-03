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
import {
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
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
  deriveElGamalPubkeyFromSeed,
} from "@/lib/confidential";
import {
  PendingTransitAccount,
  fetchConfidentialAccountState,
  findTransitMemoForAccountV2,
  prepareTransitClaimApplyPendingTx,
  prepareTransitClaimMigrationTx,
  prepareTransitSendIxs,
  scanPendingTransitAccounts,
} from "@/lib/confidential-transit";
import {
  buildCreateAtaIdempotentInstruction,
  token22Ata,
} from "@/lib/pump";
import {
  STACCANA_MASTER_LUT,
  TOKEN_2022_PROGRAM_ID,
  explorerTxUrl,
} from "@/lib/staccana";
import { truncatePubkey } from "@/lib/utils";

interface SecretBalancePanelProps {
  /** When omitted, the panel will try to infer a mint from the URL. */
  mint?: PublicKey;
  /** Optional className passthrough — handy for sidebar mounting. */
  className?: string;
}

/** A single Token-22 account belonging to the connected wallet. */
interface OwnedToken {
  mint: PublicKey;
  balance: bigint;
  decimals: number;
  /** `null` if no on-chain TokenMetadata extension is set. */
  symbol: string | null;
  /** Address of the user's ATA that holds the token (used for refresh). */
  ata: PublicKey;
}

/**
 * Fetch every Token-22 token account the connected wallet owns, with each
 * one's mint, balance, decimals, and (best-effort) symbol from the on-chain
 * TokenMetadata extension. Used to drive the multitoken picker — without
 * this the panel could only ever show whatever mint was passed via prop
 * or inferred from the URL, which on pages like `/`, `/claim`, `/megadrop`
 * etc. (no mint in path) left it as a useless empty stub.
 *
 * Returns `null` until the first fetch resolves so callers can show a
 * loading state distinct from the "you own nothing" empty state.
 */
function useOwnedToken22(): {
  tokens: OwnedToken[] | null;
  refresh: () => void;
} {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const [tokens, setTokens] = useState<OwnedToken[] | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    if (!publicKey || !connected) {
      setTokens(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // `parsed` lets us avoid a manual SPL state decoder — the runtime
        // hands back `mint`, `tokenAmount.amount`, and decimals already.
        const resp = await connection.getParsedTokenAccountsByOwner(publicKey, {
          programId: TOKEN_2022_PROGRAM_ID,
        });
        const out: OwnedToken[] = [];
        for (const { pubkey, account } of resp.value) {
          // `account.data.parsed.info` is the JSON-decoded SPL token state.
          // We do a defensive cast — if a future Token-22 extension changes
          // the shape, the panel just renders zero balances rather than
          // crashing the whole page.
// @ts-ignore
          const info = (account.data as any)?.parsed?.info;
          if (!info?.mint || !info?.tokenAmount) continue;
          let mintPk: PublicKey;
          try {
            mintPk = new PublicKey(info.mint);
          } catch {
            continue;
          }
          const amountStr = String(info.tokenAmount.amount ?? "0");
          let amount = 0n;
          try {
            amount = BigInt(amountStr);
          } catch {
            amount = 0n;
          }
          out.push({
            mint: mintPk,
            balance: amount,
            decimals: Number(info.tokenAmount.decimals ?? 9),
            symbol: null, // populated below in a single batch
            ata: pubkey,
          });
        }
        // Best-effort: fetch metadata for the unique mints in one batch via
        // getMultipleAccountsInfo so we can pull the TokenMetadata extension's
        // `symbol` for the picker label. We skip mints that fail to decode —
        // the picker just falls back to a truncated pubkey for those.
        const uniqueMints = Array.from(
          new Set(out.map((t) => t.mint.toBase58())),
        ).map((s) => new PublicKey(s));
        if (uniqueMints.length > 0) {
          try {
            const mintInfos = await connection.getMultipleAccountsInfo(
              uniqueMints,
              "confirmed",
            );
            for (let i = 0; i < uniqueMints.length; i++) {
              const acc = mintInfos[i];
              if (!acc?.data) continue;
              const sym = readTokenMetadataSymbol(acc.data);
              if (!sym) continue;
              const mintB58 = uniqueMints[i].toBase58();
              for (const t of out) {
                if (t.mint.toBase58() === mintB58) t.symbol = sym;
              }
            }
          } catch {
            // metadata fetch is non-fatal
          }
        }
        // Sort: positive balances first (alphabetical by symbol/pubkey), then
        // the dust empties at the bottom.
        out.sort((a, b) => {
          if (a.balance > 0n && b.balance === 0n) return -1;
          if (a.balance === 0n && b.balance > 0n) return 1;
          const al = a.symbol ?? a.mint.toBase58();
          const bl = b.symbol ?? b.mint.toBase58();
          return al.localeCompare(bl);
        });
        if (!cancelled) setTokens(out);
      } catch {
        if (!cancelled) setTokens([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, publicKey, connected, refreshKey]);

  return { tokens, refresh };
}

/**
 * Pull the `symbol` field out of a Token-22 mint account's TokenMetadata
 * extension. The extension is TLV-encoded after the 165-byte base mint —
 * we hunt for type 0x13 (TokenMetadata = 19 in upstream's enum), then
 * skip the borsh-encoded `update_authority` (Option<Pubkey>) and `mint`
 * (Pubkey) fields, then read the length-prefixed `name` and `symbol`
 * UTF-8 strings. Returns `null` on any malformation — the picker tolerates
 * a missing symbol and falls back to a truncated pubkey, so we don't
 * sweat edge cases here.
 */
function readTokenMetadataSymbol(data: Uint8Array): string | null {
  // Token-22 base Mint is 82 bytes; extensions start at offset 165 with a
  // 1-byte account_type discriminator at 165, then TLV pairs.
  const TLV_START = 166;
  if (data.length <= TLV_START) return null;
  let i = TLV_START;
  while (i + 4 <= data.length) {
    const extType = data[i] | (data[i + 1] << 8);
    const extLen = data[i + 2] | (data[i + 3] << 8);
    const extStart = i + 4;
    if (extStart + extLen > data.length) return null;
    if (extType === 19) {
      // TokenMetadata layout (post-spl-token-metadata-interface):
      // update_authority: Option<Pubkey> = 1 + 32 bytes (Some always in this ext)
      // mint: Pubkey = 32 bytes
      // name: string  (4-byte LE len + utf8)
      // symbol: string
      // uri: string
      // additional_metadata: Vec<(string,string)>
      let p = extStart + 33 + 32; // skip update_authority (33) + mint (32)
      // name
      if (p + 4 > extStart + extLen) return null;
      const nameLen =
        data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24);
      p += 4 + nameLen;
      if (p + 4 > extStart + extLen) return null;
      const symLen =
        data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24);
      p += 4;
      if (p + symLen > extStart + extLen) return null;
      try {
        return new TextDecoder().decode(data.slice(p, p + symLen));
      } catch {
        return null;
      }
    }
    i = extStart + extLen;
  }
  return null;
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
  const defaultMint = explicitMint ?? inferredMint;

  // User picker overrides the prop / URL inference. We only seed `picked`
  // from the URL the FIRST time we see one — subsequent picker selections
  // win, so the panel doesn't snap back to the URL mint when you navigate
  // around within `/launch/<mint>` pages.
  const [picked, setPicked] = useState<PublicKey | null>(null);
  const mint = picked ?? defaultMint ?? null;

  // Send form is collapsed by default — the panel needs to fit alongside
  // page content in a 320px sidebar without dominating the viewport. Click
  // the "Send" header (or the chevron) to expand. Persisted across renders
  // but not across reloads — sessionStorage gives a smooth UX without
  // leaking intent between sessions.
  const [sendOpen, setSendOpen] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const cached = window.sessionStorage.getItem("staccana.sendOpen");
      if (cached === "1") setSendOpen(true);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem("staccana.sendOpen", sendOpen ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [sendOpen]);

  // Hydration guard — wallet adapter context is only meaningful on the
  // client. Returning `null` during SSR avoids a flash of "Connect a wallet".
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const { connected } = useWallet();
  const { tokens, refresh } = useOwnedToken22();

  // Whole-panel collapse: when collapsed, render a small pill so the user
  // can pop the panel back open. Default COLLAPSED so a fresh page load
  // doesn't have the panel blocking the wallet button area on /megadrop /
  // /claim where the connect-wallet flow lives in the same column. State
  // persisted across renders via sessionStorage (separate key from the
  // inner send-form collapse).
  const [panelOpen, setPanelOpen] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const cached = window.sessionStorage.getItem("staccana.panelOpen");
      if (cached === "1") setPanelOpen(true);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(
        "staccana.panelOpen",
        panelOpen ? "1" : "0",
      );
    } catch {
      /* ignore */
    }
  }, [panelOpen]);

  if (!mounted) return null;

  // CRITICAL: while disconnected we render NOTHING. The previous "Connect a
  // wallet" Card sat at z-20 over the page hero AND covered the wallet-
  // adapter "Select Wallet" button on pages like /megadrop where the
  // connect button sits in the same column — a user reported they couldn't
  // dismiss the panel and couldn't reach the connect button.
  if (!connected) {
    return null;
  }

  // Collapsed pill — small floating button in the same fixed slot.
  if (!panelOpen) {
    return (
      <button
        type="button"
        onClick={() => setPanelOpen(true)}
        className={
          (className ?? "") +
          " inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/80 px-3 py-1.5 text-xs font-medium shadow-md backdrop-blur hover:bg-card"
        }
        aria-label="Open secret balance"
      >
        <span aria-hidden>🔒</span> Balance
      </button>
    );
  }

  // Loading state — `tokens === null` means the first fetch hasn't returned.
  if (tokens === null) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <span aria-hidden>🔒</span> Secret balance
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading your token-22 holdings…
          </div>
        </CardContent>
      </Card>
    );
  }

  // No tokens at all AND no override mint → empty-state with a CTA but
  // still keep the picker hidden (nothing to pick from).
  if (tokens.length === 0 && !mint) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <span aria-hidden>🔒</span> Secret balance
          </CardTitle>
          <CardDescription>
            You don&apos;t hold any Token-22 mints yet. Buy one to get started.
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

  // Build the picker option list. If the URL/prop mint isn't already in
  // the user's owned set (e.g. they're previewing a launch page for a
  // mint they haven't bought yet), we still include it so the form can
  // operate on it — but with balance 0.
  const seen = new Set(tokens.map((t) => t.mint.toBase58()));
  const options: OwnedToken[] = [...tokens];
  if (mint && !seen.has(mint.toBase58())) {
    options.unshift({
      mint,
      balance: 0n,
      decimals: 9,
      symbol: null,
      ata: token22Ata(
        // We need a payer address only as a placeholder for ATA derivation.
        // Reuse the mint itself — the result isn't used for any tx, just
        // to satisfy the OwnedToken shape. We never read `ata` for off-list
        // entries.
        mint,
        mint,
      ),
    });
  }

  const selected =
    options.find((t) => mint && t.mint.equals(mint)) ?? options[0] ?? null;

  return (
    <Card className={className}>
      <CardHeader className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <span aria-hidden>🔒</span> Secret balance
          </CardTitle>
          <button
            type="button"
            onClick={() => setPanelOpen(false)}
            className="-mr-1 -mt-1 inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            aria-label="Collapse panel"
            title="Collapse panel"
          >
            ×
          </button>
        </div>
        {options.length > 1 ? (
          <select
            value={selected ? selected.mint.toBase58() : ""}
            onChange={(e) => {
              const next = options.find(
                (t) => t.mint.toBase58() === e.target.value,
              );
              if (next) setPicked(next.mint);
            }}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {options.map((t) => (
              <option key={t.mint.toBase58()} value={t.mint.toBase58()}>
                {(t.symbol ?? truncatePubkey(t.mint.toBase58(), 4, 4)) +
                  " — " +
                  formatTokenAmount(t.balance, t.decimals)}
              </option>
            ))}
          </select>
        ) : null}
        {selected ? (
          <div className="space-y-0.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Balance
            </div>
            <div className="font-mono text-lg tabular-nums">
              {formatTokenAmount(selected.balance, selected.decimals)}
              {selected.symbol ? (
                <span className="ml-1 text-xs text-muted-foreground">
                  {selected.symbol}
                </span>
              ) : null}
            </div>
            <div className="break-all font-mono text-[10px] text-muted-foreground">
              {truncatePubkey(selected.mint.toBase58(), 6, 6)}
            </div>
          </div>
        ) : null}
      </CardHeader>
      <PendingClaimsRow onClaimed={refresh} />
      {selected ? (
        <>
          <button
            type="button"
            onClick={() => setSendOpen((v) => !v)}
            className="flex w-full items-center justify-between gap-2 border-t border-border/50 px-6 py-3 text-left text-sm font-medium hover:bg-secondary/40"
            aria-expanded={sendOpen}
            aria-controls="staccana-send-panel-body"
          >
            <span className="flex items-center gap-2">
              <span aria-hidden>🔒</span> Send
            </span>
            <span
              aria-hidden
              className={`text-xs text-muted-foreground transition-transform ${
                sendOpen ? "rotate-90" : ""
              }`}
            >
              ▶
            </span>
          </button>
          {sendOpen ? (
            <div id="staccana-send-panel-body">
              <SendPanelInner
                mint={selected.mint}
                decimals={selected.decimals}
                maxBalance={selected.balance}
                onAfterSend={refresh}
                embedded
              />
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

/** Format a raw integer token amount with `decimals` for display. */
function formatTokenAmount(amount: bigint, decimals: number): string {
  if (amount === 0n) return "0";
  const s = amount.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals) || "0";
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : whole;
}

function SendPanelInner({
  mint,
  className,
  decimals = 9,
  maxBalance,
  onAfterSend,
  embedded,
}: {
  mint: PublicKey;
  className?: string;
  decimals?: number;
  /** Available balance — used to enable a "Max" shortcut. */
  maxBalance?: bigint;
  /** Called after a successful submit so the parent can refresh balances. */
  onAfterSend?: () => void;
  /** When true, render bare CardContent only (no header) — parent owns chrome. */
  embedded?: boolean;
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
  /**
   * Set when we couldn't take the direct CT path (recipient ATA missing the
   * extension) and instead opened a non-canonical transit account on their
   * behalf. The recipient claims it via the "Pending claims" panel.
   */
  const [usedTransit, setUsedTransit] = useState(false);

  const recipient = useMemo(() => {
    try {
      return new PublicKey(recipientStr.trim());
    } catch {
      return null;
    }
  }, [recipientStr]);

  const amount = useMemo(
    () => parseDecimalToBigInt(amountStr, decimals),
    [amountStr, decimals],
  );

  const onSend = useCallback(async () => {
    setError(null);
    setUsedFallback(false);
    setUsedTransit(false);
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
      let pathTaken: "direct" | "transit" | "public" = "public";
      if (confidential) {
        try {
          const senderKeys = await deriveElGamalKeypair(
            { publicKey, signMessage: wallet.signMessage },
            mint,
          );
          // Derive the canonical ElGamal pubkey from the seed via the
          // wasm. The pubkey is `s_inv * H` (Pedersen blinding base) —
          // an earlier hack used the raw seed bytes here, which makes
          // the equality proof fail because the post-transfer source
          // ciphertext we synthesize uses the REAL pubkey to compute
          // the decrypt handle. The `pubkey_validity` proof endpoint's
          // `contextData` IS the 32-byte canonical pubkey by construction
          // (see solana-zk-sdk's `PubkeyValidityProofContext` — a single
          // `PodElGamalPubkey` field), so we piggyback on it.
          const senderPk = await deriveElGamalPubkeyFromSeed(senderKeys.secretSeed);
          const ixs = await buildTransferInstruction({
            ata: senderAta,
            destinationAta: recipientAta,
            mint,
            owner: publicKey,
            amount,
            senderElgamalPubkey: senderPk,
            recipientElgamalPubkey: new Uint8Array(32),
            auditorElgamalPubkey: new Uint8Array(32),
            newSourceDecryptableAvailableBalance: new Uint8Array(36),
            elgamalSeed: senderKeys.secretSeed,
            // The current decrypted available balance plaintext, supplied by
            // the picker. The on-chain ciphertext stays encrypted — this is
            // only consumed locally to compute the post-transfer ciphertext
            // with matching randomness. See `lib/confidential.ts` for the
            // full privacy-impact note.
            currentAvailablePlaintext: maxBalance ?? 0n,
          });
          for (const ix of ixs) tx.add(ix);
          usedConfidential = true;
          pathTaken = "direct";
        } catch (err) {
          if (!(err instanceof ProofUnavailableError)) {
            throw err;
          }
          // eslint-disable-next-line no-console
          console.warn(
            "[send] direct CT path unavailable, trying transit-account hack",
            err.code,
          );
        }
      }

      if (!usedConfidential && confidential) {
        // Recipient hasn't pre-configured a ConfidentialTransferAccount on
        // their canonical ATA — open a non-canonical Token-22 account on
        // their behalf, transfer into it under a transit ElGamal keypair,
        // and SetAuthority the new account to them. They claim later via
        // the "Pending claims" UI. See lib/confidential-transit.ts for the
        // wire format + obfuscation trade-off.
        try {
          const senderKeys = await deriveElGamalKeypair(
            { publicKey, signMessage: wallet.signMessage },
            mint,
          );
          const senderPk = await deriveElGamalPubkeyFromSeed(
            senderKeys.secretSeed,
          );
          const bundle = await prepareTransitSendIxs({
            connection,
            sender: publicKey,
            senderAta,
            recipient,
            mint,
            amount,
            senderElgamalSeed: senderKeys.secretSeed,
            senderElgamalPubkey: senderPk,
            newSourceDecryptableAvailableBalance: new Uint8Array(36),
            currentAvailablePlaintext: maxBalance ?? 0n,
          });

          // Build a v0 tx + LUT — the bundle has 5 outer ixs + 4 verify ixs
          // + memo, well over the 1232-byte legacy limit.
          const blockhash = (
            await connection.getLatestBlockhash("confirmed")
          ).blockhash;
          const lutResp = await connection.getAddressLookupTable(
            STACCANA_MASTER_LUT,
            { commitment: "confirmed" },
          );
          if (!lutResp.value) {
            throw new Error(
              "Master LUT not visible on chain — recipient setup required",
            );
          }
          const message = new TransactionMessage({
            payerKey: publicKey,
            recentBlockhash: blockhash,
            // Drop the standalone CreateAta ix — we never use the recipient's
            // canonical ATA in the transit flow (the new account lives at a
            // fresh keypair).
            instructions: bundle.instructions,
          }).compileToV0Message([lutResp.value]);
          const vtx = new VersionedTransaction(message);
          vtx.sign([bundle.newAccount]);
          const sig = await sendTransaction(vtx, connection, {
            skipPreflight: true,
          });
          toast({
            variant: "success",
            title: "Transit drop submitted",
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
          setUsedTransit(true);
          onAfterSend?.();
          return;
        } catch (err) {
          // Transit also failed — fall through to public TransferChecked.
          // eslint-disable-next-line no-console
          console.warn("[send] transit-account path failed, falling back", err);
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
      void pathTaken;
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
    onAfterSend,
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
        {usedTransit ? (
          <p className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2 text-[11px] text-emerald-200">
            Recipient hadn&apos;t opened a confidential account, so we created
            a transit account on their behalf. They can claim it from the
            &quot;Pending claims&quot; section of their wallet.
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

/**
 * "Pending claims" row at the top of the secret-balance card. Scans the
 * connected wallet for non-canonical Token-22 accounts (transit drops) and
 * exposes a one-click "Claim" button per item.
 *
 * The claim is unavoidably 2 transactions:
 *
 *   TX A: ApplyPendingBalance — flushes the post-Transfer pending_balance
 *         into available_balance under the transit ElGamal keypair.
 *   TX B: Withdraw + EmptyAccount + ConfigureAccount + Deposit +
 *         ApplyPendingBalance (v0 + LUT) — re-keys the account onto the
 *         recipient's own ElGamal pubkey with the funds preserved as
 *         encrypted pending balance.
 *
 * See `lib/confidential-transit.ts` for the flow + memo wire-format.
 */
function PendingClaimsRow({
  onClaimed,
}: {
  onClaimed?: () => void;
}): JSX.Element | null {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { publicKey, connected, sendTransaction } = wallet;
  const { toast } = useToast();
  const [pending, setPending] = useState<PendingTransitAccount[] | null>(null);
  const [claimingKey, setClaimingKey] = useState<string | null>(null);

  useEffect(() => {
    if (!publicKey || !connected) {
      setPending(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // We pass `null` for the canonical ElGamal pubkey — without a
        // signMessage prompt at scan time we can't derive it. The result is
        // that a recipient's own previously-CT-configured ATA shows up as
        // a "pending claim" too. Future: cache the derived pubkey in
        // sessionStorage after the first signMessage so the scan can filter.
        const found = await scanPendingTransitAccounts(
          connection,
          publicKey,
          null,
        );
        if (!cancelled) setPending(found);
      } catch {
        if (!cancelled) setPending([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, publicKey, connected]);

  const onClaim = useCallback(
    async (p: PendingTransitAccount) => {
      if (!publicKey || !connected) {
        toast({ variant: "destructive", title: "Wallet not connected" });
        return;
      }
      const accountKey = p.account.toBase58();
      try {
        setClaimingKey(accountKey);

        // 1. Recover the transit ElGamal seed + amount from the on-chain
        //    memo. v2 memos embed the amount; v1 memos return null and the
        //    claim aborts (we'd have to brute-force the discrete log
        //    otherwise — out of scope for tonight's hack).
        const memoMatch = await findTransitMemoForAccountV2(
          connection,
          p.account,
          null,
          publicKey,
          p.mint,
        );
        if (!memoMatch) {
          throw new Error(
            "Could not find the transit memo for this account on chain.",
          );
        }
        if (memoMatch.amount === null) {
          throw new Error(
            "This is an older v1 transit drop without an embedded amount; claim flow needs a v2 memo. Ask the sender to re-send.",
          );
        }
        const transitSeed = memoMatch.transitSeed;
        // The placeholder pubkey the sender used during ConfigureAccount —
        // matches `transitElGamalPubkeyPlaceholder` (seed.slice(0, 32)).
        const transitPubkey = transitSeed.slice(0, 32);
        const amount = memoMatch.amount;

        // 2. Derive the recipient's OWN ElGamal seed + pubkey — this prompts
        //    a signMessage. Mirrors the sender's `deriveElGamalKeypair` call
        //    so the resulting transit-account state looks identical to a
        //    self-configured ATA after the claim lands.
        const recipientKeys = await deriveElGamalKeypair(
          { publicKey, signMessage: wallet.signMessage },
          p.mint,
        );
        const recipientPubkey = recipientKeys.secretSeed.slice(0, 32);

        // 3. Fetch decimals (Token-22 base account stores the mint pubkey
        //    only; decimals lives on the mint account itself). We pull both
        //    in one batch.
        const [mintInfo, accountState] = await Promise.all([
          connection.getParsedAccountInfo(p.mint, "confirmed"),
          fetchConfidentialAccountState(connection, p.account),
        ]);
        let decimals = 9;
// @ts-ignore
        const mintParsed: any = mintInfo.value?.data;
        if (
          mintParsed &&
          typeof mintParsed === "object" &&
          "parsed" in mintParsed &&
          mintParsed.parsed?.info?.decimals !== undefined
        ) {
          decimals = Number(mintParsed.parsed.info.decimals);
        }
        if (!accountState) {
          throw new Error(
            "Transit account state not parseable — already claimed or not configured?",
          );
        }

        // 4. TX A — ApplyPendingBalance. Flush the post-Transfer pending
        //    into available so the migration tx has a known on-chain
        //    available_balance ciphertext to feed into the equality proof.
        //    `expected_pending_balance_credit_counter` must equal the
        //    on-chain `pending_balance_credit_counter` AT TIME OF CALL
        //    (the total number of credits the user expects to be flushing).
        const applyIxs = prepareTransitClaimApplyPendingTx({
          account: p.account,
          recipient: publicKey,
          expectedPendingBalanceCreditCounter:
            accountState.pendingBalanceCreditCounter,
        });
        const applyTx = new Transaction();
        for (const ix of applyIxs) applyTx.add(ix);
        applyTx.feePayer = publicKey;
        applyTx.recentBlockhash = (
          await connection.getLatestBlockhash("confirmed")
        ).blockhash;
        const sigA = await sendTransaction(applyTx, connection, {
          skipPreflight: true,
        });
        await connection.confirmTransaction(sigA, "confirmed");

        // 5. Re-fetch the available_balance ciphertext now that
        //    ApplyPendingBalance landed.
        const postApply = await fetchConfidentialAccountState(
          connection,
          p.account,
        );
        if (!postApply) {
          throw new Error("Failed to re-fetch transit account state after apply");
        }

        // 6. TX B — full migration. v0 + LUT (9 ixs total + LUT scope).
        const migrationIxs = await prepareTransitClaimMigrationTx({
          account: p.account,
          recipient: publicKey,
          mint: p.mint,
          decimals,
          amount,
          availableCiphertextBeforeWithdraw: postApply.availableBalance,
          transitSeed,
          transitPubkey,
          recipientElgamalSeed: recipientKeys.secretSeed,
          recipientElgamalPubkey: recipientPubkey,
        });
        const lutResp = await connection.getAddressLookupTable(
          STACCANA_MASTER_LUT,
          { commitment: "confirmed" },
        );
        if (!lutResp.value) {
          throw new Error(
            "Master LUT not visible on chain — recipient setup required",
          );
        }
        const blockhash = (await connection.getLatestBlockhash("confirmed"))
          .blockhash;
        const message = new TransactionMessage({
          payerKey: publicKey,
          recentBlockhash: blockhash,
          instructions: migrationIxs,
        }).compileToV0Message([lutResp.value]);
        const vtx = new VersionedTransaction(message);
        const sigB = await sendTransaction(vtx, connection, {
          skipPreflight: true,
        });
        toast({
          variant: "success",
          title: "Claim submitted",
          description: (
            <a
              className="font-mono text-xs underline underline-offset-2"
              href={explorerTxUrl(sigB)}
              target="_blank"
              rel="noreferrer"
            >
              {truncatePubkey(sigB, 8, 8)}
            </a>
          ),
        });
        // Drop the row optimistically; the next scan will pick up the new
        // (now self-keyed) account state.
        setPending((prev) =>
          (prev ?? []).filter((q) => !q.account.equals(p.account)),
        );
        onClaimed?.();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast({
          variant: "destructive",
          title: "Claim failed",
          description: msg,
        });
      } finally {
        setClaimingKey(null);
      }
    },
    [
      publicKey,
      connected,
      connection,
      sendTransaction,
      wallet.signMessage,
      toast,
      onClaimed,
    ],
  );

  if (!pending || pending.length === 0) return null;

  return (
    <div className="border-t border-border/50 px-6 py-3 text-xs">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium">Pending claims</span>
        <span className="text-[10px] text-muted-foreground">
          {pending.length}
        </span>
      </div>
      <ul className="space-y-1">
        {pending.map((p) => {
          const key = p.account.toBase58();
          const busy = claimingKey === key;
          return (
            <li
              key={key}
              className="flex items-center justify-between gap-2 rounded border border-border/40 bg-secondary/20 px-2 py-1.5"
            >
              <div className="min-w-0 space-y-0.5">
                <div className="truncate font-mono text-[10px] text-muted-foreground">
                  {truncatePubkey(p.mint.toBase58(), 4, 4)}
                </div>
                <div className="truncate font-mono text-[10px]">
                  {truncatePubkey(p.account.toBase58(), 4, 4)}
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                className="h-6 px-2 text-[10px]"
                disabled={busy || claimingKey !== null}
                onClick={() => void onClaim(p)}
                title="Run the 2-tx Withdraw+Empty+Configure+Deposit+Apply migration"
              >
                {busy ? (
                  <>
                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    Claiming…
                  </>
                ) : (
                  "Claim"
                )}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
