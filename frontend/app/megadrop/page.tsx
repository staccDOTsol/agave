"use client";

/**
 * Megadrop page.
 *
 * Flow:
 *
 * 1. Wallet connect.
 * 2. Fetch the snapshot tool's `allocations.json` (the file
 *    `tools/megadrop-snapshot/src/output.rs` writes). Find the connected
 *    wallet's row.
 * 3. Read the holder's `ClaimedMegadrop` PDA on chain to know which tranche
 *    bits have already been claimed.
 * 4. Read the singleton `MegadropConfig` PDA to know the genesis month and
 *    treasury authority. Compute which tranches are unlocked given the current
 *    Unix time.
 * 5. User selects which available tranches to claim. We build the canonical
 *    claim message, ask the wallet to sign it (`signMessage`), assemble the
 *    ed25519 precompile + claim_megadrop ix pair, submit.
 *
 * Calendar math (yyyymm) and message construction are byte-equal to the
 * Rust impl — verified via `tests/megadrop.test.ts`.
 */

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import { Loader2 } from "lucide-react";
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
import { buildEd25519PrecompileInstruction } from "@/lib/claim";
import { recomputeRoot, toHex, type InclusionProof } from "@/lib/merkle";
import {
  buildClaimMegadropInstruction,
  buildMegadropClaimMessage,
  buildMegadropProof,
  fetchClaimedMegadrop,
  fetchMegadropAllocations,
  fetchMegadropConfig,
  findAllocation,
  isTrancheClaimed,
  isTrancheUnlocked,
  monthFromUnixTimestamp,
  NUM_TRANCHES,
  trancheAmount,
  trancheUnlockMonth,
  validateAndPackTranches,
  type ClaimedMegadropState,
  type MegadropAllocation,
  type MegadropConfigState,
} from "@/lib/megadrop";
import { explorerTxUrl, MEGADROP_PROGRAM_ID, MEGADROP_URL } from "@/lib/staccana";
import { formatSol, truncatePubkey } from "@/lib/utils";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type AllocationsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; rows: MegadropAllocation[] }
  | { kind: "error"; message: string };

type ConfigState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; cfg: MegadropConfigState }
  | { kind: "missing" }
  | { kind: "error"; message: string };

type ClaimSubmit =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "signing" }
  | { kind: "submitting" }
  | { kind: "success"; signature: string }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function MegadropPage(): JSX.Element {
  const { publicKey, signMessage, sendTransaction, connected } = useWallet();
  const { connection } = useConnection();
  const { toast } = useToast();

  const [allocations, setAllocations] = useState<AllocationsState>({ kind: "idle" });
  const [config, setConfig] = useState<ConfigState>({ kind: "idle" });
  const [claimedState, setClaimedState] = useState<ClaimedMegadropState | null>(null);
  const [proof, setProof] = useState<InclusionProof | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [submit, setSubmit] = useState<ClaimSubmit>({ kind: "idle" });
  const [refreshKey, setRefreshKey] = useState(0);

  // Load allocations once on mount.
  useEffect(() => {
    let cancelled = false;
    setAllocations({ kind: "loading" });
    fetchMegadropAllocations()
      .then((rows) => {
        if (!cancelled) setAllocations({ kind: "ready", rows });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setAllocations({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load on-chain config (genesis_month, treasury_authority, claimable_root).
  useEffect(() => {
    let cancelled = false;
    setConfig({ kind: "loading" });
    fetchMegadropConfig(connection)
      .then((cfg) => {
        if (cancelled) return;
        if (!cfg) setConfig({ kind: "missing" });
        else setConfig({ kind: "ready", cfg });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setConfig({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connection, refreshKey]);

  // Compute the user's allocation row.
  const myAllocation = useMemo<MegadropAllocation | null>(() => {
    if (allocations.kind !== "ready" || !publicKey) return null;
    return findAllocation(allocations.rows, publicKey);
  }, [allocations, publicKey]);

  // Build the inclusion proof for the user's row.
  useEffect(() => {
    if (allocations.kind !== "ready" || !publicKey || !myAllocation) {
      setProof(null);
      return;
    }
    let cancelled = false;
    buildMegadropProof(allocations.rows, publicKey)
      .then((p) => {
        if (!cancelled) setProof(p);
      })
      .catch(() => {
        if (!cancelled) setProof(null);
      });
    return () => {
      cancelled = true;
    };
  }, [allocations, publicKey, myAllocation]);

  // Read on-chain ClaimedMegadrop PDA so we know which tranches are spent.
  useEffect(() => {
    if (!publicKey || !connected) {
      setClaimedState(null);
      return;
    }
    let cancelled = false;
    fetchClaimedMegadrop(connection, publicKey)
      .then((s) => {
        if (!cancelled) setClaimedState(s);
      })
      .catch(() => {
        if (!cancelled) setClaimedState(null);
      });
    return () => {
      cancelled = true;
    };
  }, [connection, publicKey, connected, refreshKey]);

  // Compute current month locally (good enough for UI; on-chain handler uses
  // the Clock sysvar, but for display we just rely on the user's clock).
  const currentMonth = useMemo(() => {
    return monthFromUnixTimestamp(Math.floor(Date.now() / 1000));
  }, []);

  // Per-tranche status: claimed vs unlocked vs locked.
  const tranches = useMemo(() => {
    if (!myAllocation) return [];
    const genesisMonth = config.kind === "ready" ? config.cfg.genesisMonth : null;
    const claimedBitmap = claimedState?.tranchesClaimed ?? 0;
    const out: Array<{
      idx: number;
      unlockMonth: number | null;
      claimed: boolean;
      unlocked: boolean;
      perTranche: bigint;
    }> = [];
    const perTranche = trancheAmount(myAllocation.allocationLamports);
    for (let i = 1; i <= NUM_TRANCHES; i++) {
      const claimed = isTrancheClaimed(claimedBitmap, i);
      const unlockMonth = genesisMonth ? trancheUnlockMonth(genesisMonth, i) : null;
      const unlocked = genesisMonth ? isTrancheUnlocked(genesisMonth, currentMonth, i) : false;
      out.push({ idx: i, unlockMonth, claimed, unlocked, perTranche });
    }
    return out;
  }, [myAllocation, config, claimedState, currentMonth]);

  const claimableTranches = useMemo(
    () => tranches.filter((t) => !t.claimed && t.unlocked).map((t) => t.idx),
    [tranches],
  );

  const toggleSelected = useCallback((idx: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const selectAllAvailable = useCallback(() => {
    setSelected(new Set(claimableTranches));
  }, [claimableTranches]);

  const claimAmountPreview = useMemo(() => {
    if (!myAllocation) return 0n;
    const per = trancheAmount(myAllocation.allocationLamports);
    return per * BigInt(selected.size);
  }, [myAllocation, selected]);

  // ---- Submit claim ----
  const onClaim = useCallback(async () => {
    setSubmit({ kind: "idle" });
    if (!publicKey || !signMessage) {
      setSubmit({ kind: "error", message: "Wallet not connected or does not support signMessage" });
      return;
    }
    if (!myAllocation || !proof) {
      setSubmit({ kind: "error", message: "No allocation found for this wallet" });
      return;
    }
    if (config.kind !== "ready") {
      setSubmit({ kind: "error", message: "MegadropConfig not loaded — has init_megadrop run?" });
      return;
    }
    if (selected.size === 0) {
      setSubmit({ kind: "error", message: "Pick at least one tranche to claim" });
      return;
    }

    try {
      // Inclusion-proof self-check before asking the user to sign.
      setSubmit({ kind: "preparing" });
      const recomputed = await recomputeRoot(proof);
      if (toHex(recomputed) !== toHex(config.cfg.claimableRoot)) {
        throw new Error(
          `inclusion proof root mismatch — local recomputed=${toHex(recomputed)}, on-chain=${toHex(config.cfg.claimableRoot)}`,
        );
      }

      // Build the canonical claim message (matches build_claim_message in Rust).
      const requested = Array.from(selected).sort((a, b) => a - b);
      const { sorted, bitmap: _bitmap } = validateAndPackTranches(requested);
      const message = buildMegadropClaimMessage(
        publicKey,
        myAllocation.allocationLamports,
        sorted,
        MEGADROP_PROGRAM_ID,
      );

      setSubmit({ kind: "signing" });
      const signature = await signMessage(message);
      if (signature.length !== 64) {
        throw new Error(`unexpected signature length: ${signature.length}`);
      }

      // Two-instruction tx: ed25519 precompile (sysvar Instructions reads it
      // back), then claim_megadrop.
      const ed25519Ix = buildEd25519PrecompileInstruction(publicKey, signature, message);
      const claimIx = buildClaimMegadropInstruction({
        holder: publicKey,
        totalAllocation: myAllocation.allocationLamports,
        trancheIndices: requested,
        proof: proof.proof,
        proofFlags: proof.proofFlags,
        treasuryAuthority: config.cfg.treasuryAuthority,
        relayer: publicKey,
      });
      const tx = new Transaction();
      tx.add(ed25519Ix);
      tx.add(claimIx);
      tx.feePayer = publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

      setSubmit({ kind: "submitting" });
      const sig = await sendTransaction(tx, connection, { skipPreflight: true });
      setSubmit({ kind: "success", signature: sig });
      toast({
        variant: "success",
        title: `Claimed ${formatSol(claimAmountPreview)} SOL`,
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
      setSelected(new Set());
      setRefreshKey((k) => k + 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSubmit({ kind: "error", message });
      toast({ variant: "destructive", title: "Megadrop claim failed", description: message });
    }
  }, [
    publicKey,
    signMessage,
    sendTransaction,
    connection,
    myAllocation,
    proof,
    config,
    selected,
    claimAmountPreview,
    toast,
  ]);

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">megadrop</p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Holder claim — based_stacc_0 + proofv3
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          Snapshotted holders of two Solana mainnet collections — `based_stacc_0` (Metaplex
          NFT collection) and `proofv3` (Token-22 SPL fungible mint) — pull their per-holder
          allocation out of the staccana treasury in 10 equal monthly tranches starting at
          mainnet-sigma launch. Vesting and claim mechanics live in `docs/MEGADROP.md`.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Allocation</CardTitle>
          <CardDescription>
            Snapshot URL:{" "}
            <a
              className="underline underline-offset-2"
              href={MEGADROP_URL}
              target="_blank"
              rel="noreferrer"
            >
              {MEGADROP_URL}
            </a>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <AllocationReadout
            allocations={allocations}
            connected={connected}
            myAllocation={myAllocation}
            publicKey={publicKey?.toBase58() ?? null}
          />
          <ConfigReadout config={config} currentMonth={currentMonth} />
        </CardContent>
      </Card>

      {myAllocation ? (
        <Card>
          <CardHeader>
            <CardTitle>Vesting tranches</CardTitle>
            <CardDescription>
              Each tranche is `total / 10` ={" "}
              <span className="font-mono">
                {formatSol(trancheAmount(myAllocation.allocationLamports))}
              </span>{" "}
              SOL. Tranche 1 unlocks at the chain's genesis month; tranche 10 unlocks 9 months
              later. Pre-genesis tranches are locked; post-unlock tranches stay claimable
              indefinitely (no expiry).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {tranches.map((t) => (
                <TrancheRow
                  key={t.idx}
                  idx={t.idx}
                  perTranche={t.perTranche}
                  unlockMonth={t.unlockMonth}
                  claimed={t.claimed}
                  unlocked={t.unlocked}
                  selected={selected.has(t.idx)}
                  onToggle={() => toggleSelected(t.idx)}
                />
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                variant="outline"
                onClick={selectAllAvailable}
                disabled={claimableTranches.length === 0}
              >
                Select all unlocked + unclaimed
              </Button>
              <span className="text-sm text-muted-foreground">
                Claim amount preview:{" "}
                <span className="font-mono text-foreground">
                  {formatSol(claimAmountPreview)} SOL
                </span>
              </span>
            </div>

            <Button
              onClick={onClaim}
              disabled={
                selected.size === 0 ||
                submit.kind === "preparing" ||
                submit.kind === "signing" ||
                submit.kind === "submitting" ||
                config.kind !== "ready"
              }
              className="w-full sm:w-auto"
            >
              {submit.kind === "preparing" || submit.kind === "signing" || submit.kind === "submitting" ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {submit.kind === "preparing"
                    ? "Building proof"
                    : submit.kind === "signing"
                      ? "Awaiting signature"
                      : "Submitting"}
                </>
              ) : (
                `Claim ${selected.size} tranche${selected.size === 1 ? "" : "s"}`
              )}
            </Button>

            {submit.kind === "success" ? (
              <p className="text-sm text-emerald-400">
                Submitted.{" "}
                <a
                  className="underline underline-offset-2"
                  href={explorerTxUrl(submit.signature)}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on explorer
                </a>
              </p>
            ) : null}
            {submit.kind === "error" ? (
              <p className="text-sm text-destructive">{submit.message}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local UI primitives
// ---------------------------------------------------------------------------

function AllocationReadout({
  allocations,
  connected,
  myAllocation,
  publicKey,
}: {
  allocations: AllocationsState;
  connected: boolean;
  myAllocation: MegadropAllocation | null;
  publicKey: string | null;
}): JSX.Element {
  if (!connected) {
    return (
      <p className="text-sm text-muted-foreground">
        Connect your wallet to look up your allocation.
      </p>
    );
  }
  if (allocations.kind === "loading") {
    return <p className="text-sm text-muted-foreground">Loading allocations…</p>;
  }
  if (allocations.kind === "error") {
    return <p className="text-sm text-destructive">Allocations error: {allocations.message}</p>;
  }
  if (!myAllocation) {
    return (
      <p className="text-sm text-muted-foreground">
        No allocation for{" "}
        <span className="font-mono">{publicKey ? truncatePubkey(publicKey) : "—"}</span>. The
        snapshot covers based_stacc_0 holders and proofv3 holders; check the snapshot date.
      </p>
    );
  }
  return (
    <dl className="grid grid-cols-2 gap-2 text-sm">
      <dt className="text-muted-foreground">Holder</dt>
      <dd className="font-mono" title={myAllocation.holder.toBase58()}>
        {truncatePubkey(myAllocation.holder.toBase58())}
      </dd>
      <dt className="text-muted-foreground">based_stacc_0 NFTs held</dt>
      <dd className="font-mono">{myAllocation.basedStacc0Count.toString()}</dd>
      <dt className="text-muted-foreground">proofv3 balance</dt>
      <dd className="font-mono">{myAllocation.proofv3Balance.toString()}</dd>
      <dt className="text-muted-foreground">Total allocation</dt>
      <dd className="font-mono">{formatSol(myAllocation.allocationLamports)} SOL</dd>
    </dl>
  );
}

function ConfigReadout({
  config,
  currentMonth,
}: {
  config: ConfigState;
  currentMonth: number;
}): JSX.Element {
  if (config.kind === "loading") {
    return <p className="text-sm text-muted-foreground">Loading MegadropConfig…</p>;
  }
  if (config.kind === "missing") {
    return (
      <p className="text-sm text-amber-400">
        MegadropConfig PDA not found — `init_megadrop` has not run on this cluster.
      </p>
    );
  }
  if (config.kind === "error") {
    return <p className="text-sm text-destructive">Config error: {config.message}</p>;
  }
  if (config.kind === "ready") {
    return (
      <p className="text-xs text-muted-foreground">
        Config: genesis_month={" "}
        <span className="font-mono text-foreground">{config.cfg.genesisMonth}</span> · current
        month{" "}
        <span className="font-mono text-foreground">{currentMonth}</span> · root{" "}
        <span className="font-mono text-foreground" title={toHex(config.cfg.claimableRoot)}>
          {toHex(config.cfg.claimableRoot).slice(0, 16)}…
        </span>
      </p>
    );
  }
  return <p className="text-sm text-muted-foreground">—</p>;
}

function TrancheRow({
  idx,
  perTranche,
  unlockMonth,
  claimed,
  unlocked,
  selected,
  onToggle,
}: {
  idx: number;
  perTranche: bigint;
  unlockMonth: number | null;
  claimed: boolean;
  unlocked: boolean;
  selected: boolean;
  onToggle: () => void;
}): JSX.Element {
  const status = claimed ? "claimed" : unlocked ? "available" : "locked";
  const statusColor =
    status === "claimed"
      ? "text-muted-foreground"
      : status === "available"
        ? "text-emerald-400"
        : "text-amber-400";
  const disabled = claimed || !unlocked;
  return (
    <label
      className={`flex items-center justify-between gap-3 rounded-md border p-3 ${
        disabled ? "border-border/40 bg-secondary/10 opacity-70" : "border-border bg-secondary/30 cursor-pointer hover:bg-secondary/50"
      }`}
    >
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={selected}
          onChange={onToggle}
          disabled={disabled}
        />
        <div>
          <p className="text-sm font-medium">Tranche {idx}</p>
          <p className="text-xs text-muted-foreground">
            Unlocks <span className="font-mono">{unlockMonth ?? "—"}</span>
          </p>
        </div>
      </div>
      <div className="text-right">
        <p className="font-mono text-xs">{formatSol(perTranche)} SOL</p>
        <p className={`text-xs ${statusColor}`}>{status}</p>
      </div>
    </label>
  );
}

