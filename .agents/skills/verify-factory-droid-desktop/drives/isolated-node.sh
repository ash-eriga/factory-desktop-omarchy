#!/bin/sh
# Hard isolation boundary for every verification execution of node (and of
# any vendor binary): env -i plus an explicit allowlist. Ambient credentials
# (FACTORY_API_KEY, GH_TOKEN, tokens, ...) can NEVER cross it, because the
# child environment starts empty.
#
# The script also records ambient secret PRESENCE BOOLEANS (never values) to
# stderr before running, so a run's log proves what the ambient shell held.
#
# Usage: .agents/skills/verify-factory-droid-desktop/drives/isolated-node.sh <workDir> [args...]
set -eu
WORK="${1:?usage: isolated-node.sh <workDir> [node args...]}"
shift

for name in FACTORY_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY GH_TOKEN GITHUB_TOKEN; do
  if [ -n "$(printenv "$name")" ]; then
    echo "ambient-secret-present $name=true" >&2
  fi
done

if [ -z "${DISPLAY:-}" ]; then
  echo "isolated-node.sh: no DISPLAY (wrap in xvfb-run on headless hosts)" >&2
  exit 1
fi

exec env -i \
  PATH="$PATH" \
  HOME="${HOME:-}" USER="${USER:-}" LOGNAME="${LOGNAME:-}" \
  LANG="${LANG:-}" TZ="${TZ:-}" \
  DISPLAY="$DISPLAY" \
  XAUTHORITY="${XAUTHORITY:-}" \
  WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-}" \
  XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" \
  XDG_SESSION_TYPE="${XDG_SESSION_TYPE:-}" \
  DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}" \
  ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-}" \
  FACTORY_PLAYWRIGHT_MODULE="$WORK/pw-esm.mjs" \
  "$@"
