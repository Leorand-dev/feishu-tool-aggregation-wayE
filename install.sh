#!/usr/bin/env bash
# Apply the Feishu tool-summary aggregation fix (wayE) to an installed
# @openclaw/feishu monitor bundle.
#
# Usage:
#   ./install.sh <path-to-installed-monitor.account-*.mjs>
#
# The target is the plugin's compiled bundle, typically found under:
#   <openclaw-home>/npm/projects/*/node_modules/@openclaw/feishu/dist/.setup/monitor.account-*.mjs
#
# The installer detects the target's build by hash, selects the matching
# per-version patch, and applies it. Idempotent: re-running on an
# already-patched file reports "already patched".
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

# version -> "pristine_sha patched_sha patch_path"
VERSIONS=(
  "2026.10.1 9bbbd0c3baa9227ebeb6f719a317f990357236db46e2fd46b9eda5e81d2bd2d9 8cbe577b511a5ea980169ceb205492c2bdff9afdfd8337026b5ade70cc1d4644 $HERE/patches/2026.10.1/feishu-tool-aggregation-wayE.patch"
  "2026.10.2 8ae0e845a1960f2aa7741b026e91bcaca2e9966478c1e43fa04faa9e9ebd5eac 97ca5ce404d940dc83b08a4fddf3c0dc16d52e4483a232fd97890ad5ad30d867 $HERE/patches/2026.10.2/feishu-tool-aggregation-wayE.patch"
)

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "usage: $0 <path-to-monitor.account-*.mjs>" >&2
  exit 2
fi
if [ ! -f "$TARGET" ]; then
  echo "error: not a file: $TARGET" >&2
  exit 2
fi

sum() { sha256sum "$1" | cut -d' ' -f1; }
CUR="$(sum "$TARGET")"

# already patched for any known version?
for v in "${VERSIONS[@]}"; do
  read -r ver porch pat patch <<<"$v"
  if [ "$CUR" = "$pat" ]; then
    echo "already patched (plugin build $ver; $TARGET)"
    exit 0
  fi
done

# find matching pristine build
MATCH=""
for v in "${VERSIONS[@]}"; do
  read -r ver porch pat patch <<<"$v"
  if [ "$CUR" = "$porch" ]; then
    MATCH="$ver $pat $patch"
    break
  fi
done

if [ -z "$MATCH" ]; then
  echo "error: $TARGET does not match any known pristine plugin build." >&2
  echo "  actual sha256: $CUR" >&2
  echo "Known pristine builds:" >&2
  for v in "${VERSIONS[@]}"; do read -r ver porch pat patch <<<"$v"; echo "  $ver  $porch" >&2; done
  echo "This patch targets specific builds; re-derive it for a new release." >&2
  exit 1
fi

read -r VER EXPECTED_PATCHED PATCH <<<"$MATCH"
BAK="$(dirname "$TARGET")/.monitor.backup-$(date -u +%Y%m%dT%H%M%SZ).mjs"
cp -p "$TARGET" "$BAK"
echo "backup: $BAK"
echo "applying patch for plugin build $VER"

patch -p0 "$TARGET" < "$PATCH"

NEW="$(sum "$TARGET")"
if [ "$NEW" != "$EXPECTED_PATCHED" ]; then
  echo "error: post-patch hash mismatch; restoring backup." >&2
  cp -p "$BAK" "$TARGET"
  exit 1
fi

echo "patched OK: $TARGET"
echo "sha256: $NEW"
echo "Restart the gateway for the change to take effect."
