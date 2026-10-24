#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# -B: never write __pycache__ into the fingerprint-verified payload.
exec python3 -B "$ROOT/port/collector.py" --bundle "$ROOT" "$@"
