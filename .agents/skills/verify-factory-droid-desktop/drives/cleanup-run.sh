#!/bin/sh
# Safe cleanup for one recorded harness run. Acts ONLY on the PID recorded
# in that run's own journey.json, and only after re-verifying, from /proc,
# that the PID still exists, belongs to this user, and is the recorded
# factory-desktop instance from a temp factory-* profile. Never kills by
# name, never scans for candidate processes, never touches anything else.
#
# Usage: cleanup-run.sh <runOutputDir>   (the dir holding journey.json)
set -eu
DIR="${1:?usage: cleanup-run.sh <runOutputDir>}"
REPORT="$DIR/journey.json"
[ -f "$REPORT" ] || { echo "no $REPORT; nothing recorded to clean" >&2; exit 0; }

PID=$(sed -n 's/.*"mainPid"[: ]*\([0-9][0-9]*\).*/\1/p' "$REPORT")
[ -n "$PID" ] || { echo "report holds no mainPid; nothing to clean"; exit 0; }

if [ ! -r "/proc/$PID/cmdline" ]; then
  echo "recorded pid $PID already gone; nothing to clean"
  exit 0
fi
OWNER=$(stat -c %u "/proc/$PID")
[ "$OWNER" = "$(id -u)" ] || { echo "recorded pid $PID not owned by this user; NOT touched" >&2; exit 1; }
CMDLINE=$(tr '\0' ' ' < "/proc/$PID/cmdline")
case "$CMDLINE" in
  */factory-desktop*) : ;;
  *) echo "recorded pid $PID is not factory-desktop anymore ($CMDLINE); NOT touched" >&2; exit 1 ;;
esac
case "$CMDLINE" in
  */tmp/factory-*|*/factory-journey-*|*/factory-baseline-*) : ;;
  *) echo "recorded pid $PID does not run from a temp factory profile; NOT touched" >&2; exit 1 ;;
esac

kill "$PID" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -r "/proc/$PID" ] || break
  sleep 0.5
done
if [ -r "/proc/$PID" ]; then
  kill -KILL "$PID" 2>/dev/null || true
fi
echo "recorded pid $PID (verified factory-desktop, temp profile) cleaned"
