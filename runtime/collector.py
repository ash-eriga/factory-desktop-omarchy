#!/usr/bin/env python3
"""Factory Droid Desktop usage collector for the Omarchy agents panel.

Runs the bundled auth helper (Electron in Node mode) to read saved
credentials the way the desktop app itself does, queries the same billing
endpoints the renderer uses, and writes one Omarchy agents-panel usage
record. Credential material never leaves the helper process: this collector
sees only whitelisted metrics and static error categories.

Records are written atomically to
${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/agents/usage/factory.json.
No account IDs, emails, or tokens are ever persisted or printed.

The helper output protocol is one line "FACTORY-USAGE-JSON-1" followed by a
single JSON object. Anything else the helper or its SDK prints on stdout is
ignored.
"""

import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

# Never let Python bytecode caches appear next to this file: the collector
# ships inside a fingerprint-verified payload, and a stray __pycache__ would
# fail verification.
sys.dont_write_bytecode = True

# Allow importing the sibling module when loaded via importlib from tests.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from local_usage import local_accounting

SENTINEL = "FACTORY-USAGE-JSON-1"
RECORD_SCHEMA_VERSION = 1
RECORD_ID = "factory"
RECORD_NAME = "Factory"
DEFAULT_CACHE_SECONDS = 300
HELPER_TIMEOUT_SECONDS = 90
LOCK_TIMEOUT_SECONDS = 10

# Static error categories. The collector never echoes helper stderr or HTTP
# response bodies, which could carry sensitive material.
FAILURE_TEXTS = {
    "unauthenticated": (
        "Not signed in.",
        "Open Factory Droid Desktop and sign in to enable usage and limits reporting.",
    ),
    "unsupported-deployment": (
        "This collector supports Factory-managed accounts only.",
        "Customer on-premise and air-gapped deployments are not supported.",
    ),
    "schema-error": (
        "Factory reported an unexpected usage schema.",
        "The record may be outdated until the Factory Desktop app updates its billing format.",
    ),
    "helper-timeout": (
        "Usage refresh timed out.",
        "Retry later, or check that the Factory Droid Desktop port is installed correctly.",
    ),
    "helper-missing": (
        "Usage helper is missing from the bundle.",
        "Rebuild the Factory Droid Desktop port; the installation looks incomplete.",
    ),
    "helper-error": (
        "Usage helper failed.",
        "Retry later; if this persists, check the Factory Droid Desktop installation.",
    ),
    "network": (
        "Could not reach Factory.",
        "Check the network connection and retry.",
    ),
}

BUCKET_LABELS = (("fiveHour", "5-Hour"), ("weekly", "Weekly"), ("monthly", "Monthly"))
# Explicit panel titles, so generic name inference cannot erase which pool
# a window belongs to; the group header carries the pool identity.
BUCKET_TITLES = {"fiveHour": "5-hour", "weekly": "Weekly", "monthly": "Monthly"}
POOL_GROUPS = (("standard", "STANDARD"), ("core", "DROID CORE"))

# Grounded display names from the vendor bundle. Other tier ids are rendered
# mechanically (capitalized, underscores to spaces) rather than invented.
TIER_LABELS = {
    "team": "Pro",
    "team_annual": "Pro",
    "teams": "Teams",
}


def utc_now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def tier_label(tier):
    if not isinstance(tier, str) or not tier:
        return ""
    grounded = TIER_LABELS.get(tier)
    if grounded:
        return grounded
    return " ".join(word.capitalize() for word in tier.split("_"))


def bucket_active(bucket, now_s):
    """Mirror the vendor renderer: expired and not-yet-started windows are
    not active consumption."""
    if not isinstance(bucket, dict):
        return False
    seconds = bucket.get("secondsRemaining")
    window_end = bucket.get("windowEnd")
    if isinstance(seconds, (int, float)):
        return bool(window_end) and seconds > 0
    if not isinstance(window_end, str) or not window_end:
        return False
    try:
        end = datetime.fromisoformat(window_end.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return False
    return end > now_s


def clamp_fraction(percent):
    value = percent.get("usedPercent", 0) if isinstance(percent, dict) else 0
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        value = 0
    return min(1.0, max(0.0, float(value) / 100.0))


def normalize_limits(metrics, now_s):
    """Build the panel limits list from helper metrics: STANDARD pool first,
    then DROID CORE, each with explicit titles and groups. Returns
    (limits, exhausted_standard, exhausted_core, highest)."""
    limits = []
    exhausted = {"standard": False, "core": False}
    highest = (0.0, "")
    pools = metrics.get("standard"), metrics.get("core")
    for (pool_key, group), pool in zip(POOL_GROUPS, pools):
        if not isinstance(pool, dict):
            continue
        for bucket_key, bucket_label in BUCKET_LABELS:
            bucket = pool.get(bucket_key)
            if not isinstance(bucket, dict):
                continue
            active = bucket_active(bucket, now_s)
            fraction = clamp_fraction(bucket) if active else 0.0
            entry = {
                # The label keeps pool identification for status text; the
                # panel shows the explicit title and group header instead.
                "label": f"{'Core ' if pool_key == 'core' else ''}{bucket_label}",
                "title": BUCKET_TITLES[bucket_key],
                "group": group,
                "percent": round(fraction, 4),
            }
            if active and bucket.get("windowEnd"):
                entry["resetsAt"] = bucket["windowEnd"]
            if fraction >= 1.0:
                exhausted[pool_key] = True
            if fraction > highest[0]:
                highest = (fraction, entry["label"])
            limits.append(entry)
    return limits, exhausted["standard"], exhausted["core"], highest


def normalize_balance(metrics):
    cents = metrics.get("extraUsageBalanceCents")
    if not isinstance(cents, (int, float)) or isinstance(cents, bool) or cents <= 0:
        return None
    return {
        "remaining": round(float(cents) / 100.0, 2),
        "currency": "USD",
        "estimated": False,
    }


def usage_status_text(exhausted_standard, exhausted_core, highest):
    """Returns (status, help). A healthy account stays QUIET: the panel's
    hero shows the plan (tierLabel) and no status card is drawn — an empty
    help text would render a blank warning box. Exhaustion and warnings
    always pair a status with a meaningful help text. Usage mode
    (Standard / Droid Core / Extra Usage) is never inferred."""
    fraction, label = highest
    if exhausted_standard and exhausted_core:
        return ("Standard and Droid Core pools are exhausted.",
                "Both allowance pools are used up for their windows. Wait for "
                "a reset, or use prepaid Extra Usage if available.")
    if exhausted_standard:
        return ("Standard pool exhausted.",
                "The standard allowance is used up for this window. Wait for "
                "the reset shown below, switch to Droid Core, or use prepaid "
                "Extra Usage if available.")
    if exhausted_core:
        return ("Droid Core pool exhausted.",
                "The Droid Core allowance is used up for this window. Wait "
                "for the reset shown below.")
    if fraction >= 0.7:
        return (f"{label} is at {round(fraction * 100)}%.",
                f"You are close to the {label} allowance limit for this window.")
    return ("", "")


def extract_account_recent_sessions(metrics):
    """Validated pass-through of the helper's optional account session
    inventory. The helper emits: requestedLimit, sessionCount,
    creditsSampleTotal (proven self-owned rows only), unknownOwnerRows
    (never credited), hasMore, complete, and a static safe scope string.
    Anything unexpected is omitted; identifiers never appear. A genuinely
    zero sample stays zero; a missing value stays missing."""
    raw = metrics.get("accountRecentSessions")
    if not isinstance(raw, dict):
        return None
    out = {}
    for key in ("requestedLimit", "sessionCount", "creditsSampleTotal", "unknownOwnerRows"):
        value = raw.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
            out[key] = value
    for key in ("hasMore", "complete"):
        value = raw.get(key)
        if isinstance(value, bool):
            out[key] = value
    scope = raw.get("scope")
    # Static helper-side scope text: bounded, plain prose, no identifiers.
    if isinstance(scope, str) and 0 < len(scope) <= 200 \
            and not re.search(r"[0-9a-f]{8}-[0-9a-f]{4}", scope) \
            and not re.search(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", scope):
        out["scope"] = scope
    if "sessionCount" not in out:
        return None
    # An empty sample is still meaningful when the helper saw rows it could
    # not credit (unknown-owner rows); a completely empty object is not.
    if out.get("sessionCount", 0) <= 0 and out.get("unknownOwnerRows", 0) <= 0:
        return None
    out.setdefault("complete", False)
    return out


def build_record(metrics, now_s=None, accounting=None):
    """Turn validated helper metrics plus local accounting into an Omarchy
    usage record. Contains no account IDs, emails, session ids, titles, or
    tokens(secrets)."""
    now_s = time.time() if now_s is None else now_s
    limits, exhausted_standard, exhausted_core, highest = normalize_limits(metrics, now_s)
    status, help_text = usage_status_text(exhausted_standard, exhausted_core, highest)
    record = {
        "schemaVersion": RECORD_SCHEMA_VERSION,
        "id": RECORD_ID,
        "name": RECORD_NAME,
        "updatedAt": utc_now_iso(),
        "ready": True,
        "tierLabel": tier_label(metrics.get("tier")),
        "limits": limits,
        # Empty status + help keeps the panel quiet: the hero shows the plan
        # and no blank warning box is drawn.
        "usageStatusText": status,
        "authHelpText": help_text,
    }
    balance = normalize_balance(metrics)
    if balance is not None:
        record["balance"] = balance
    if isinstance(accounting, dict):
        for key, value in accounting.items():
            if key in ACCOUNTING_FIELDS:
                record[key] = value
    sessions_inventory = extract_account_recent_sessions(metrics)
    if sessions_inventory is not None:
        record["accountRecentSessions"] = sessions_inventory
    return record


# Local-accounting fields the panel understands; anything else in the
# accounting dict is dropped rather than passed through blindly.
ACCOUNTING_FIELDS = ("hasLocalStats", "hasPromptStats", "statsDate", "totalSessions", "activeDays",
                     "todaySessions", "todayTotalTokens", "todayTokensByModel",
                     "recentDays", "modelUsage", "statsScopeLabel",
                     "totalTokensLocal", "factoryCreditsLocal")


def build_failure_record(category, accounting=None):
    status, help_text = FAILURE_TEXTS.get(category, FAILURE_TEXTS["helper-error"])
    record = {
        "schemaVersion": RECORD_SCHEMA_VERSION,
        "id": RECORD_ID,
        "name": RECORD_NAME,
        "updatedAt": utc_now_iso(),
        "ready": False,
        "tierLabel": "",
        "limits": [],
        "usageStatusText": status,
        "authHelpText": help_text,
    }
    if isinstance(accounting, dict):
        for key, value in accounting.items():
            if key in ACCOUNTING_FIELDS:
                record[key] = value
    return record


def validate_metrics(payload):
    """Structural gate on helper output. Returns the payload or raises
    ValueError on drift; the collector never guesses around drift."""
    if not isinstance(payload, dict):
        raise ValueError("not an object")
    if payload.get("ok") is not True:
        raise ValueError("not a success payload")
    if not isinstance(payload.get("credentialSource"), str):
        raise ValueError("credentialSource missing")
    for key in ("standard", "core"):
        pool = payload.get(key)
        if pool is None:
            continue
        if not isinstance(pool, dict):
            raise ValueError(f"{key} pool is not an object")
        for bucket_key, _ in BUCKET_LABELS:
            bucket = pool.get(bucket_key)
            if bucket is None:
                continue
            if not isinstance(bucket, dict):
                raise ValueError(f"{key}.{bucket_key} is not an object")
            percent = bucket.get("usedPercent")
            if percent is not None and (not isinstance(percent, (int, float))
                                        or isinstance(percent, bool)
                                        or percent != percent):
                raise ValueError(f"{key}.{bucket_key}.usedPercent is not numeric")
            window_end = bucket.get("windowEnd")
            if window_end is not None and not isinstance(window_end, str):
                raise ValueError(f"{key}.{bucket_key}.windowEnd is not a string")
            seconds = bucket.get("secondsRemaining")
            if seconds is not None and (not isinstance(seconds, (int, float))
                                        or isinstance(seconds, bool)):
                raise ValueError(f"{key}.{bucket_key}.secondsRemaining is not numeric")
    cents = payload.get("extraUsageBalanceCents")
    if cents is not None and (not isinstance(cents, (int, float)) or isinstance(cents, bool)):
        raise ValueError("extraUsageBalanceCents is not numeric")
    return payload


def parse_helper_output(text):
    """Extract the last sentinel-delimited JSON object; ignore everything
    else the helper or its SDK printed."""
    marker = text.rfind(SENTINEL)
    if marker == -1:
        raise ValueError("sentinel not found")
    tail = text[marker + len(SENTINEL):].lstrip()
    line = tail.splitlines()[0] if tail.splitlines() else ""
    payload = json.loads(line)
    if not isinstance(payload, dict) or "ok" not in payload:
        raise ValueError("helper payload has no ok field")
    return payload


def bundle_root():
    return Path(__file__).resolve().parent.parent


def factory_home(profile):
    if profile:
        return Path(profile).expanduser()
    override = os.environ.get("FACTORY_HOME_OVERRIDE")
    if override:
        return Path(override)
    data_home = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(data_home) / "factory-droid-desktop" / "factory-home"


def cache_dir():
    base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(base) / "factory-droid-desktop"


def state_dir():
    base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(base) / "omarchy" / "agents" / "usage"


def cache_key(profile_path):
    identity = f"{profile_path}|{os.environ.get('FACTORY_ENV', 'production')}|{os.environ.get('FACTORY_DEPLOYMENT_ENV', 'production')}"
    return hashlib.sha256(identity.encode()).hexdigest()[:16]


def run_helper(bundle, profile_path, timeout):
    """Run the helper that ships NEXT TO THIS COLLECTOR, against the vendor
    bundle passed explicitly. A collector deployed outside the bundle (the
    plugin payload) must never fall back to the vendor bundle's own helper,
    which may predate the current metrics contract."""
    electron = bundle / "factory-desktop"
    helper = Path(__file__).resolve().parent / "auth-helper.mjs"
    if not electron.is_file() or not helper.is_file():
        return {"ok": False, "error": "helper-missing"}
    env = dict(os.environ)
    env["ELECTRON_RUN_AS_NODE"] = "1"
    env["NODE_OPTIONS"] = ""
    env.pop("ELECTRON_NO_ASAR", None)
    env["FACTORY_HOME_OVERRIDE"] = str(profile_path)
    env.setdefault("FACTORY_ENV", "production")
    env.setdefault("FACTORY_RELEASE_CHANNEL", "production")
    env.setdefault("FACTORY_DEPLOYMENT_ENV", "production")
    try:
        result = subprocess.run(
            [str(electron), str(helper), "--bundle", str(bundle)],
            capture_output=True, text=True, timeout=timeout, env=env,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "helper-timeout"}
    except OSError:
        return {"ok": False, "error": "helper-error"}
    try:
        return parse_helper_output(result.stdout or "")
    except (ValueError, json.JSONDecodeError):
        return {"ok": False, "error": "helper-error"}


def load_cache(path, key, max_age, now_s):
    """Returns the cached raw helper metrics payload, or None."""
    try:
        entry = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if entry.get("key") != key or not isinstance(entry.get("payload"), dict):
        return None
    fetched = entry.get("fetchedAt")
    if not isinstance(fetched, (int, float)):
        return None
    if now_s - fetched > max_age:
        return None
    payload = entry["payload"]
    if not isinstance(payload.get("ok"), bool):
        return None
    return payload


def store_cache(path, key, metrics, now_s):
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False)
        try:
            json.dump({"key": key, "fetchedAt": now_s, "payload": metrics}, handle)
            handle.flush()
            os.fsync(handle.fileno())
        finally:
            handle.close()
        os.chmod(handle.name, 0o600)
        os.replace(handle.name, path)
    except OSError:
        pass


def write_record(path, record):
    """Atomic write; the panel never observes a partial record."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False)
    try:
        json.dump(record, handle)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    finally:
        handle.close()
    os.chmod(handle.name, 0o644)
    os.replace(handle.name, path)


class LockBusy(Exception):
    pass


class RefreshLock:
    """Bounds refreshes so overlapping timers never run two helpers."""

    def __init__(self, path):
        self.path = path
        self.handle = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = open(self.path, "w")
        try:
            fcntl.flock(self.handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.handle.close()
            raise LockBusy()
        return self

    def __exit__(self, *exc):
        try:
            fcntl.flock(self.handle, fcntl.LOCK_UN)
        finally:
            self.handle.close()
        return False


def collect(bundle, profile_path, force, cache_seconds, now_s=None):
    """Build the usage record. Local accounting (and the observation ledger)
    advance on every run; the authenticated metrics come from the cache when
    fresh and from the helper otherwise. Returns (record, served_from_cache).
    """
    now_s = time.time() if now_s is None else now_s
    cache_file = cache_dir() / "usage-cache.json"
    key = cache_key(str(profile_path))
    accounting = local_accounting(cache_dir(), now_s=now_s)
    metrics = None
    if not force:
        metrics = load_cache(cache_file, key, cache_seconds, now_s)
    fetched = metrics is None
    if fetched:
        metrics = run_helper(bundle, profile_path, HELPER_TIMEOUT_SECONDS)
    if metrics.get("ok") is not True:
        record = build_failure_record(
            metrics.get("error") if isinstance(metrics.get("error"), str) else "helper-error",
            accounting)
        return record, False
    try:
        validate_metrics(metrics)
    except ValueError:
        record = build_failure_record("schema-error", accounting)
        return record, False
    if fetched:
        store_cache(cache_file, key, metrics, now_s)
    record = build_record(metrics, now_s=now_s, accounting=accounting)
    return record, not fetched


def main(argv=None):
    parser = argparse.ArgumentParser(description="Factory usage collector for Omarchy")
    parser.add_argument("--bundle", default=None, help=argparse.SUPPRESS)
    parser.add_argument("--profile", default=None, help="Factory home override used for credentials")
    parser.add_argument("--write", action="store_true", help="Write the usage record for the Omarchy panel")
    parser.add_argument("--force", action="store_true", help="Refresh even if the cache is fresh")
    # The agents-panel wrapper forwards --limits-only; limits are always
    # part of a refresh here, so the flag is accepted as a no-op.
    parser.add_argument("--limits-only", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--cache-seconds", type=int, default=DEFAULT_CACHE_SECONDS)
    args = parser.parse_args(argv)

    bundle = Path(args.bundle).resolve() if args.bundle else bundle_root()
    profile_path = factory_home(args.profile)

    try:
        with RefreshLock(cache_dir() / "factory-usage.lock"):
            record, cached = collect(bundle, profile_path, args.force, max(30, args.cache_seconds))
    except LockBusy:
        # Another refresh holds the lock; the existing record stays valid.
        return 0

    if args.write:
        write_record(state_dir() / f"{RECORD_ID}.json", record)
    json.dump(record, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
