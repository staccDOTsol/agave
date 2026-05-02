/**
 * Top navigation bar — wordmark + page links + wallet connect.
 */

import Link from "next/link";

import { WalletButton } from "./wallet-button";

export function SiteHeader(): JSX.Element {
  return (
    <header className="border-b border-border/60 bg-background/95 backdrop-blur">
      <div className="container flex h-14 items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="font-mono text-base font-semibold tracking-tight">
            staccana
          </Link>
          <nav className="hidden items-center gap-4 text-sm text-muted-foreground sm:flex">
            <Link href="/claim" className="hover:text-foreground">
              Claim
            </Link>
            <Link href="/bridge" className="hover:text-foreground">
              Bridge
            </Link>
            <Link href="/pump" className="hover:text-foreground">
              Pump
            </Link>
          </nav>
        </div>
        <WalletButton />
      </div>
    </header>
  );
}
