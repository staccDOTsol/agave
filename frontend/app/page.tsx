import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function HomePage(): JSX.Element {
  return (
    <div className="space-y-12">
      <section className="space-y-4">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">staccana mainnet-sigma</p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          A Solana fork with secrecy at genesis and no atomic MEV.
        </h1>
        <p className="max-w-2xl text-lg text-muted-foreground">
          Confidential token transfers ship live at slot zero. Per-mint frequent-batch auctions
          structurally eliminate sandwiches. If you held SOL on Solana mainnet at the snapshot
          slot, you have a claimable balance here.
        </p>
        <div className="flex gap-3 pt-2">
          <Link href="/claim">
            <Button size="lg">Claim your SOL</Button>
          </Link>
          <a
            href="https://github.com/staccDOTsol/solana-classic"
            target="_blank"
            rel="noreferrer"
          >
            <Button size="lg" variant="outline">
              Read the spec
            </Button>
          </a>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Claim</CardTitle>
            <CardDescription>
              Materialize your mainnet SOL balance on staccana via Merkle proof + ed25519 signature.
              Gas-free per SPEC §4.4.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/claim">
              <Button variant="secondary" className="w-full">
                Open claim flow
              </Button>
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Bridge</CardTitle>
            <CardDescription>
              Deposit SOL or USDC on Solana mainnet to mint stSOL or ssUSDC on staccana.
              Confidential transfers active at genesis.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/bridge">
              <Button variant="secondary" className="w-full">
                Open bridge
              </Button>
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pump</CardTitle>
            <CardDescription>
              Launch a confidential-by-default token on the staccana secret-pump bonding curve.
              No leaderboard, no sniper bots.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/pump">
              <Button variant="secondary" className="w-full">
                Open pump
              </Button>
            </Link>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
