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
# Idempotent: re-running on an already-patched file reports "already patched".
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PATCH="$HERE/patches/feishu-tool-aggregation-wayE.patch"
EXPECTED_ORIG="9bbbd0c3baa9227ebeb6f719a317f990357236db46e2fd46b9eda5e81d2bd2d9"
EXPECTED_PATCHED="8cbe577b511a5ea980169ceb205492c2bdff9afdfd8337026b5ade70cc1d4644"

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

if [ "$CUR" = "$EXPECTED_PATCHED" ]; then
  echo "already patched ($TARGET)"
  exit 0
fi

if [ "$CUR" != "$EXPECTED_ORIG" ]; then
  echo "error: $TARGET does not match the expected pristine bundle." >&2
  echo "  expected: $EXPECTED_ORIG" >&2
  echo "  actual:   $CUR" >&2
  echo "This patch targets a specific plugin build; re-derive it for a new build." >&2
  exit 1
fi

BAK="$(dirname "$TARGET")/.monitor.backup-$(date -u +%Y%m%dT%H%M%SZ).mjs"
cp -p "$TARGET" "$BAK"
echo "backup: $BAK"

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
