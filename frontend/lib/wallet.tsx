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
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import { useMemo, type ReactNode } from "react";

import { RPC_URL } from "./staccana";

interface WalletContextProvidersProps {
  children: ReactNode;
}

/**
 * Top-level wallet provider stack. Drop this around the app tree (in
 * app/layout.tsx) and any descendant component can use the wallet-adapter
 * hooks (`useWallet`, `useConnection`, etc.).
 */
export function WalletContextProviders({ children }: WalletContextProvidersProps): JSX.Element {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );

  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
