import type { Metadata } from "next";
import { Inter } from "next/font/google";

import { ClusterBanner } from "@/components/cluster-banner";
import { SiteHeader } from "@/components/site-header";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/use-toast";
import { WalletContextProviders } from "@/lib/wallet";

import "./globals.css";
import { ConnectionProvider } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "staccana",
  description:
    "Staccana — confidential transfers live at genesis, MEV structurally impossible. Claim your mainnet SOL on staccana.",
  icons: {
    icon: "/favicon.svg",
  },
};

// Top-level layout: do NOT directly use wallet-adapter providers here.
// Use our WalletContextProviders wrapper ("use client") for React tree composition safety.
export default function RootLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <html lang="en" className={`dark ${inter.variable}`}>
      <body className="min-h-screen bg-background font-sans">

      <ClusterBanner />
      <ThemeProvider>
        {/* WalletContextProviders wraps wallet-adapter providers and must be rendered on the client */}
        <WalletContextProviders>
          <SiteHeader />
          {children}
        </WalletContextProviders>
      </ThemeProvider>
      <Toaster />
      </body>
    </html>
  );
}
