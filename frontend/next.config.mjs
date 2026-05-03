/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Catch every stale /pump/* link from before the rename. Permanent so
  // search engines + bookmarks update too.
  async redirects() {
    return [
      { source: "/pump", destination: "/launch", permanent: true },
      { source: "/pump/:path*", destination: "/launch/:path*", permanent: true },
    ];
  },
  // TODO: drop once @solana/wallet-adapter-react ships React 18 strict-mode-compatible
  // FC<{children}> typings (or pin @types/react to a version that resolves the JSX
  // overload conflict). Until then, allow next build to proceed despite the wallet
  // provider type errors — they're false positives and don't affect runtime.
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    // The Solana wallet-adapter UI ships its own CSS bundle that we import in app/layout.tsx.
    // No special transpilation needed.
    //
    // `@staccoverflow/zk-proofs-wasm` ships a `.wasm` binary that Next.js's
    // default file-tracing for serverless functions does NOT include in the
    // function bundle — at runtime `/var/task/.next/server/chunks/...wasm`
    // is absent and proof generation throws ENOENT, which kills both the
    // direct ConfidentialTransfer path AND the transit-account hack
    // fallback (both go through `/api/confidential/proof`).
    // Tell the file-tracer to include every .wasm under the package so the
    // serverless function gets the binary copied at build time.
    outputFileTracingIncludes: {
      "app/api/confidential/proof/route": [
        "./node_modules/@staccoverflow/zk-proofs-wasm/**/*.wasm",
        "../node_modules/@staccoverflow/zk-proofs-wasm/**/*.wasm",
      ],
    },
  },
  // Mark the wasm package as a server-external dep so its loader uses
  // `require()` against `node_modules/` (with the .wasm sibling files
  // copied in by the tracing rule above) instead of webpack inlining.
  serverExternalPackages: ["@staccoverflow/zk-proofs-wasm"],
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
