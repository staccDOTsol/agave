/**
 * Secret-pump page (TODO stub).
 *
 * v0 ships claim only. The pump UI (launch + buy + sell against a confidential
 * bonding curve) lands in a follow-up scaffold round once the secret-pump
 * program has shipped and the FBA matcher integrations are in place.
 */

import Link from "next/link";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function PumpPage(): JSX.Element {
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">pump</p>
        <h1 className="text-3xl font-semibold tracking-tight">Launch a confidential token</h1>
        <p className="max-w-2xl text-muted-foreground">
          secret-pump is a bonding-curve token launcher where balances and sizes are encrypted by
          default via the Token-22 Confidential Transfer Extension. No public leaderboard, no
          sniper bots, no atomic sandwich (FBA matcher rules out front-running at the consensus
          layer).
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Coming in v1.0 (mainnet-sigma)</CardTitle>
          <CardDescription>
            The launch UI lands once secret-pump has shipped, the FBA matcher is active for
            pump-launched mints, and the secret-ray router can swap pump tokens against the rest
            of staccana liquidity.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <Link
              className="underline underline-offset-2"
              href="https://github.com/staccDOTsol/solana-classic/blob/main/docs/SECRET_RAY.md"
              target="_blank"
            >
              docs/SECRET_RAY.md
            </Link>{" "}
            describes the AMM and router layers.
          </p>
          <p>
            <Link
              className="underline underline-offset-2"
              href="https://github.com/staccDOTsol/solana-classic/blob/main/docs/SPEC.md"
              target="_blank"
            >
              docs/SPEC.md
            </Link>{" "}
            §6 specifies the FBA matcher contract.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
