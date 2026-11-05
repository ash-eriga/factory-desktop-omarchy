#!/bin/sh
# Reproducible verification tool setup for verify-factory-droid-desktop.
# Idempotent; installs everything OUTSIDE the repo so the source inventory
# never sees it. Prints the exports every drive needs.
#
# Usage: . .agents/skills/verify-factory-droid-desktop/drives/setup-env.sh
#        [WORK_DIR]   (default: "$HOME/.cache/factory-verify-tools")
set -eu
WORK="${1:-$HOME/.cache/factory-verify-tools}"
mkdir -p "$WORK"

# 1. Arch-like os-release for the ephemeral build namespace (stand-in hosts
#    only; an Arch/Omarchy target ignores it).
printf 'NAME="Arch Linux"\nID=arch\nID_LIKE=arch\n' > "$WORK/arch-os-release"

# 2. ESM shim: repo smoke scripts import(FACTORY_PLAYWRIGHT_MODULE) and need
#    _electron as a NAMED export; Playwright's CJS entry does not expose one
#    to Node's ESM named-export detection.
cat > "$WORK/pw-esm.mjs" <<'EOF'
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pw = require('playwright-core');
export const _electron = pw._electron;
export default pw;
EOF

# 3. playwright-core (no browser download needed; drives pass executablePath).
if [ ! -d "$WORK/node_modules/playwright-core" ]; then
  ( cd "$WORK" && npm init -y >/dev/null 2>&1 \
    && npm install --no-audit --no-fund playwright-core >/dev/null )
fi

echo 'export FACTORY_VERIFY_WORK='"$WORK"
echo 'export FACTORY_PLAYWRIGHT_MODULE='"$WORK"'/pw-esm.mjs'
echo 'export FACTORY_OS_RELEASE_STANDIN='"$WORK"'/arch-os-release'
