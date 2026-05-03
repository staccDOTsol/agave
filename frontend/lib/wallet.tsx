"use client";

/**
 * Solana wallet-adapter wiring.
 *
 * Wraps the standard wallet-adapter-react setup with our staccana RPC endpoint.
 *
 * Wallet selection: we register Phantom and Solflare via the legacy
 * adapter-classes pattern (still useful so the WalletModal lists them even
 * if the user has not opened those extensions yet). Backpack and any other
 * Wallet Standard-compatible wallet is auto-detected by wallet-adapter-react
 * via `window.navigator.wallets` and shown in the modal automatically — no
 * explicit adapter needed (Backpack dropped its dedicated adapter package
 * in favor of the Standard).
 *
 * The user adds the staccana custom RPC inside their wallet (see
 * docs/WALLET_INTEGRATION.md). The Connection here lets the page itself talk
 * to the chain (e.g. for getLatestBlockhash before we hand the tx to the
 * wallet for signing).
 */

import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { useMemo, type ReactNode } from "react";

import { RPC_URL } from "./staccana";

interface WalletContextProvidersProps {
  children: ReactNode;
}

/**
 * Top-level wallet provider stack. Drop this around the app tree (in
 * app/layout.tsx) and any descendant component can use the wallet-adapter
 * hooks (`useWallet`, `useConnection`, etc.).
 *
 * Wallet adapter list: only adapters for wallets that DON'T self-register via
 * the Wallet Standard. Phantom (and Backpack, Glow, etc.) ship with their own
 * Standard registration in the injected provider — including
 * `PhantomWalletAdapter` here causes a "Phantom was registered as a Standard
 * Wallet. The Wallet Adapter for Phantom can be removed from your app." dev
 * warning AND a duplicate entry in the modal. Solflare doesn't auto-register
 * yet, so we keep its adapter explicit.
 */
export function WalletContextProviders({ children }: WalletContextProvidersProps): JSX.Element {
  const wallets = useMemo(() => [new SolflareWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
