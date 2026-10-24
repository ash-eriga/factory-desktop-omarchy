#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/factory-desktop-arch"
umask 077
mkdir -p "$DATA/factory-home" "$DATA/user-data"
unset NODE_OPTIONS ELECTRON_RUN_AS_NODE ELECTRON_NO_ASAR
unset FACTORY_DESKTOP_RENDERER_URL FACTORY_E2E_DAEMON_HOOKS
unset FACTORY_DESKTOP_DAEMON_BINARY FACTORY_DISABLE_KEYRING
export FACTORY_ENV=production FACTORY_RELEASE_CHANNEL=production
export FACTORY_DEPLOYMENT_ENV=production
export FACTORY_HOME_OVERRIDE="$DATA/factory-home"
exec "$ROOT/factory-desktop" "--user-data-dir=$DATA/user-data" "$@"
