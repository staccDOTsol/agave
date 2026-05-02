#!/usr/bin/env bash
# 25-build-programs.sh — build all five staccana programs into .so artifacts.
#
# Runs BEFORE 30-init-validator.sh, which depends on the .so files existing in
# $STACCANA_DIR/target/deploy/ to bake them as builtins into the genesis.
#
# Programs:
#   - staccana-lazy-claim       (native solana-program; cargo build-sbf)
#   - staccana-bridge           (Anchor 1.x; anchor build)
#   - staccana-secret-pump      (Anchor 1.x; anchor build)
#   - staccana-validator-subsidy (Anchor 1.x; anchor build)
#   - staccana-megadrop         (Anchor 1.x; anchor build)
#
# Anchor build outputs land under each program's local target/deploy/. We
# consolidate everything into $STACCANA_DIR/target/deploy/ so step 30's
# genesis-bake can find them at one path.

set -euo pipefail

STACCANA_DIR="${STACCANA_DIR:-/opt/staccana}"
DEPLOY_DIR="${DEPLOY_DIR:-$STACCANA_DIR/target/deploy}"

mkdir -p "$DEPLOY_DIR"

echo "[build] === lazy-claim (native cargo build-sbf) ==="
(cd "$STACCANA_DIR" && cargo build-sbf --manifest-path "programs/lazy-claim/Cargo.toml" --sbf-out-dir "$DEPLOY_DIR")

# Anchor programs. Each `anchor build` writes to programs/<name>/target/deploy/.
# Copy the resulting .so into the consolidated $DEPLOY_DIR.
for prog in bridge secret-pump validator-subsidy megadrop; do
  echo "[build] === $prog (anchor build) ==="
  (cd "$STACCANA_DIR/programs/$prog" && anchor build)
  # Anchor preserves the snake_case from Cargo.toml's package name
  underscored="staccana_${prog//-/_}"
  src="$STACCANA_DIR/programs/$prog/target/deploy/${underscored}.so"
  if [[ -f "$src" ]]; then
    cp -f "$src" "$DEPLOY_DIR/${underscored}.so"
    echo "[build]   → $DEPLOY_DIR/${underscored}.so"
  else
    echo "[build] WARN: $src not found after anchor build for $prog" >&2
  fi
done

echo "[build] consolidated artifacts in $DEPLOY_DIR:"
ls -lh "$DEPLOY_DIR"/staccana_*.so 2>/dev/null || echo "[build]   (none — something failed above)"

echo "[build] done. next: ./30-init-validator.sh"
