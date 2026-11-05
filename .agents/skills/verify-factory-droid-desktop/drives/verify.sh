#!/bin/sh
# The exact, reproducible skill invocation: tool setup, doctor checks, and
# the skill's own signed-out journey drive, all through the env -i boundary.
# Works on a real desktop or wraps itself in Xvfb when no DISPLAY exists.
#
# Usage: .agents/skills/verify-factory-droid-desktop/drives/verify.sh [bundleDir] [outDir]
#   bundleDir defaults to dist/factory-droid-desktop-<versions.json desktop>
#   outDir    defaults to build/skill-journey
set -eu
DRIVES="$(cd "$(dirname "$0")" && pwd)"
REPO=$(git -C "$DRIVES/../../.." rev-parse --show-toplevel 2>/dev/null || echo "$DRIVES/../../../..")
cd "$REPO"
BUNDLE="${1:-dist/factory-droid-desktop-$(node -p 'require("./versions.json").desktop')}"
OUT="${2:-build/skill-journey}"

# Tool setup outside the repo; idempotent.
SETUP_EXPORTS=$(mktemp)
"$DRIVES/setup-env.sh" > "$SETUP_EXPORTS"
# shellcheck disable=SC1090
eval "$(grep '^export' "$SETUP_EXPORTS")"
rm -f "$SETUP_EXPORTS"

# Xvfb prefix when headless (the wrapper needs a display either way).
if [ -n "${DISPLAY:-}" ]; then PREFIX=""; else PREFIX="xvfb-run -a"; fi

# Doctor: read-only checks, no instance started, nothing killed.
test -f "$BUNDLE/factory-desktop" || { echo "doctor: no bundle at $BUNDLE (run npm run build)" >&2; exit 1; }
$PREFIX "$DRIVES/isolated-node.sh" "$FACTORY_VERIFY_WORK" "$BUNDLE/resources/bin/droid" --version

# The skill's own drive, then the safe recorded-PID cleanup.
$PREFIX "$DRIVES/isolated-node.sh" "$FACTORY_VERIFY_WORK" node \
  "$DRIVES/signed-out-journey.mjs" "$BUNDLE" "$OUT"
"$DRIVES/cleanup-run.sh" "$OUT"
