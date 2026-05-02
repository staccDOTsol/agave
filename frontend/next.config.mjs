/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // The Solana wallet-adapter UI ships its own CSS bundle that we import in app/layout.tsx.
    // No special transpilation needed.
  },
  webpack: (config) => {
    // Polyfill / disable Node-only modules pulled by some wallet adapters in browser bundles.
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      path: false,
      crypto: false,
    };
    // pino-pretty is an optional pino dep used by walletconnect's logger only in
    // dev/server contexts. Mark as external so webpack does not warn on missing.
    config.externals = [...(config.externals ?? []), "pino-pretty"];
    return config;
  },
};

export default nextConfig;
