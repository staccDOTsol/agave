import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn-ui's standard cn helper — merge class names with Tailwind awareness. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Truncate a base58 pubkey to `xxx...yyy` for display. */
export function truncatePubkey(pubkey: string, head = 4, tail = 4): string {
  if (pubkey.length <= head + tail + 3) return pubkey;
  return `${pubkey.slice(0, head)}...${pubkey.slice(-tail)}`;
}

/** Format a lamports bigint as a human SOL string with N decimals. */
export function formatSol(lamports: bigint, decimals = 4): string {
  const LAMPORTS_PER_SOL = 1_000_000_000n;
  const whole = lamports / LAMPORTS_PER_SOL;
  const frac = lamports % LAMPORTS_PER_SOL;
  if (decimals === 0) return whole.toString();
  const fracStr = frac.toString().padStart(9, "0").slice(0, decimals);
  return `${whole.toString()}.${fracStr}`;
}
