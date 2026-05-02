import { type VercelConfig } from "@vercel/config/v1";

// Staccana frontend Vercel config.
//
// We use vercel.ts (not vercel.json) per the Vercel skill convention, so the
// config is a typed module. The build pipeline picks this up automatically.
//
// Domain: app.mp.fun (provisioned via Cloudflare API integration; see
// infra/cloudflare/ in the staccana monorepo).
export const config: VercelConfig = {
  framework: "nextjs",
  buildCommand: "next build",
  installCommand: "npm install",
  outputDirectory: ".next",
};
