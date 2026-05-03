"use client";

/**
 * Claim flow MVP. Acceptance criteria are in the scaffold spec — this page:
 *
 * 1. Shows a Connect Wallet button (Phantom / Solflare / Backpack).
 * 2. After connect, fetches the genesis snapshot from snapshot.mp.fun and
 *    caches it in IndexedDB.
 * 3. Reports eligibility: "X SOL claimable" or "no claim for <pubkey>".
 * 4. On click, builds the Merkle inclusion proof + signs the claim message
 *    via wallet.signMessage + assembles the two-instruction tx.
 * 5. Submits via @solana/web3.js against rpc.mp.fun.
 * 6. Toasts success (with explorer link) or failure.
 */

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/use-toast";
import {
  buildClaimMessage,
  buildClaimTransaction,
} from "@/lib/claim";
import { recomputeRoot, toHex, type InclusionProof } from "@/lib/merkle";
import { explorerTxUrl } from "@/lib/staccana";
import { formatSol, truncatePubkey } from "@/lib/utils";

/**
 * Eligibility state — single edge-function lookup keyed on the connected
 * wallet's pubkey. We deliberately don't fetch the full genesis snapshot
 * (85.6M leaves, multi-GB) — that's what `app/api/claim/[pubkey]/route.ts`
 * exists for. The route returns just this wallet's leaf + proof, or 404 if
 * not in the set.
 */
type EligibilityState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "eligible"; proof: InclusionProof }
  | { kind: "not_in_set" }
  | { kind: "pending_index" }
  | { kind: "error"; message: string };

type ClaimState =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "signing" }
  | { kind: "submitting" }
  | { kind: "success"; signature: string }
  | { kind: "error"; message: string };

export default function ClaimPage(): JSX.Element {
  const { publicKey, signMessage, sendTransaction, connected } = useWallet();
  const { connection } = useConnection();
  const { toast } = useToast();

  const [eligibility, setEligibility] = useState<EligibilityState>({ kind: "idle" });
  const [claim, setClaim] = useState<ClaimState>({ kind: "idle" });

  // Look up this wallet's leaf+proof via the edge function whenever the
  // connected pubkey changes. One round-trip, ~200B response.
  useEffect(() => {
    if (!connected || !publicKey) {
      setEligibility({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setEligibility({ kind: "loading" });
    fetch(`/api/claim/${publicKey.toBase58()}`)
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 404) {
          // The edge fn returns 404 for both "not in set" and "snapshot index
          // pending"; the body distinguishes via the `error` field.
          const body = (await r.json()) as { error?: string };
          if (body.error === "snapshot index pending") {
            setEligibility({ kind: "pending_index" });
          } else {
            setEligibility({ kind: "not_in_set" });
          }
          return;
        }
        if (!r.ok) {
          throw new Error(`/api/claim returned ${r.status}`);
        }
        const proof = (await r.json()) as InclusionProof;
        setEligibility({ kind: "eligible", proof });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setEligibility({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [connected, publicKey]);

  const proof = eligibility.kind === "eligible" ? eligibility.proof : null;

  const eligibilitySummary = useMemo(() => {
    if (!connected || !publicKey) return "Connect your wallet to check eligibility.";
    switch (eligibility.kind) {
      case "loading":
        return "Looking up your wallet in the genesis snapshot...";
      case "pending_index":
        return "Snapshot index is being uploaded. Check back shortly.";
      case "not_in_set":
        return `No claimable balance for ${truncatePubkey(publicKey.toBase58())}.`;
      case "eligible":
        return `You are eligible to claim ${formatSol(eligibility.proof.lamports)} SOL.`;
      case "error":
        return `Lookup error: ${eligibility.message}`;
      default:
        return "";
    }
  }, [connected, publicKey, eligibility]);

  const onClaim = useCallback(async () => {
    if (!publicKey || !signMessage || !proof) {
      setClaim({ kind: "error", message: "Wallet or proof not ready" });
      return;
    }
    try {
      // Self-check: recomputed root must match the one we built into the proof.
      // Catches any local impl drift before we ask the user to sign.
      setClaim({ kind: "preparing" });
      const recomputed = await recomputeRoot(proof);
      if (toHex(recomputed) !== toHex(proof.root)) {
        throw new Error("inclusion proof self-check failed");
      }

      // Sign the SPEC §4.2 message using the wallet's signMessage entry point.
      const message = buildClaimMessage(publicKey, proof.lamports);
      setClaim({ kind: "signing" });
      const signature = await signMessage(message);
      if (signature.length !== 64) {
        throw new Error(`unexpected signature length: ${signature.length}`);
      }

      // Assemble the two-instruction tx (ed25519 precompile + claim ix).
      const tx = await buildClaimTransaction({
        proof,
        signature,
        signerPubkey: publicKey,
        message,
        payer: publicKey,
        connection,
      });

      // Submit via wallet-adapter (which routes through the wallet's send +
      // sign flow). For the gas-exempt path, the lazy-claim program covers
      // the fee from the treasury — so the wallet should succeed even with
      // zero staccana SOL. See SPEC §4.4.
      setClaim({ kind: "submitting" });
      const txSig = await sendTransaction(tx, connection, { skipPreflight: true });
      setClaim({ kind: "success", signature: txSig });
      toast({
        variant: "success",
        title: "Claim submitted",
        description: (
          <a
            className="font-mono text-xs underline underline-offset-2"
            href={explorerTxUrl(txSig)}
            target="_blank"
            rel="noreferrer"
          >
            {truncatePubkey(txSig, 8, 8)}
          </a>
        ),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setClaim({ kind: "error", message });
      toast({ variant: "destructive", title: "Claim failed", description: message });
    }
  }, [connection, proof, publicKey, sendTransaction, signMessage, toast]);

  const claimDisabled =
    !connected ||
    !proof ||
    claim.kind === "preparing" ||
    claim.kind === "signing" ||
    claim.kind === "submitting";

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">claim</p>
        <h1 className="text-3xl font-semibold tracking-tight">Claim your mainnet SOL on staccana</h1>
        <p className="max-w-2xl text-muted-foreground">
          Connect the wallet that holds your mainnet SOL. We build a Merkle inclusion proof
          against the genesis snapshot, you sign the claim message with your existing keypair,
          and the lazy-claim program credits your balance on staccana. Per SPEC §4.4 the claim
          transaction is fee-exempt — you do not need any staccana SOL.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Eligibility</CardTitle>
          <CardDescription>{eligibilitySummary}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {publicKey ? (
            <p className="text-sm text-muted-foreground">
              Wallet:{" "}
              <span className="font-mono text-foreground" title={publicKey.toBase58()}>
                {truncatePubkey(publicKey.toBase58())}
              </span>
            </p>
          ) : null}

          {proof ? (
            <dl className="grid gap-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Lamports</dt>
                <dd className="font-mono">{proof.lamports.toString()}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Proof depth</dt>
                <dd className="font-mono">{proof.proof.length}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Root</dt>
                <dd className="break-all font-mono text-xs">{toHex(proof.root)}</dd>
              </div>
            </dl>
          ) : null}

          <Button onClick={onClaim} disabled={claimDisabled} className="w-full sm:w-auto">
            {claim.kind === "preparing" || claim.kind === "signing" || claim.kind === "submitting" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {claim.kind === "preparing"
                  ? "Building proof"
                  : claim.kind === "signing"
                    ? "Awaiting signature"
                    : "Submitting"}
              </>
            ) : (
              "Submit claim"
            )}
          </Button>

          {claim.kind === "success" ? (
            <p className="text-sm text-emerald-400">
              Submitted.{" "}
              <Link
                className="underline underline-offset-2"
                href={explorerTxUrl(claim.signature)}
                target="_blank"
              >
                View on explorer
              </Link>
            </p>
          ) : null}
          {claim.kind === "error" ? (
            <p className="text-sm text-destructive">{claim.message}</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
