"use client";

/**
 * Bridge page.
 *
 * Two flows against the staccana bridge program (SPEC §5):
 *
 * - **Withdraw** (fully on staccana): user picks an asset (stSOL or ssUSDC),
 *   enters an amount of bridge tokens to burn, and receives a Solana
 *   transaction that calls the staccana bridge `burn` ix. The user then
 *   separately presents the federation attestation to the per-asset mainnet
 *   vault to claim their underlying — that mainnet leg is not implemented in
 *   this UI. Toast on success with the explorer link.
 *
 * - **Deposit** (cross-chain — preview only): user enters an amount of the
 *   underlying asset on mainnet to bridge in. The page builds the canonical
 *   `Deposit` ix payload bytes (mainnet vault wire format from
 *   `tools/bridge-cli/src/deposit.rs`) and copies them as a base58 string the
 *   user can paste into a mainnet-side tool. We don't yet open a mainnet
 *   wallet from this page.
 *
 * Live ratio R is read from the on-chain `RatioState` PDA per asset.
 */

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/use-toast";
import {
  BRIDGE_ASSETS,
  BridgeAsset,
  applyBpsFee,
  assetConfigPda,
  bridgeAssetById,
  buildBurnInstruction,
  decodeRatioState,
  encodeMainnetDepositArgs,
  mintAmountForValue,
  ONE_Q64,
  q64ToFloat,
  ratioStatePda,
  releaseAmountForBurn,
  type RatioState,
} from "@/lib/bridge";
import { explorerTxUrl } from "@/lib/staccana";
import { truncatePubkey } from "@/lib/utils";

type RatioFetchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; ratio: RatioState }
  | { kind: "missing" }
  | { kind: "error"; message: string };

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; signature: string }
  | { kind: "error"; message: string };

type Tab = "withdraw" | "deposit";

/**
 * Default fee bps used for previewing burn/mint amounts. Real value is read
 * from `AssetConfig` on-chain; until we wire the AssetConfig reader (a v1.1
 * polish item) we use the spec default of 10 bps from SPEC §2.3.
 */
const DEFAULT_FEE_BPS = 10;

export default function BridgePage(): JSX.Element {
  const { publicKey, sendTransaction, connected } = useWallet();
  const { connection } = useConnection();
  const { toast } = useToast();

  const [tab, setTab] = useState<Tab>("withdraw");
  const [asset, setAsset] = useState<BridgeAsset>(BridgeAsset.StSol);
  const [amountStr, setAmountStr] = useState("");
  const [mainnetDestStr, setMainnetDestStr] = useState("");
  const [staccanaDestStr, setStaccanaDestStr] = useState("");
  const [ratio, setRatio] = useState<RatioFetchState>({ kind: "idle" });
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });
  const [staccanaMintStr, setStaccanaMintStr] = useState("");
  const [userAtaStr, setUserAtaStr] = useState("");

  const meta = useMemo(() => bridgeAssetById(asset), [asset]);

  // Re-fetch the ratio whenever the connected user picks a new asset.
  useEffect(() => {
    let cancelled = false;
    setRatio({ kind: "loading" });
    const pda = ratioStatePda(asset);
    connection
      .getAccountInfo(pda, "confirmed")
      .then((acct) => {
        if (cancelled) return;
        if (!acct) {
          setRatio({ kind: "missing" });
          return;
        }
        try {
          const decoded = decodeRatioState(new Uint8Array(acct.data));
          setRatio({ kind: "ready", ratio: decoded });
        } catch (err) {
          setRatio({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRatio({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [asset, connection]);

  // Prefill staccana destination with the connected wallet, since most users
  // bridge to themselves.
  useEffect(() => {
    if (publicKey && !staccanaDestStr) {
      setStaccanaDestStr(publicKey.toBase58());
    }
  }, [publicKey, staccanaDestStr]);

  const baseAmount = useMemo<bigint | null>(() => {
    return parseToBaseUnits(amountStr, meta.decimals);
  }, [amountStr, meta.decimals]);

  const previewLine = useMemo(() => {
    if (ratio.kind !== "ready") return "—";
    if (!baseAmount || baseAmount <= 0n) return "—";
    if (tab === "deposit") {
      // Mainnet vault deducts mint_fee_bps first; for v1 we approximate that as
      // staccana-side mint_fee_bps (governance can rotate it independently —
      // until we read it on-chain, the SPEC §2.3 default is the safer bet).
      const valueAfterFee = applyBpsFee(baseAmount, DEFAULT_FEE_BPS);
      const minted = mintAmountForValue(valueAfterFee, ratio.ratio.rQ64);
      return `≈ ${formatBaseUnits(minted, meta.decimals)} ${meta.label} minted on staccana`;
    }
    // withdraw / burn
    const grossUnderlying = releaseAmountForBurn(baseAmount, ratio.ratio.rQ64);
    const netUnderlying = applyBpsFee(grossUnderlying, DEFAULT_FEE_BPS);
    return `≈ ${formatBaseUnits(netUnderlying, meta.decimals)} ${meta.underlying} released on mainnet`;
  }, [baseAmount, meta.decimals, meta.label, meta.underlying, ratio, tab]);

  // ---- Withdraw / burn flow ----
  const onBurn = useCallback(async () => {
    setSubmit({ kind: "idle" });
    if (!publicKey || !connected) {
      setSubmit({ kind: "error", message: "Wallet not connected" });
      return;
    }
    if (!baseAmount || baseAmount <= 0n) {
      setSubmit({ kind: "error", message: "Enter a positive amount" });
      return;
    }
    if (!mainnetDestStr) {
      setSubmit({ kind: "error", message: "Enter a mainnet destination pubkey" });
      return;
    }
    if (!staccanaMintStr) {
      setSubmit({
        kind: "error",
        message: "Enter the staccana mint pubkey for this asset (read from AssetConfig)",
      });
      return;
    }
    if (!userAtaStr) {
      setSubmit({ kind: "error", message: "Enter your token-account address for the asset" });
      return;
    }
    let mainnetDest: PublicKey;
    let staccanaMint: PublicKey;
    let userAta: PublicKey;
    try {
      mainnetDest = new PublicKey(mainnetDestStr.trim());
      staccanaMint = new PublicKey(staccanaMintStr.trim());
      userAta = new PublicKey(userAtaStr.trim());
    } catch (err) {
      setSubmit({
        kind: "error",
        message: `Invalid pubkey: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    try {
      const ix = buildBurnInstruction({
        asset,
        amount: baseAmount,
        mainnetDest,
        user: publicKey,
        staccanaMint,
        userAta,
      });
      const tx = new Transaction();
      tx.add(ix);
      tx.feePayer = publicKey;
      const blockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      tx.recentBlockhash = blockhash;

      setSubmit({ kind: "submitting" });
      const sig = await sendTransaction(tx, connection);
      setSubmit({ kind: "success", signature: sig });
      toast({
        variant: "success",
        title: `Burned ${meta.label}`,
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSubmit({ kind: "error", message });
      toast({ variant: "destructive", title: "Burn failed", description: message });
    }
  }, [
    asset,
    baseAmount,
    connection,
    connected,
    mainnetDestStr,
    meta.label,
    publicKey,
    sendTransaction,
    staccanaMintStr,
    toast,
    userAtaStr,
  ]);

  // ---- Deposit / mainnet payload preview ----
  const depositPayloadBs58 = useMemo(() => {
    if (!baseAmount || baseAmount <= 0n) return null;
    if (!staccanaDestStr) return null;
    let dest: PublicKey;
    try {
      dest = new PublicKey(staccanaDestStr.trim());
    } catch {
      return null;
    }
    const data = encodeMainnetDepositArgs(asset, baseAmount, dest);
    return bs58.encode(data);
  }, [asset, baseAmount, staccanaDestStr]);

  const onCopyDepositPayload = useCallback(() => {
    if (!depositPayloadBs58) return;
    navigator.clipboard.writeText(depositPayloadBs58).then(
      () => toast({ variant: "success", title: "Deposit payload copied" }),
      () =>
        toast({
          variant: "destructive",
          title: "Clipboard write failed",
          description: "Manually select and copy the bytes below.",
        }),
    );
  }, [depositPayloadBs58, toast]);

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">bridge</p>
        <h1 className="text-3xl font-semibold tracking-tight">Bridge SOL or USDC into staccana</h1>
        <p className="max-w-2xl text-muted-foreground">
          Deposit SOL on mainnet to mint stSOL on staccana (pSYRUP-backed, ratio R drifts upward
          over time). Burn stSOL or ssUSDC to redeem the underlying back on mainnet via the
          5-of-9 federation. Both bridge mints are Token-22 with the Confidential Transfer
          extension active by default.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Asset</CardTitle>
          <CardDescription>
            Select the bridge asset. Ratio R is read from the on-chain RatioState PDA.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {BRIDGE_ASSETS.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setAsset(a.id)}
                className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                  a.id === asset
                    ? "border-primary bg-primary/20 text-foreground"
                    : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary/70"
                }`}
              >
                {a.label}
                <span className="ml-2 text-xs text-muted-foreground">{a.underlying}</span>
              </button>
            ))}
          </div>
          <RatioReadout ratio={ratio} />
          <p className="text-xs text-muted-foreground">
            RatioState PDA:{" "}
            <span className="font-mono" title={ratioStatePda(asset).toBase58()}>
              {truncatePubkey(ratioStatePda(asset).toBase58())}
            </span>
            {" · "}
            AssetConfig PDA:{" "}
            <span className="font-mono" title={assetConfigPda(asset).toBase58()}>
              {truncatePubkey(assetConfigPda(asset).toBase58())}
            </span>
          </p>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <TabButton selected={tab === "withdraw"} onClick={() => setTab("withdraw")}>
          Withdraw
        </TabButton>
        <TabButton selected={tab === "deposit"} onClick={() => setTab("deposit")}>
          Deposit
        </TabButton>
      </div>

      {tab === "withdraw" ? (
        <Card>
          <CardHeader>
            <CardTitle>Burn {meta.label} → release on mainnet</CardTitle>
            <CardDescription>
              Submits the staccana bridge `burn` ix per SPEC §5.5. After submission, the
              federation observes the emitted `Burn` event and produces a release attestation
              for the per-asset mainnet vault to consume — that mainnet leg is a separate step.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field
              label={`Amount (${meta.label}, decimals=${meta.decimals})`}
              value={amountStr}
              onChange={setAmountStr}
              placeholder={meta.decimals === 6 ? "100" : "1.5"}
            />
            <Field
              label="Mainnet destination pubkey"
              value={mainnetDestStr}
              onChange={setMainnetDestStr}
              placeholder="recipient on mainnet"
              mono
            />
            <Field
              label={`Staccana ${meta.label} mint`}
              value={staccanaMintStr}
              onChange={setStaccanaMintStr}
              placeholder="from AssetConfig.staccana_mint"
              mono
              help={
                <span>
                  TODO(prod): read this from <span className="font-mono">AssetConfig</span>{" "}
                  on-chain so the user does not have to paste it. For v1 you must supply the
                  mint address yourself.
                </span>
              }
            />
            <Field
              label="Your token account holding the mint balance"
              value={userAtaStr}
              onChange={setUserAtaStr}
              placeholder="ATA for this mint"
              mono
            />
            <p className="text-sm text-muted-foreground">{previewLine}</p>
            <Button onClick={onBurn} disabled={submit.kind === "submitting"} className="w-full sm:w-auto">
              {submit.kind === "submitting" ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Submitting
                </>
              ) : (
                "Submit burn"
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
                </a>{" "}
                — now wait for the federation attestation, then claim on the mainnet vault.
              </p>
            ) : null}
            {submit.kind === "error" ? (
              <p className="text-sm text-destructive">{submit.message}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Deposit on mainnet → mint on staccana</CardTitle>
            <CardDescription>
              For v1 we generate the mainnet vault `Deposit` ix payload bytes here and you
              paste them into a mainnet-side wallet/tool. After the federation publishes the
              attestation, anyone can submit the staccana-side `mint` ix to credit your ATA.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field
              label={`Underlying amount to deposit (decimals=${meta.decimals})`}
              value={amountStr}
              onChange={setAmountStr}
              placeholder={meta.decimals === 6 ? "100" : "1.5"}
            />
            <Field
              label="Staccana destination (your wallet)"
              value={staccanaDestStr}
              onChange={setStaccanaDestStr}
              placeholder="staccana pubkey to credit"
              mono
            />
            <p className="text-sm text-muted-foreground">{previewLine}</p>
            {depositPayloadBs58 ? (
              <div className="space-y-2 rounded-md border bg-secondary/20 p-3">
                <p className="text-xs font-medium text-muted-foreground">
                  Deposit ix payload (45 bytes, base58 — paste into your mainnet vault tool):
                </p>
                <p className="break-all font-mono text-xs">{depositPayloadBs58}</p>
                <Button size="sm" variant="outline" onClick={onCopyDepositPayload}>
                  Copy payload
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Enter an amount and a destination to generate the payload.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              TODO(prod): wire a mainnet wallet adapter to submit this directly. For v1 the
              user runs the deposit step manually on mainnet.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local UI primitives
// ---------------------------------------------------------------------------

function TabButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
        selected
          ? "border-primary bg-primary/20 text-foreground"
          : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary/70"
      }`}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
  help,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  help?: React.ReactNode;
}): JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring ${
          mono ? "font-mono" : ""
        }`}
      />
      {help ? <span className="block text-xs text-muted-foreground">{help}</span> : null}
    </label>
  );
}

function RatioReadout({ ratio }: { ratio: RatioFetchState }): JSX.Element {
  if (ratio.kind === "loading") {
    return <p className="text-sm text-muted-foreground">Loading R…</p>;
  }
  if (ratio.kind === "missing") {
    return (
      <p className="text-sm text-amber-400">
        RatioState PDA not found — `register_asset` has not run for this asset on this cluster.
      </p>
    );
  }
  if (ratio.kind === "error") {
    return <p className="text-sm text-destructive">RatioState read error: {ratio.message}</p>;
  }
  if (ratio.kind === "ready") {
    const isOne = ratio.ratio.rQ64 === ONE_Q64;
    return (
      <div className="text-sm text-muted-foreground">
        R = <span className="font-mono text-foreground">{q64ToFloat(ratio.ratio.rQ64).toFixed(8)}</span>
        {isOne ? " (1.0 — initial)" : null}
        {" · last_published_slot="}
        <span className="font-mono text-foreground">{ratio.ratio.lastPublishedSlot.toString()}</span>
      </div>
    );
  }
  return <p className="text-sm text-muted-foreground">—</p>;
}

// ---------------------------------------------------------------------------
// Decimal helpers (local — match `tools/bridge-cli/src/asset.rs::parse_amount`)
// ---------------------------------------------------------------------------

function parseToBaseUnits(input: string, decimals: number): bigint | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.startsWith("-")) return null;
  let intPart: string;
  let fracPart: string;
  const dot = trimmed.indexOf(".");
  if (dot < 0) {
    intPart = trimmed;
    fracPart = "";
  } else {
    intPart = trimmed.slice(0, dot);
    fracPart = trimmed.slice(dot + 1);
  }
  if (intPart.length === 0 && fracPart.length === 0) return null;
  if (intPart && !/^\d+$/.test(intPart)) return null;
  if (fracPart && !/^\d+$/.test(fracPart)) return null;
  let intValue = 0n;
  if (intPart) {
    try {
      intValue = BigInt(intPart);
    } catch {
      return null;
    }
  }
  const scale = 10n ** BigInt(decimals);
  // Truncate or zero-pad fracPart to `decimals` digits.
  let fracPadded = fracPart;
  if (fracPadded.length < decimals) {
    fracPadded = fracPadded.padEnd(decimals, "0");
  } else {
    fracPadded = fracPadded.slice(0, decimals);
  }
  let fracValue = 0n;
  if (fracPadded) {
    try {
      fracValue = BigInt(fracPadded);
    } catch {
      return null;
    }
  }
  const total = intValue * scale + fracValue;
  // Constrain to u64.
  if (total < 0n || total > (1n << 64n) - 1n) return null;
  return total;
}

function formatBaseUnits(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const scale = 10n ** BigInt(decimals);
  const intPart = value / scale;
  const fracPart = value % scale;
  if (fracPart === 0n) return intPart.toString();
  let fracStr = fracPart.toString().padStart(decimals, "0");
  while (fracStr.endsWith("0")) fracStr = fracStr.slice(0, -1);
  return `${intPart.toString()}.${fracStr}`;
}
