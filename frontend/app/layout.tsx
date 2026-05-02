import type { Metadata } from "next";
import { Inter } from "next/font/google";

import { ClusterBanner } from "@/components/cluster-banner";
import { SiteHeader } from "@/components/site-header";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/use-toast";
import { WalletContextProviders } from "@/lib/wallet";

import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "staccana",
  description:
    "Staccana — confidential transfers live at genesis, MEV structurally impossible. Claim your mainnet SOL on staccana.",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <html lang="en" className={`dark ${inter.variable}`}>
      <body className="min-h-screen bg-background font-sans">
        <ThemeProvider>
          <WalletContextProviders>
            <ClusterBanner />
            <SiteHeader />
            <main className="container py-10">{children}</main>
            <Toaster />
          </WalletContextProviders>
        </ThemeProvider>
      </body>
    </html>
  );
}
