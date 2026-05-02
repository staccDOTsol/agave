# Staccana

A Solana fork — secrecy on at genesis, atomic-MEV structurally impossible, treasury-funded ops, federated multi-asset bridge with a non-1:1 accruing peg.

Continuation of [solana-classic v1](docs/LINEAGE.md). Same repo, same docker image, sharper architecture.

**v1 mainnet codename: `mainnet-sigma`. Target: 2026-05-16.**

## What this is

Staccana is a sovereign Solana chain. Genesis is built from a snapshot of mainnet at slot `S`. Five things define it:

1. **Confidential transfer feature gates active at slot 0.** ZK ElGamal Proof program ships activated as a builtin (already a path-dep in classic v1's Cargo.toml). Token-22 mints can opt into the Confidential Transfer extension immediately, while mainnet's gates remain inactive on every public network (see `docs/ARCHITECTURE.md`).
2. **Per-mint frequent batch auction at the validator layer.** Within a slot, swap intents are grouped by their longtail (non-quote) mint, matched against each other in size order, and cleared at a single AMM-anchored price. Sandwich and Jito-bundle MEV are structurally impossible.
3. **No bundle protocol.** The validator binary doesn't compile in or honor Jito-style bundle messages.
4. **Strict genesis partition rule.** Only system-program-owned, zero-data accounts (raw SOL on plain wallets) are claimable via lazy-claim. Everything else — every PDA, every token account, every stake account, every program-owned anything — is zero'd at genesis and the lamports credited to the staccana treasury. **One rule, no allowlists, no per-protocol judgment calls.**
5. **Treasury funds the project, not inflation.** Inflation is disabled (inherited from classic v1). The genesis treasury — sized in the hundreds of millions of SOL given mainnet's stake distribution — funds ops, secret-pump bonding-curve seed liquidity, secret-ray initial pools, validator subsidies, and an insurance fund for the bridge.

## What this is not

- A privacy-by-default chain. Secrecy is opt-in per Token-22 extension semantics; the chain is transparent.
- An L2 / rollup. Staccana is its own L1 with its own consensus, validators, and genesis.
- A 1:1 mainnet replica. Only raw-SOL EOAs survive; protocols don't carry over.
- An inflationary chain. Validator rewards = fees only.

## Repo layout

```
.
├── matcher/                 # FBA library — the core consensus rule
├── genesis/                 # Snapshot ingest, partition, treasury, Merkle root, classic defaults
├── programs/                # Solana programs (lazy-claim, bridge, secret-*)        [planned]
├── tools/                   # CLIs and operator tooling
├── infra/                   # Ansible playbooks + bootstrap scripts + systemd units + Cloudflare LB
├── frontend/                # Next.js 14 + Vercel app (claim/bridge/pump UIs); deploys to app.mp.fun
├── agave/                   # Forked validator (git submodule of classic v2 branch)  [planned]
└── docs/
    ├── ARCHITECTURE.md      # Design overview
    ├── BRIDGE.md            # Multi-asset bridge with non-1:1 accruing peg
    ├── E2E_DEPLOY.md        # Local validator → multi-validator devnet → mainnet-sigma deploy pipeline
    ├── INFRA.md             # Cherryservers + Hetzner + Vercel infra plan (~$1.7k/mo)
    ├── LINEAGE.md           # Classic v1 → staccana v2 narrative
    ├── ROADMAP.md           # Phased ship plan
    ├── SECRET_RAY.md        # v1.1 forked-Raydium integration contract
    └── SPEC.md              # Normative wire formats, invariants, constants
```

## Status

Pre-alpha scaffold. The matcher and genesis crates are the only compilable code; everything else is design docs and future crate stubs.

```bash
cargo test -p staccana-matcher
cargo test -p staccana-genesis
```

## Why

Solana's worst extractive surface is atomic sandwich MEV via Jito bundles. The cleanest fix is to remove the leader's ordering control entirely, batch-match within each slot, and clear at a uniform price. Solana mainnet won't adopt this — too much rent depends on it. So: fork from a snapshot, ship the fix, capture the slow-burn audience that wants Solana without the extractive layer.

Confidential transfers ride along because the ZK ElGamal Proof program's activation gate is **inactive on mainnet, devnet, and testnet** as of this writing — flipping it at staccana's genesis is days of work and gives us multi-year headroom on the secrecy axis alone.

Lineage: this is `solana-classic` v2. Classic v1 (May 2025) tried to deter MEV via a fixed-fee model — clever but blunt. Staccana v2 does it structurally. See `docs/LINEAGE.md`.

## License

Apache-2.0.
