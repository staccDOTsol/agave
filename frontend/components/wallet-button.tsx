"use client";

/**
 * Connect / disconnect button + truncated pubkey display.
 *
 * Wraps the wallet-adapter `WalletMultiButton` so the rest of the app can
 * render a single import. The styling matches our shadcn primitives (the
 * default WalletMultiButton uses its own CSS, which we leave intact via the
 * imported wallet-adapter-react-ui CSS bundle in app/layout.tsx).
 */

import { useWallet } from "@solana/wallet-adapter-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

import { truncatePubkey } from "@/lib/utils";

// WalletMultiButton must be client-side only — it touches `window` during
// render. next/dynamic with ssr:false sidesteps the hydration mismatch.
const WalletMultiButton = dynamic(
  async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false },
);

export function WalletButton(): JSX.Element {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="h-10 w-44 rounded-md bg-secondary/40" aria-hidden />;
  return <WalletMultiButton />;
}

/**
 * Inline display of the connected pubkey. Renders nothing if no wallet is
 * connected — useful in places where the connect button is shown elsewhere.
 */
export function ConnectedPubkey(): JSX.Element | null {
  const { publicKey } = useWallet();
  if (!publicKey) return null;
  const base58 = publicKey.toBase58();
  return (
    <span className="font-mono text-xs text-muted-foreground" title={base58}>
      {truncatePubkey(base58)}
    </span>
  );
}
