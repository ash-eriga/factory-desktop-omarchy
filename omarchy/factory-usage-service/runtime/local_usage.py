#!/usr/bin/env python3
"""Local Factory session accounting for the usage collector.

Scans the Desktop port's and the Droid CLI's local session metadata
(*.jsonl session_start records + *.settings.json) and the collector's own
observation ledger.

Honesty rules enforced here:

- Only each session's OWN `tokenUsage` is counted. `inclusiveTokenUsage`
  and `childInclusiveTokenUsageBySessionId` (which include child sessions)
  are ignored, so tokens are counted once at the session that generated
  them and child overlap cannot double-count.
- Sessions seen in both the Desktop and CLI profiles (session migration)
  are deduplicated by id by keeping ONE coherent dominating snapshot (the
  larger vendor total, then the more recently modified file). Counters are
  never combined across profiles, so incompatible snapshots cannot be
  stitched into inflated totals.
- Historical model attribution is NOT established by local files: the
  model in `.settings.json` is the session's last model only. Model usage
  therefore counts OBSERVED GROWTH ONLY (ledger deltas with a stable
  model), plus an explicit "unattributed" bucket for everything that
  existed before the ledger's first run. Session switches land in a
  "mixed" bucket. Truthful device totals are reported separately as
  totalTokensLocal / factoryCreditsLocal — never redistributed across
  models.
- The per-model amounts are kept in their own persistent accumulator, not
  derived from the day buckets. The daily retention window (90 days) is
  about the day chart; if it also dropped the per-model source, the
  high-water marks would make the discarded growth unrecoverable while
  the label still promised growth since the first observation.
- The vendor total-token formula (Desktop renderer, `bg()` in the compiled
  bundle) is: input + output + thinking + Math.round(cacheCreation +
  cacheRead). Math.round rounds .5 up; the cache sum is non-negative here.
  Because that formula ROUNDS the cumulative counters, the observed growth
  of the total is the difference of the rounded totals, not the rounded sum
  of the per-counter deltas (a cache counter moving 0 -> 0.5 -> 1 is ONE
  token of growth, not two).
- The day chart comes from the observation/delta ledger: it is explicitly
  "observed since" the ledger's first run. Past days before that stay
  empty; offline gaps land on the day the delta was observed; sessions
  completed between two refreshes are reported as observed additions on
  the discovery day (not backdated); counter rollbacks produce no negative
  or double-counted deltas because every counter tracks a per-counter
  high-water mark; the baseline of the observed total is the per-counter
  high-water envelope, so a counter that grows while another one rolls
  back still contributes its growth on the day it was observed; day buckets
  use the local timezone.
- The persisted ledger is keyed by a hashed session key (never raw session
  ids) and stored 0600 in a 0700 directory via unique temp files.
- No session ids, titles, cwd, organization ids, or message content ever
  leaves this module: only counters and model ids.
"""

import hashlib
import json
import math
import os
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path

LEDGER_VERSION = 2
LEDGER_FILENAME = "factory-observation-ledger.json"
DAY_RETENTION_DAYS = 90
TOTAL_TOKEN_FIELDS = ("inputTokens", "outputTokens", "thinkingTokens",
                      "cacheCreationTokens", "cacheReadTokens")
MIXED_MODEL_KEY = "mixed"
UNATTRIBUTED_MODEL_KEY = "unattributed"


def session_key(session_id):
    """Stable internal key for the persisted ledger: a truncated SHA-256 of
    the session id. Raw ids are never serialized."""
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:16]


def local_date(epoch_s, now=None):
    """Local calendar date (YYYY-MM-DD) for an epoch timestamp."""
    return datetime.fromtimestamp(epoch_s).strftime("%Y-%m-%d")


def default_profiles():
    home = Path.home()
    data_home = os.environ.get("XDG_DATA_HOME") or str(home / ".local" / "share")
    override = os.environ.get("FACTORY_HOME_OVERRIDE")
    desktop_home = Path(override) if override else Path(data_home) / "factory-droid-desktop" / "factory-home"
    return [
        ("desktop", desktop_home / ".factory" / "sessions"),
        ("cli", home / ".factory" / "sessions"),
    ]


def read_json(path):
    try:
        return json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None


def scan_session(path, profile):
    """One session's own counters from <id>.settings.json. The *.jsonl
    metadata (id, cwd, owner, organizationId, title, hostId, version) is
    deliberately not read: nothing from it is needed and nothing from it may
    be serialized."""
    settings = read_json(path)
    if not isinstance(settings, dict):
        return None
    usage = settings.get("tokenUsage")
    if not isinstance(usage, dict):
        return None
    tokens = {}
    for key in TOTAL_TOKEN_FIELDS:
        value = usage.get(key)
        tokens[key] = value if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else 0
    credits = usage.get("factoryCredits")
    tokens["factoryCredits"] = credits if isinstance(credits, (int, float)) and not isinstance(credits, bool) and credits >= 0 else 0
    if not any(tokens[k] for k in TOTAL_TOKEN_FIELDS) and not tokens["factoryCredits"]:
        return None
    model = settings.get("model")
    session_id = path.name[: -len(".settings.json")]
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = 0.0
    return {
        "id": session_id,
        "profile": profile,
        "model": model if isinstance(model, str) and model else "",
        "tokens": tokens,
        "mtime": mtime,
    }


def iter_session_settings(sessions_dir):
    """Yield *.settings.json paths under sessions_dir. Factory nests
    session settings in per-workspace subdirectories below
    .factory/sessions; walk nested directories safely: directory symlinks
    are not followed (loop/mount safety), unreadable entries are skipped,
    and only *.settings.json files are yielded — metadata JSONLs and *.bak
    copies never match."""
    stack = [Path(sessions_dir)]
    while stack:
        current = stack.pop()
        try:
            entries = list(current.iterdir())
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_symlink():
                    continue  # never follow session-tree links
                if entry.is_dir():
                    stack.append(entry)
                elif entry.is_file() and entry.name.endswith(".settings.json"):
                    yield entry
            except OSError:
                continue


def scan_profiles(profiles=None):
    """All readable local sessions from every profile, including nested
    workspace subdirectories. Returns (sessions, unreadable_count)."""
    sessions = []
    unreadable = 0
    for profile, sessions_dir in (profiles or default_profiles()):
        sessions_dir = Path(sessions_dir)
        if not sessions_dir.is_dir():
            continue
        for entry in iter_session_settings(sessions_dir):
            session = scan_session(entry, profile)
            if session is None:
                unreadable += 1
                continue
            sessions.append(session)
    return sessions, unreadable


def session_total(session):
    return (session_total_tokens(session["tokens"]) + session["tokens"]["factoryCredits"],
            session.get("mtime", 0.0))


def dedup_sessions(sessions):
    """One entry per session id. A session migrated between profiles keeps
    ONE coherent snapshot: the dominating total first, then the more
    recently modified file as a tie-break. Counters from different profile
    snapshots are never combined — that would invent usage neither
    snapshot recorded."""
    by_id = {}
    for session in sessions:
        existing = by_id.get(session["id"])
        if existing is None:
            by_id[session["id"]] = session
            continue
        if session_total(session) > session_total(existing):
            by_id[session["id"]] = session
    return list(by_id.values())


def js_round_positive(value):
    """JavaScript Math.round semantics for a non-negative number: .5 rounds
    up (Python's round() is banker's rounding)."""
    return math.floor(value + 0.5)


def session_total_tokens(tokens):
    """The vendor's total-token formula: input + output + thinking +
    Math.round(cacheCreation + cacheRead)."""
    cache = tokens.get("cacheCreationTokens", 0) + tokens.get("cacheReadTokens", 0)
    return (tokens.get("inputTokens", 0) + tokens.get("outputTokens", 0)
            + tokens.get("thinkingTokens", 0) + js_round_positive(cache))


def model_totals_from_days(ledger):
    """The per-model amounts a ledger still carries in its day buckets."""
    totals = {}
    for day in (ledger.get("days") or {}).values():
        if not isinstance(day, dict):
            continue
        for model, tokens in (day.get("byModel") or {}).items():
            bucket = totals.setdefault(model, {"totalTokens": 0, "factoryCredits": 0})
            bucket["totalTokens"] += tokens
        for model, credits in (day.get("byModelCredits") or {}).items():
            bucket = totals.setdefault(model, {"totalTokens": 0, "factoryCredits": 0})
            bucket["factoryCredits"] += credits
    return totals


def migrate_model_totals(ledger):
    """One-time, additive migration of a ledger written before the
    persistent per-model accumulator existed: such a ledger keeps its only
    per-model source in the day buckets, which the daily retention window
    would eventually erase. The buckets are folded into the accumulator so
    the per-model amounts survive the retention window. A ledger that
    already carries the accumulator is left untouched, so nothing is ever
    counted twice.

    The recovery limit is explicit: a ledger whose day buckets were ALREADY
    expired before this migration can only contribute what those buckets
    still hold. The discarded growth is not invented.
    """
    if isinstance(ledger.get("modelTotals"), dict):
        return
    ledger["modelTotals"] = model_totals_from_days(ledger)


def build_model_usage(ledger):
    """Per-model OBSERVED growth from the ledger's persistent per-model
    accumulator, plus one explicit "unattributed" bucket carrying what
    existed before the ledger's first run. Historical counters are never
    re-attributed to a session's final model.

    The accumulator does not expire with the day buckets: the daily
    retention window belongs to the day chart, and it must not delete the
    only source of the per-model amounts. A ledger that has not been
    migrated yet falls back to its day buckets, which are the only
    per-model source such a ledger has."""
    usage = {}
    seed = ledger.get("seedTotals")
    if isinstance(seed, dict) and (seed.get("tokens", 0) > 0 or seed.get("credits", 0) > 0):
        usage[UNATTRIBUTED_MODEL_KEY] = {
            "totalTokens": seed.get("tokens", 0),
            "factoryCredits": seed.get("credits", 0),
        }
    totals = ledger.get("modelTotals")
    if not isinstance(totals, dict):
        totals = model_totals_from_days(ledger)
    for model, values in totals.items():
        if not isinstance(values, dict):
            continue
        tokens = values.get("totalTokens", 0)
        credits = values.get("factoryCredits", 0)
        if not tokens and not credits:
            continue
        bucket = usage.setdefault(model, {"totalTokens": 0, "factoryCredits": 0})
        bucket["totalTokens"] += tokens
        bucket["factoryCredits"] += credits
    return usage


def load_ledger(cache_dir):
    path = Path(cache_dir) / LEDGER_FILENAME
    try:
        ledger = json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return {"version": LEDGER_VERSION, "observedSince": None, "seeded": False,
                "seedTotals": None, "observations": {}, "days": {}}, path
    if not isinstance(ledger, dict) or ledger.get("version") != LEDGER_VERSION:
        return {"version": LEDGER_VERSION, "observedSince": None, "seeded": False,
                "seedTotals": None, "observations": {}, "days": {}}, path
    ledger.setdefault("observedSince", None)
    ledger.setdefault("seeded", False)
    ledger.setdefault("seedTotals", None)
    ledger.setdefault("observations", {})
    ledger.setdefault("days", {})
    return ledger, path


def store_ledger(path, ledger, now_s):
    """Persist the ledger safely: hashed keys only, unique 0600 temp file,
    atomic replace, 0700 directory."""
    cutoff = now_s - DAY_RETENTION_DAYS * 86400
    ledger["days"] = {date: day for date, day in ledger.get("days", {}).items()
                      if day_for_date(date, now_s) >= cutoff - 86400 * 2}
    try:
        directory = Path(path).parent
        directory.mkdir(parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
        fd, tmp_name = tempfile.mkstemp(dir=str(directory), prefix=".ledger-", suffix=".tmp")
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write((json.dumps(ledger) + "\n").encode("utf-8"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_name, str(path))
        except BaseException:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise
    except OSError:
        pass


def day_for_date(date, now_s):
    try:
        return datetime.strptime(date, "%Y-%m-%d").timestamp()
    except ValueError:
        return 0.0


def _add_observed_growth(ledger, day, attribution, tokens_total, credits):
    """Record observed growth in the day bucket AND in the persistent
    per-model accumulator. The accumulator is what survives the daily
    retention window; both receive the same attribution, so the day chart
    and the per-model amounts can never disagree."""
    day["tokens"] = day.get("tokens", 0) + tokens_total
    day["credits"] = day.get("credits", 0) + credits
    by_model = day.setdefault("byModel", {})
    by_model[attribution] = by_model.get(attribution, 0) + tokens_total
    by_model_credits = day.setdefault("byModelCredits", {})
    by_model_credits[attribution] = by_model_credits.get(attribution, 0) + credits
    totals = ledger.setdefault("modelTotals", {})
    bucket = totals.setdefault(attribution, {"totalTokens": 0, "factoryCredits": 0})
    bucket["totalTokens"] = bucket.get("totalTokens", 0) + tokens_total
    bucket["factoryCredits"] = bucket.get("factoryCredits", 0) + credits


def update_ledger(ledger, deduped, now_s):
    """Fold this run's cumulative counters into the observation ledger and
    return (today, recent_days). Per-counter HIGH-WATER marks mean a
    rolled-back counter that later recovers contributes nothing twice, and
    the high-water mark of the ROUNDED total keeps the observed growth of a
    fractional counter consistent with the device total. The baseline of
    that total is the per-counter high-water ENVELOPE, so the growth of one
    counter is not hidden by another counter rolling back."""
    first_global = not ledger.get("seeded") and not ledger.get("observations")
    if ledger.get("observedSince") is None:
        ledger["observedSince"] = datetime.fromtimestamp(now_s).strftime("%Y-%m-%dT%H:%M:%S%z")
    migrate_model_totals(ledger)
    # The legacy "hwTotal" field has no reader left: the observed growth
    # comes from the per-counter envelope, and the reader that used to
    # read it falls back to that very envelope, so keeping the field only
    # persisted a second representation of the same number. It is dropped
    # from EVERY observation (also the ones this scan does not visit), so
    # a stale value cannot survive a reload. The rest of the observation
    # (the envelope "hw", the model, the day marks) is untouched.
    for obs in (ledger.get("observations") or {}).values():
        if isinstance(obs, dict):
            obs.pop("hwTotal", None)
    today_date = local_date(now_s)
    today = ledger["days"].setdefault(today_date, {"tokens": 0, "credits": 0, "sessions": 0, "byModel": {}})
    today_started_empty = today["tokens"] == 0 and today["credits"] == 0 and today["sessions"] == 0
    sessions_today = 0
    seed_tokens = 0
    seed_credits = 0

    for session in deduped:
        key = session_key(session["id"])
        current = session["tokens"]
        obs = ledger["observations"].get(key)
        if obs is None:
            # A session never seen before. The very first run seeds the
            # ledger: everything already on disk becomes the baseline and
            # must not count as today's consumption. Later discoveries
            # (sessions completed between two refreshes, or migrated in)
            # are OBSERVED ADDITIONS on the discovery day — not backdated
            # and not claimed as exact creation-date consumption.
            ledger["observations"][key] = {
                "ts": now_s, "model": session["model"], "hw": dict(current),
            }
            if first_global:
                seed_tokens += session_total_tokens(current)
                seed_credits += current["factoryCredits"]
                continue
            if session_total_tokens(current) > 0 or current["factoryCredits"] > 0:
                obs = ledger["observations"][key]
                _add_observed_growth(ledger, today, session["model"] or "unknown",
                                     session_total_tokens(current), current["factoryCredits"])
                # The discovery IS activity today: recording the day keeps
                # the session's own growth later the same day from being
                # counted as a second active session.
                obs["lastCountedDay"] = today_date
                sessions_today += 1
            continue

        hw = obs.setdefault("hw", dict(obs.get("tokens", {})))
        previous_model = obs.get("model")
        credits_high_water = hw.get("factoryCredits", 0)
        obs["ts"] = now_s
        obs["model"] = session["model"]
        # The vendor total is a ROUNDED function of the cumulative
        # counters, so the observed growth of the total is the difference
        # of the ROUNDED totals — not the rounded sum of the rounded
        # per-counter deltas. A cache counter moving 0 -> 0.5 -> 1 is ONE
        # token of growth, not two.
        #
        # The baseline is the per-counter HIGH-WATER ENVELOPE (the maximum
        # ever observed of each counter), never the raw snapshot: the
        # counters of a session move independently, so a counter that
        # rolls back while another one grows must still contribute the
        # growth of the counter that grew. Taking the difference of the
        # raw snapshot totals would hide that growth and move it to the
        # day the rolled-back counter recovers.
        baseline_total = session_total_tokens(hw)
        for k in current:
            hw[k] = max(hw.get(k, 0), current[k])
        envelope_total = session_total_tokens(hw)
        delta_total = max(0, envelope_total - baseline_total)
        delta_credits = max(0, current["factoryCredits"] - credits_high_water)
        if delta_total <= 0 and delta_credits <= 0:
            continue
        attribution = MIXED_MODEL_KEY if previous_model not in ("", None, session["model"]) \
            else (session["model"] or "unknown")
        if obs.get("lastCountedDay") != today_date:
            obs["lastCountedDay"] = today_date
            sessions_today += 1
        _add_observed_growth(ledger, today, attribution, delta_total, delta_credits)

    if first_global:
        ledger["seedTotals"] = {
            "tokens": seed_tokens + (ledger.get("seedTotals") or {}).get("tokens", 0),
            "credits": seed_credits + (ledger.get("seedTotals") or {}).get("credits", 0),
        }
    ledger["seeded"] = True
    if sessions_today:
        today["sessions"] = today.get("sessions", 0) + sessions_today
    if today_started_empty and not today["tokens"] and not today["credits"] and not today["sessions"]:
        ledger["days"].pop(today_date, None)


def recent_days(ledger, now_s, days=7):
    """The last `days` local dates as panel rows: {date, messageCount} where
    messageCount carries the day's observed token count.

    The rows are CALENDAR days, not blocks of 86400 seconds: a civil day
    lasts 23 or 25 hours on the days the clock changes, so subtracting
    86400 seconds from the timestamp lands on the same local date twice
    (or skips a date) around the change. The rows are walked from today's
    local date with timedelta, which always yields consecutive calendar
    days, in the same order and with the same number of rows.
    """
    result = []
    today = datetime.strptime(local_date(now_s), "%Y-%m-%d").date()
    for offset in range(days - 1, -1, -1):
        date = (today - timedelta(days=offset)).isoformat()
        day = ledger.get("days", {}).get(date, {})
        result.append({"date": date, "messageCount": day.get("tokens", 0)})
    return result


def local_accounting(cache_dir, profiles=None, now_s=None, scan=None):
    """Everything the record needs from this device. Returns a dict that is
    empty (no keys) when no local sessions are readable at all."""
    now_s = time.time() if now_s is None else now_s
    sessions, unreadable = (scan or scan_profiles)(profiles)
    if not sessions:
        return {}
    deduped = dedup_sessions(sessions)
    ledger, ledger_path = load_ledger(cache_dir)
    update_ledger(ledger, deduped, now_s)
    store_ledger(ledger_path, ledger, now_s)
    today = ledger.get("days", {}).get(local_date(now_s), {})
    accounting = {
        "hasLocalStats": True,
        # Sessions never count prompts locally; the panel must not show
        # "0 prompts" as if it were a quiet day.
        "hasPromptStats": False,
        # The LOCAL calendar day these "today" counters belong to. The
        # panel needs it to tell today's numbers from a snapshot another
        # machine wrote on another day: the transport timestamp of a
        # snapshot does not prove its statistics are current.
        "statsDate": local_date(now_s),
        "totalSessions": len(deduped),
        # Truthful device totals, kept separate from per-model attribution.
        "totalTokensLocal": sum(session_total_tokens(s["tokens"]) for s in deduped),
        "factoryCreditsLocal": round(sum(s["tokens"]["factoryCredits"] for s in deduped), 4),
        "activeDays": len(ledger.get("days", {})),
        "todaySessions": today.get("sessions", 0),
        "todayTotalTokens": today.get("tokens", 0),
        "todayTokensByModel": dict(today.get("byModel", {})),
        "recentDays": recent_days(ledger, now_s),
        "modelUsage": build_model_usage(ledger),
        "statsScopeLabel": observation_scope_label(ledger),
        "unreadableSessionFiles": unreadable,
    }
    if not accounting["todayTokensByModel"]:
        accounting.pop("todayTokensByModel")
    return accounting


def observation_scope_label(ledger):
    since = ledger.get("observedSince") or ""
    day = since[:10] if since else ""
    return ("Local session totals (Desktop + CLI on this device); "
            f"day chart and model amounts are observed growth since {day or 'first run'}; "
            "earlier local usage is unattributed")
