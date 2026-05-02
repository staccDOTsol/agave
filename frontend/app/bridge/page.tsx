/**
 * Bridge page (TODO stub).
 *
 * v0 ships claim only. The bridge UI lands in a follow-up scaffold round once
 * register_asset has run on mainnet-sigma and the federation is operational.
 * See docs/BRIDGE.md for the on-chain protocol.
 */

import Link from "next/link";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function BridgePage(): JSX.Element {
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">bridge</p>
        <h1 className="text-3xl font-semibold tracking-tight">Bridge SOL or USDC into staccana</h1>
        <p className="max-w-2xl text-muted-foreground">
          Deposit SOL on mainnet to mint stSOL on staccana (pSYRUP-backed, ratio R drifts upward
          over time). Deposit USDC on mainnet to mint ssUSDC. Both mints are Token-22 with the
          Confidential Transfer Extension active by default.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Coming in v1.0 (mainnet-sigma)</CardTitle>
          <CardDescription>
            The bridge UI lands once register_asset has run on mainnet-sigma and the 5-of-9
            federation is signing ratio attestations. The on-chain protocol is fully specified
            today — see the bridge spec for instruction layouts and the federation flow.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <Link
              className="underline underline-offset-2"
              href="https://github.com/staccDOTsol/solana-classic/blob/main/docs/BRIDGE.md"
              target="_blank"
            >
              docs/BRIDGE.md
            </Link>{" "}
            covers the mint flow, burn flow, ratio attestation, and federation rotation.
          </p>
          <p>
            For early bridge access, follow the staccana repo for release notes pinning the real
            stSOL and ssUSDC mint addresses.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
