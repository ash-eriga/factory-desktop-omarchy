#!/bin/sh
# Opt-in factory-desktop:// callback registration for the Factory Desktop port.
# The implementation lives in factory-callback.py (journaling, exact
# rollback, desktop-specific overrides); see its header for usage.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 "$SCRIPT_DIR/factory-callback.py" "$@"
