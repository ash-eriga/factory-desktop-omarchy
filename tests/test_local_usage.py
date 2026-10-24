"""Fixture-based tests for local Factory session accounting.

Every test scans synthetic session directories inside a temporary HOME —
never the real profiles — and the observation ledger lives in a temporary
cache dir. Session ids in fixtures are synthetic and must never appear in
any produced accounting output or in the persisted ledger bytes.
"""

import json
import os
import re
import stat as stat_module
import tempfile
import time
import unittest
import importlib.util
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SESSION_A = "aaaaaaaa-1111-2222-3333-444444444444"
SESSION_B = "bbbbbbbb-1111-2222-3333-444444444444"
SESSION_C = "cccccccc-1111-2222-3333-444444444444"
SESSION_CHILD = "dddddddd-1111-2222-3333-444444444444"

METADATA_JSONL = (
    '{{"id":"%s","cwd":"/home/user/secret-project","owner":"user_123",'
    '"organizationId":"org_123","title":"Fix the secret feature",'
    '"hostId":"host_abc","version":"0.238.0"}}\n'
)

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


# The accounting module ships twice: in the repository runtime and inside
# the Omarchy service plugin. The two files are copies of each other and
# must not drift, so every corrected scenario below runs against BOTH.
RUNTIME_COPIES = (
    ("repo", ROOT / "runtime" / "local_usage.py"),
    ("service", ROOT / "omarchy" / "factory-usage-service" / "runtime" / "local_usage.py"),
)


def load_module(path=None):
    target = path or (ROOT / "runtime" / "local_usage.py")
    spec = importlib.util.spec_from_file_location("local_usage", target)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_session(sessions_dir, session_id, model, tokens, inclusive=None, children=None):
    sessions_dir.mkdir(parents=True, exist_ok=True)
    metadata = sessions_dir / f"{session_id}.jsonl"
    metadata.write_text(METADATA_JSONL % session_id)
    settings = {"model": model, "tokenUsage": tokens}
    if inclusive is not None:
        settings["inclusiveTokenUsage"] = inclusive
    if children is not None:
        settings["childInclusiveTokenUsageBySessionId"] = children
    (sessions_dir / f"{session_id}.settings.json").write_text(json.dumps(settings))


def tokens(input_=0, output=0, cache_w=0, cache_r=0, thinking=0, credits=0):
    return {
        "inputTokens": input_, "outputTokens": output,
        "cacheCreationTokens": cache_w, "cacheReadTokens": cache_r,
        "thinkingTokens": thinking, "factoryCredits": credits,
    }


class ScanAndDedupTest(unittest.TestCase):
    def setUp(self):
        self.m = load_module()
        self.tmp = tempfile.TemporaryDirectory()
        self.desk = Path(self.tmp.name) / "desktop"
        self.cli = Path(self.tmp.name) / "cli"
        self.profiles = [("desktop", self.desk), ("cli", self.cli)]

    def tearDown(self):
        self.tmp.cleanup()

    def test_scans_own_token_usage_ignoring_inclusive_and_children(self):
        write_session(self.cli, SESSION_A, "claude-sonnet-5",
                      tokens(100, 50, 10, 20, 5, credits=7),
                      inclusive=tokens(1000, 500, 10, 20, 5, credits=70),
                      children={SESSION_CHILD: tokens(900, 450, 0, 0, 0, credits=63)})
        sessions, unreadable = self.m.scan_profiles(self.profiles)
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]["tokens"]["inputTokens"], 100)
        self.assertEqual(sessions[0]["tokens"]["outputTokens"], 50)
        self.assertEqual(sessions[0]["tokens"]["factoryCredits"], 7)

    def test_bak_and_metadata_files_are_skipped(self):
        write_session(self.cli, SESSION_A, "m", tokens(1, 1))
        (self.cli / f"{SESSION_A}.jsonl.bak").write_text("{}")
        (self.cli / f"{SESSION_A}.settings.json.bak").write_text("{}")
        sessions, unreadable = self.m.scan_profiles(self.profiles)
        self.assertEqual(len(sessions), 1)

    def test_unreadable_sessions_are_counted_not_fatal(self):
        self.cli.mkdir(parents=True)
        (self.cli / f"{SESSION_A}.settings.json").write_text("{broken json")
        (self.cli / f"{SESSION_B}.settings.json").write_text('{"model": "m"}')
        write_session(self.cli, SESSION_CHILD, "m", tokens(1, 1))
        sessions, unreadable = self.m.scan_profiles(self.profiles)
        self.assertEqual(len(sessions), 1)
        self.assertEqual(unreadable, 2)

    def test_dedup_keeps_one_coherent_dominating_snapshot(self):
        # Per-counter combining would invent input=1000+output=1000 from two
        # snapshots that each contain 1010 total. The dedup keeps ONE
        # snapshot: the dominating total, never a Frankenstein merge.
        write_session(self.desk, SESSION_A, "m1", tokens(1000, 10, 0, 0, 0, credits=5))
        write_session(self.cli, SESSION_A, "m2", tokens(10, 1000, 0, 0, 0, credits=6))
        deduped = self.m.dedup_sessions(self.m.scan_profiles(self.profiles)[0])
        self.assertEqual(len(deduped), 1)
        combined = deduped[0]["tokens"]
        total = combined["inputTokens"] + combined["outputTokens"]
        self.assertIn(total, (1010,))  # coherent, not 2000
        self.assertIn(combined["factoryCredits"], (5, 6))

    def test_dedup_tie_breaks_to_most_recent_file(self):
        import time as time_module
        write_session(self.desk, SESSION_A, "m1", tokens(100, 10))
        write_session(self.cli, SESSION_A, "m2", tokens(100, 10))
        older = self.cli / f"{SESSION_A}.settings.json"
        newer = self.desk / f"{SESSION_A}.settings.json"
        past = time_module.time() - 100000
        os.utime(older, (past, past))
        deduped = self.m.dedup_sessions(self.m.scan_profiles(self.profiles)[0])
        self.assertEqual(len(deduped), 1)
        self.assertEqual(deduped[0]["model"], "m1")  # the newer file's snapshot


class NestedLayoutTest(unittest.TestCase):
    """Factory nests session settings in per-workspace subdirectories below
    .factory/sessions (the real on-disk layout this user has)."""

    def setUp(self):
        self.m = load_module()
        self.tmp = tempfile.TemporaryDirectory()
        self.cli = Path(self.tmp.name) / "cli"
        self.profiles = [("cli", self.cli)]

    def tearDown(self):
        self.tmp.cleanup()

    def test_nested_workspace_directories_are_scanned(self):
        write_session(self.cli / "workspace-alpha" / "sub" / "deeper", SESSION_A, "m1", tokens(100, 50, 0, 0, 0, credits=2))
        write_session(self.cli / "workspace-beta", SESSION_B, "m2", tokens(10, 5, 0, 0, 0, credits=1))
        sessions, unreadable = self.m.scan_profiles(self.profiles)
        self.assertEqual(len(sessions), 2)
        self.assertEqual(unreadable, 0)

    def test_migration_duplicates_across_subfolders_dedup(self):
        # The same session id appearing under two different workspace
        # subfolders is one session: one coherent snapshot wins.
        write_session(self.cli / "workspace-alpha", SESSION_A, "m1", tokens(1000, 10, 0, 0, 0, credits=5))
        write_session(self.cli / "workspace-beta" / "nested", SESSION_A, "m1", tokens(10, 1000, 0, 0, 0, credits=5))
        sessions = self.m.scan_profiles(self.profiles)[0]
        self.assertEqual(len(sessions), 2)
        deduped = self.m.dedup_sessions(sessions)
        self.assertEqual(len(deduped), 1)
        combined = deduped[0]["tokens"]
        self.assertEqual(combined["inputTokens"] + combined["outputTokens"], 1010)

    def test_directory_symlinks_are_not_followed(self):
        write_session(self.cli / "workspace-real", SESSION_A, "m1", tokens(5, 5))
        # A symlinked "workspace" pointing back at the sessions root would
        # loop a naive walker; it must be skipped, not followed.
        (self.cli / "workspace-loop").symlink_to(self.cli)
        outside = Path(self.tmp.name) / "outside"
        outside.mkdir()
        (self.cli / "workspace-link").symlink_to(outside)
        (outside / f"{SESSION_B}.settings.json").write_text('{"model":"m","tokenUsage":{}}')
        sessions, unreadable = self.m.scan_profiles(self.profiles)
        self.assertEqual(len(sessions), 1)  # only the real workspace's session
        self.assertEqual(sessions[0]["id"], SESSION_A)

    def test_deeply_nested_unreadable_file_counts_not_fatal(self):
        write_session(self.cli / "ws" / "sub", SESSION_A, "m1", tokens(1, 1))
        (self.cli / "ws" / "sub2").mkdir(parents=True, exist_ok=True)
        (self.cli / "ws" / "sub2" / f"{SESSION_B}.settings.json").write_text("{broken")
        sessions, unreadable = self.m.scan_profiles(self.profiles)
        self.assertEqual(len(sessions), 1)
        self.assertEqual(unreadable, 1)

    def test_vendor_total_token_formula(self):
        self.assertEqual(self.m.session_total_tokens(tokens(100, 50, 30, 20, 7)), 207)
        self.assertEqual(self.m.session_total_tokens(tokens()), 0)

    def test_vendor_total_token_formula_matches_js_rounding(self):
        # JS Math.round rounds .5 up; Python round() is banker's rounding.
        # cacheCreation + cacheRead = 2.5 → 3, not 2.
        self.assertEqual(self.m.session_total_tokens(tokens(10, 10, cache_w=1.5, cache_r=1)), 23)
        self.assertEqual(self.m.session_total_tokens(tokens(10, 10, cache_w=1.4, cache_r=1)), 22)
        self.assertEqual(self.m.js_round_positive(0.5), 1)
        self.assertEqual(self.m.js_round_positive(2.5), 3)
        self.assertEqual(self.m.js_round_positive(1.5), 2)

    def test_historical_model_attribution_is_not_fabricated(self):
        # A session that switched models keeps its full past total in the
        # explicit unattributed bucket; observed growth lands in the
        # ledger's day buckets. The final model never receives the past.
        cache = Path(self.tmp.name) / "cache"
        write_session(self.cli, SESSION_A, "model-final",
                      tokens(1000, 500, 0, 0, 0, credits=10))
        accounting = self.m.local_accounting(cache, profiles=self.profiles, now_s=1700000000.0)
        usage = accounting["modelUsage"]
        self.assertNotIn("model-final", usage)  # nothing observed growing yet
        self.assertEqual(usage["unattributed"]["totalTokens"], 1500)
        self.assertEqual(usage["unattributed"]["factoryCredits"], 10)
        # Truthful totals are reported separately and not redistributed.
        self.assertEqual(accounting["totalTokensLocal"], 1500)
        self.assertEqual(accounting["factoryCreditsLocal"], 10)
        self.assertEqual(
            sum(b["totalTokens"] for b in usage.values()),
            accounting["totalTokensLocal"])
        self.assertIn("unattributed", accounting["statsScopeLabel"])

    def test_observed_growth_is_attributed_with_stable_model(self):
        cache = Path(self.tmp.name) / "cache"
        now = 1700000000.0
        write_session(self.cli, SESSION_A, "model-stable", tokens(100, 0, 0, 0, 0, credits=1))
        self.m.local_accounting(cache, profiles=self.profiles, now_s=now)  # seed
        write_session(self.cli, SESSION_A, "model-stable", tokens(400, 50, 0, 0, 0, credits=4))
        accounting = self.m.local_accounting(cache, profiles=self.profiles, now_s=now + 60)
        usage = accounting["modelUsage"]
        self.assertEqual(usage["model-stable"]["totalTokens"], 350)
        self.assertEqual(usage["model-stable"]["factoryCredits"], 3)
        self.assertEqual(usage["unattributed"]["totalTokens"], 100)
        self.assertEqual(accounting["totalTokensLocal"], 450)


class LedgerTest(unittest.TestCase):
    def setUp(self):
        self.m = load_module()
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self.tmp.name) / "cache"
        self.cli = Path(self.tmp.name) / "cli"
        self.profiles = [("cli", self.cli)]
        self.now = 1700000000.0  # fixed observation clock

    def tearDown(self):
        self.tmp.cleanup()

    def ledger(self):
        ledger, _ = self.m.load_ledger(self.cache)
        return ledger

    def test_first_observation_is_baseline_not_a_day_delta(self):
        write_session(self.cli, SESSION_A, "m1", tokens(100, 50, 0, 0, 0, credits=2))
        sessions = self.m.dedup_sessions(self.m.scan_profiles(self.profiles)[0])
        ledger = self.ledger()
        self.m.update_ledger(ledger, sessions, self.now)
        day = ledger["days"].get(self.m.local_date(self.now), {"tokens": 0})
        self.assertEqual(day.get("tokens", 0), 0)
        self.assertTrue(ledger["seeded"])

    def test_session_completed_between_refreshes_is_an_observed_addition(self):
        # The reviewer's reproduction: after seeding, a brand-new session
        # with 100 input tokens / 10 FSC must contribute to the day chart
        # on the DISCOVERY day (not disappear forever, not be backdated).
        write_session(self.cli, SESSION_A, "m1", tokens(100, 50))
        sessions = self.m.dedup_sessions(self.m.scan_profiles(self.profiles)[0])
        ledger = self.ledger()
        self.m.update_ledger(ledger, sessions, self.now)  # seed
        write_session(self.cli, SESSION_B, "m2", tokens(100, 0, 0, 0, 0, credits=10))
        sessions = self.m.dedup_sessions(self.m.scan_profiles(self.profiles)[0])
        self.m.update_ledger(ledger, sessions, self.now + 60)
        day = ledger["days"][self.m.local_date(self.now + 60)]
        self.assertEqual(day["tokens"], 100)
        self.assertEqual(day["credits"], 10)
        self.assertEqual(day["byModel"]["m2"], 100)
        self.assertEqual(day["sessions"], 1)

    def test_delta_counts_growth_once(self):
        write_session(self.cli, SESSION_A, "m1", tokens(100, 50))
        sessions = self.m.dedup_sessions(self.m.scan_profiles(self.profiles)[0])
        ledger = self.ledger()
        self.m.update_ledger(ledger, sessions, self.now)
        write_session(self.cli, SESSION_A, "m1", tokens(400, 90))
        sessions = self.m.dedup_sessions(self.m.scan_profiles(self.profiles)[0])
        self.m.update_ledger(ledger, sessions, self.now + 60)
        day = ledger["days"][self.m.local_date(self.now + 60)]
        self.assertEqual(day["tokens"], 340)
        self.assertEqual(day["byModel"]["m1"], 340)

    def test_rollback_then_recovery_counts_exactly_once(self):
        # The reviewer's reproduction: baseline 100, then 150 (+50), then a
        # rolled-back 50 (no delta), then recovery to 150 (delta 0 — the
        # high-water mark already counted those tokens).
        write_session(self.cli, SESSION_A, "m1", tokens(100, 0, 0, 0, 0, credits=1))
        sessions = self.m.dedup_sessions(self.m.scan_profiles(self.profiles)[0])
        ledger = self.ledger()
        self.m.update_ledger(ledger, sessions, self.now)
        write_session(self.cli, SESSION_A, "m1", tokens(150, 0, 0, 0, 0, credits=2))
        sessions = self.m.dedup_sessions(self.m.scan_profiles(self.profiles)[0])
        self.m.update_ledger(ledger, sessions, self.now + 60)
        write_session(self.cli, SESSION_A, "m1", tokens(50, 0, 0, 0, 0, credits=2))
        sessions = self.m.dedup_sessions(self.m.scan_profiles(self.profiles)[0])
        self.m.update_ledger(ledger, sessions, self.now + 120)
        write_session(self.cli, SESSION_A, "m1", tokens(150, 0, 0, 0, 0, credits=2))
        sessions = self.m.dedup_sessions(self.m.scan_profiles(self.profiles)[0])
        self.m.update_ledger(ledger, sessions, self.now + 180)
        day = ledger["days"][self.m.local_date(self.now)]
        self.assertEqual(day["tokens"], 50)
        self.assertEqual(day["credits"], 1)

    def test_independent_counter_rollbacks(self):
        # Tokens and FSC roll back and recover independently; each counter's
        # high-water mark governs its own deltas.
        write_session(self.cli, SESSION_A, "m1", tokens(100, 100, 0, 0, 0, credits=5))
        sessions = self.m.dedup_sessions(self.m.scan_profiles(self.profiles)[0])
        ledger = self.ledger()
        self.m.update_ledger(ledger, sessions, self.now)
        # FSC grows, tokens roll back.
        write_session(self.cli, SESSION_A, "m1", tokens(40, 100, 0, 0, 0, credits=9))
        sessions = self.m.dedup_sessions(self.m.scan_profiles(self.profiles)[0])
        self.m.update_ledger(ledger, sessions, self.now + 60)
        day = ledger["days"][self.m.local_date(self.now)]
        self.assertEqual(day["tokens"], 0)
        self.assertEqual(day["credits"], 4)
        # Tokens recover to a new high; FSC rolls back.
        write_session(self.cli, SESSION_A, "m1", tokens(260, 100, 0, 0, 0, credits=9))
        sessions = self.m.dedup_sessions(self.m.scan_profiles(self.profiles)[0])
        self.m.update_ledger(ledger, sessions, self.now + 120)
        day = ledger["days"][self.m.local_date(self.now)]
        self.assertEqual(day["tokens"], 160)
        self.assertEqual(day["credits"], 4)

    def test_model_switch_lands_in_mixed_bucket(self):
        write_session(self.cli, SESSION_A, "m1", tokens(100, 0))
        sessions = self.m.dedup_sessions(self.m.scan_profiles(self.profiles)[0])
        ledger = self.ledger()
        self.m.update_ledger(ledger, sessions, self.now)
        write_session(self.cli, SESSION_A, "m2", tokens(300, 0))
        sessions = self.m.dedup_sessions(self.m.scan_profiles(self.profiles)[0])
        self.m.update_ledger(ledger, sessions, self.now + 60)
        day = ledger["days"][self.m.local_date(self.now + 60)]
        self.assertEqual(day["byModel"].get(self.m.MIXED_MODEL_KEY), 200)
        self.assertNotIn("m1", day["byModel"])
        self.assertNotIn("m2", day["byModel"])

    def test_recent_days_seven_rows_with_empty_days(self):
        write_session(self.cli, SESSION_A, "m1", tokens(100, 0))
        sessions = self.m.dedup_sessions(self.m.scan_profiles(self.profiles)[0])
        ledger = self.ledger()
        self.m.update_ledger(ledger, sessions, self.now)
        rows = self.m.recent_days(ledger, self.now)
        self.assertEqual(len(rows), 7)
        self.assertEqual(sum(row["messageCount"] for row in rows), 0)  # baseline only
        self.assertEqual(rows[-1]["date"], self.m.local_date(self.now))

    def test_accounting_shape_and_labels(self):
        write_session(self.cli, SESSION_A, "m1", tokens(100, 50, 0, 0, 0, credits=2))
        accounting = self.m.local_accounting(self.cache, profiles=self.profiles, now_s=self.now)
        self.assertTrue(accounting["hasLocalStats"])
        self.assertFalse(accounting["hasPromptStats"])
        self.assertEqual(accounting["totalSessions"], 1)
        self.assertEqual(accounting["totalTokensLocal"], 150)
        self.assertEqual(accounting["factoryCreditsLocal"], 2)
        self.assertIn("observed growth since", accounting["statsScopeLabel"])
        self.assertIn("Local session totals", accounting["statsScopeLabel"])
        self.assertIn("unattributed", accounting["statsScopeLabel"])
        rows = accounting["recentDays"]
        self.assertEqual(len(rows), 7)

    def test_accounting_never_contains_identifiers(self):
        write_session(self.cli, SESSION_A, "m1", tokens(100, 50, 0, 0, 0, credits=2))
        accounting = self.m.local_accounting(self.cache, profiles=self.profiles, now_s=self.now)
        text = json.dumps(accounting)
        self.assertNotIn(SESSION_A, text)
        self.assertNotIn("user_123", text)
        self.assertNotIn("org_123", text)
        self.assertNotIn("secret-project", text)
        self.assertNotIn("Fix the secret feature", text)

    def test_no_local_sessions_means_empty_accounting(self):
        accounting = self.m.local_accounting(self.cache, profiles=self.profiles, now_s=self.now)
        self.assertEqual(accounting, {})

    def test_local_date_uses_local_calendar(self):
        epoch = 1700000000.0
        self.assertRegex(self.m.local_date(epoch), r"^\d{4}-\d{2}-\d{2}$")


class LedgerStorageTest(unittest.TestCase):
    def setUp(self):
        self.m = load_module()
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self.tmp.name) / "cache"
        self.cli = Path(self.tmp.name) / "cli"
        self.profiles = [("cli", self.cli)]
        self.now = 1700000000.0

    def tearDown(self):
        self.tmp.cleanup()

    def test_persisted_ledger_has_no_raw_ids_and_private_modes(self):
        write_session(self.cli, SESSION_A, "m1", tokens(100, 50, 0, 0, 0, credits=2))
        self.m.local_accounting(self.cache, profiles=self.profiles, now_s=self.now)
        path = self.cache / self.m.LEDGER_FILENAME
        raw = path.read_bytes()
        # Raw session ids never reach the persisted ledger.
        self.assertNotIn(SESSION_A.encode(), raw)
        self.assertNotRegex(raw.decode(), UUID_RE.pattern)
        # Private file and directory modes.
        self.assertEqual(stat_module.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat_module.S_IMODE(self.cache.stat().st_mode), 0o700)

    def test_store_leaves_no_temp_files_behind(self):
        write_session(self.cli, SESSION_A, "m1", tokens(100, 0))
        for _ in range(3):
            self.m.local_accounting(self.cache, profiles=self.profiles, now_s=self.now)
        names = sorted(p.name for p in self.cache.iterdir())
        self.assertEqual(names, [self.m.LEDGER_FILENAME])

    def test_hashed_keys_are_stable_across_runs(self):
        write_session(self.cli, SESSION_A, "m1", tokens(100, 0))
        self.m.local_accounting(self.cache, profiles=self.profiles, now_s=self.now)
        first = json.loads((self.cache / self.m.LEDGER_FILENAME).read_text())
        self.m.local_accounting(self.cache, profiles=self.profiles, now_s=self.now + 60)
        second = json.loads((self.cache / self.m.LEDGER_FILENAME).read_text())
        self.assertEqual(sorted(first["observations"]), sorted(second["observations"]))
        self.assertEqual(len(first["observations"]), 1)
        key = next(iter(second["observations"]))
        self.assertEqual(key, self.m.session_key(SESSION_A))
        self.assertNotEqual(key, SESSION_A)


class CorrectedAccountingTest(unittest.TestCase):
    """Regressions for the confirmed accounting findings.

    Every scenario runs against both copies of the module (repository
    runtime and service plugin runtime) with its own ledger, so a fix that
    lands in only one of them fails here.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.now = 1700000000.0  # fixed observation clock

    def tearDown(self):
        self.tmp.cleanup()

    def copies(self):
        """(name, module, cache dir, profiles) for every shipped copy of the
        module. Each copy gets its own session tree and its own ledger, so
        one copy's state can never influence the next."""
        result = []
        for name, path in RUNTIME_COPIES:
            cli = self.base / ("cli-" + name)
            result.append((name, load_module(path), self.base / ("cache-" + name),
                           [("cli", cli)]))
        return result

    def scan(self, module, profiles):
        return module.dedup_sessions(module.scan_profiles(profiles)[0])

    # -- finding: a newly discovered session was counted twice -------------

    def check_discovery_counts_once_per_day(self, module, cache, profiles):
        cli = profiles[0][1]
        write_session(cli, SESSION_A, "m1", tokens(100, 50))
        ledger, _ = module.load_ledger(cache)
        module.update_ledger(ledger, self.scan(module, profiles), self.now)  # seed
        # A session discovered after the seed counts as activity today.
        write_session(cli, SESSION_B, "m2", tokens(100, 0, credits=10))
        module.update_ledger(ledger, self.scan(module, profiles), self.now + 60)
        # The very same session grows later the SAME day: that is growth,
        # not a second active session.
        write_session(cli, SESSION_B, "m2", tokens(150, 0, credits=12))
        module.update_ledger(ledger, self.scan(module, profiles), self.now + 120)
        today = ledger["days"][module.local_date(self.now)]
        self.assertEqual(today["sessions"], 1,
                         "one session active today must count once")
        self.assertEqual(today["tokens"], 150)
        self.assertEqual(today["credits"], 12)
        # The next day counts the session again (day-change contract).
        write_session(cli, SESSION_B, "m2", tokens(200, 0, credits=14))
        module.update_ledger(ledger, self.scan(module, profiles), self.now + 86400)
        tomorrow = ledger["days"][module.local_date(self.now + 86400)]
        self.assertEqual(tomorrow["sessions"], 1)
        self.assertEqual(tomorrow["tokens"], 50)

    def test_discovered_session_counts_once_per_day(self):
        for name, module, cache, profiles in self.copies():
            with self.subTest(copy=name):
                self.check_discovery_counts_once_per_day(module, cache, profiles)

    # -- finding: the daily retention erased the per-model totals ---------

    def check_model_totals_survive_retention(self, module, cache, profiles):
        cli = profiles[0][1]
        write_session(cli, SESSION_A, "m1", tokens(100, 50, credits=2))
        module.local_accounting(cache, profiles=profiles, now_s=self.now)
        write_session(cli, SESSION_A, "m1", tokens(400, 90, credits=5))
        before = module.local_accounting(cache, profiles=profiles, now_s=self.now + 60)
        self.assertEqual(before["modelUsage"]["m1"]["totalTokens"], 340)
        self.assertEqual(before["modelUsage"]["m1"]["factoryCredits"], 3)
        # 100 days later the day buckets fall out of the retention window.
        after = module.local_accounting(cache, profiles=profiles,
                                        now_s=self.now + 100 * 86400)
        self.assertEqual(after["modelUsage"]["m1"]["totalTokens"], 340,
                         "per-model totals must survive the daily retention")
        self.assertEqual(after["modelUsage"]["m1"]["factoryCredits"], 3)
        # The device total never changed either.
        self.assertEqual(after["totalTokensLocal"], before["totalTokensLocal"])

    def test_model_totals_survive_daily_retention(self):
        for name, module, cache, profiles in self.copies():
            with self.subTest(copy=name):
                self.check_model_totals_survive_retention(module, cache, profiles)

    def check_growth_after_retention_is_still_counted(self, module, cache, profiles):
        cli = profiles[0][1]
        write_session(cli, SESSION_A, "m1", tokens(100, 50, credits=2))
        module.local_accounting(cache, profiles=profiles, now_s=self.now)
        write_session(cli, SESSION_A, "m1", tokens(400, 90, credits=5))
        module.local_accounting(cache, profiles=profiles, now_s=self.now + 60)
        # The retention window drops the old day buckets...
        later = self.now + 100 * 86400
        module.local_accounting(cache, profiles=profiles, now_s=later)
        # ...and growth observed afterwards is still observed growth.
        write_session(cli, SESSION_A, "m1", tokens(500, 90, credits=6))
        grown = module.local_accounting(cache, profiles=profiles, now_s=later + 60)
        self.assertEqual(grown["modelUsage"]["m1"]["totalTokens"], 440)
        self.assertEqual(grown["modelUsage"]["m1"]["factoryCredits"], 4)
        self.assertEqual(grown["todayTotalTokens"], 100)
        self.assertEqual(grown["todayTokensByModel"]["m1"], 100)

    def test_growth_after_retention_is_still_counted(self):
        for name, module, cache, profiles in self.copies():
            with self.subTest(copy=name):
                self.check_growth_after_retention_is_still_counted(module, cache, profiles)

    # -- finding: legacy ledgers must migrate without double counting ------

    def check_legacy_ledger_migrates_in_place(self, module, cache, profiles):
        cli = profiles[0][1]
        write_session(cli, SESSION_A, "m1", tokens(100, 50))
        ledger, path = module.load_ledger(cache)
        module.update_ledger(ledger, self.scan(module, profiles), self.now)  # seed
        write_session(cli, SESSION_A, "m1", tokens(300, 50))
        module.update_ledger(ledger, self.scan(module, profiles), self.now + 60)
        module.store_ledger(path, ledger, self.now + 60)
        # Rewrite the persisted ledger the way an older module would have
        # written it: without the persistent per-model accumulator.
        persisted = json.loads(path.read_text())
        persisted.pop("modelTotals", None)
        path.write_text(json.dumps(persisted))
        reloaded, path = module.load_ledger(cache)
        self.assertNotIn("modelTotals", reloaded)
        # Before the migration the day buckets are still the only source.
        self.assertEqual(module.build_model_usage(reloaded)["m1"]["totalTokens"], 200)
        # The next update migrates the ledger in place, without recounting
        # what the day buckets already carry.
        module.update_ledger(reloaded, self.scan(module, profiles), self.now + 120)
        self.assertEqual(reloaded["modelTotals"]["m1"]["totalTokens"], 200)
        self.assertEqual(module.build_model_usage(reloaded)["m1"]["totalTokens"], 200)
        # And the migrated ledger survives a reload with the same numbers.
        module.store_ledger(path, reloaded, self.now + 120)
        again, _ = module.load_ledger(cache)
        self.assertEqual(module.build_model_usage(again)["m1"]["totalTokens"], 200)

    def test_legacy_ledger_migrates_in_place_without_double_counting(self):
        for name, module, cache, profiles in self.copies():
            with self.subTest(copy=name):
                self.check_legacy_ledger_migrates_in_place(module, cache, profiles)

    # -- finding: fractional cumulative caches diverged from the total ----

    def check_fractional_cache_growth_counts_once(self, module, cache, profiles):
        cli = profiles[0][1]
        # The vendor total is a ROUNDED function of the cumulative
        # counters: a cache counter that moves 0 -> 0.5 -> 1 is ONE token
        # of total growth, not two.
        write_session(cli, SESSION_A, "m1", tokens(10, 0, 0, 0))
        base = module.local_accounting(cache, profiles=profiles, now_s=self.now)
        self.assertEqual(base["totalTokensLocal"], 10)
        write_session(cli, SESSION_A, "m1", tokens(10, 0, 0, 0.5))
        middle = module.local_accounting(cache, profiles=profiles, now_s=self.now + 60)
        self.assertEqual(middle["totalTokensLocal"], 11)
        write_session(cli, SESSION_A, "m1", tokens(10, 0, 0, 1))
        end = module.local_accounting(cache, profiles=profiles, now_s=self.now + 120)
        self.assertEqual(end["totalTokensLocal"], 11)
        # The ledger counted exactly the growth the device total shows.
        self.assertEqual(end["todayTotalTokens"], 1)
        self.assertEqual(end["modelUsage"]["m1"]["totalTokens"], 1)

    def test_fractional_cache_growth_counts_once(self):
        for name, module, cache, profiles in self.copies():
            with self.subTest(copy=name):
                self.check_fractional_cache_growth_counts_once(module, cache, profiles)

    # -- finding: total, ledger, day and model must agree ----------------

    def check_totals_ledger_day_and_model_agree(self, module, cache, profiles):
        cli = profiles[0][1]
        write_session(cli, SESSION_A, "m1", tokens(100, 50, credits=2))
        write_session(cli, SESSION_B, "m2", tokens(30, 0, credits=1))
        base = module.local_accounting(cache, profiles=profiles, now_s=self.now)
        write_session(cli, SESSION_A, "m1", tokens(400, 90, credits=5))
        write_session(cli, SESSION_B, "m2", tokens(30, 0, credits=3))
        end = module.local_accounting(cache, profiles=profiles, now_s=self.now + 60)
        # The device total is the sum of the per-model amounts plus the
        # unattributed baseline.
        attributed = sum(bucket["totalTokens"] for bucket in end["modelUsage"].values())
        self.assertEqual(attributed, end["totalTokensLocal"])
        credits = sum(bucket["factoryCredits"] for bucket in end["modelUsage"].values())
        self.assertAlmostEqual(credits, end["factoryCreditsLocal"], places=4)
        # The day bucket carries the same observed growth.
        self.assertEqual(end["todayTotalTokens"], 340)
        self.assertEqual(end["todayTokensByModel"]["m1"], 340)
        # And the growth equals the difference of the device totals.
        self.assertEqual(end["totalTokensLocal"] - base["totalTokensLocal"], 340)

    def test_totals_ledger_day_and_model_agree(self):
        for name, module, cache, profiles in self.copies():
            with self.subTest(copy=name):
                self.check_totals_ledger_day_and_model_agree(module, cache, profiles)

    # -- finding: one counter growing while another rolls back ------------

    def check_independent_counter_growth_is_not_hidden(self, module, cache, profiles):
        cli = profiles[0][1]
        # Baseline: 100 input / 100 output.
        write_session(cli, SESSION_A, "m1", tokens(100, 100))
        module.local_accounting(cache, profiles=profiles, now_s=self.now)
        # The output counter grows by 50 while the input counter rolls back.
        # The 50 new tokens were really consumed: they belong to the day
        # they were observed.
        write_session(cli, SESSION_A, "m1", tokens(0, 150))
        grown = module.local_accounting(cache, profiles=profiles, now_s=self.now + 60)
        self.assertEqual(grown["todayTotalTokens"], 50,
                         "the growth of the counter that grew must count on the day it was observed")
        self.assertEqual(grown["todayTokensByModel"]["m1"], 50)
        # The next day only RECOVERS the rolled-back counter. No counter
        # passed its own maximum, so that day must stay empty.
        write_session(cli, SESSION_A, "m1", tokens(100, 150))
        recovered = module.local_accounting(cache, profiles=profiles, now_s=self.now + 86400)
        self.assertEqual(recovered["todayTotalTokens"], 0,
                         "a recovery below the high-water mark must not be counted")
        # And without any recovery the growth stays on its own day.
        self.assertEqual(recovered["modelUsage"]["m1"]["totalTokens"], 50)

    def test_independent_counter_growth_is_not_hidden(self):
        for name, module, cache, profiles in self.copies():
            with self.subTest(copy=name):
                self.check_independent_counter_growth_is_not_hidden(module, cache, profiles)

    def check_growth_without_recovery_stays_on_its_day(self, module, cache, profiles):
        cli = profiles[0][1]
        write_session(cli, SESSION_A, "m1", tokens(100, 100))
        module.local_accounting(cache, profiles=profiles, now_s=self.now)
        write_session(cli, SESSION_A, "m1", tokens(0, 150))
        module.local_accounting(cache, profiles=profiles, now_s=self.now + 60)
        # The rolled-back counter never recovers: nothing is observed on
        # the following days, and the growth is not lost either.
        write_session(cli, SESSION_A, "m1", tokens(0, 150))
        later = module.local_accounting(cache, profiles=profiles, now_s=self.now + 2 * 86400)
        self.assertEqual(later["todayTotalTokens"], 0)
        self.assertEqual(later["modelUsage"]["m1"]["totalTokens"], 50,
                         "the observed growth must survive in the per-model accumulator")
        # The persisted ledger agrees with the report.
        ledger = json.loads((cache / module.LEDGER_FILENAME).read_text())
        first_day = ledger["days"][module.local_date(self.now + 60)]
        self.assertEqual(first_day["tokens"], 50)
        self.assertEqual(first_day["byModel"]["m1"], 50)

    def test_growth_without_recovery_stays_on_its_day(self):
        for name, module, cache, profiles in self.copies():
            with self.subTest(copy=name):
                self.check_growth_without_recovery_stays_on_its_day(module, cache, profiles)

    def check_legacy_ledger_without_hw_total_keeps_the_growth(self, module, cache, profiles):
        cli = profiles[0][1]
        write_session(cli, SESSION_A, "m1", tokens(100, 100))
        module.local_accounting(cache, profiles=profiles, now_s=self.now)
        # A ledger written before the total high-water mark existed: the
        # per-counter marks are the only baseline there is.
        ledger_path = cache / module.LEDGER_FILENAME
        ledger = json.loads(ledger_path.read_text())
        for obs in ledger["observations"].values():
            obs.pop("hwTotal", None)
        ledger_path.write_text(json.dumps(ledger))
        write_session(cli, SESSION_A, "m1", tokens(0, 150))
        grown = module.local_accounting(cache, profiles=profiles, now_s=self.now + 60)
        self.assertEqual(grown["todayTotalTokens"], 50,
                         "a ledger without hwTotal must still count the independent growth")
        write_session(cli, SESSION_A, "m1", tokens(100, 150))
        recovered = module.local_accounting(cache, profiles=profiles, now_s=self.now + 86400)
        self.assertEqual(recovered["todayTotalTokens"], 0,
                         "the recovery must not be counted either")

    def test_legacy_ledger_without_hw_total_keeps_the_growth(self):
        for name, module, cache, profiles in self.copies():
            with self.subTest(copy=name):
                self.check_legacy_ledger_without_hw_total_keeps_the_growth(module, cache, profiles)

    def check_statistics_date_is_the_local_day(self, module, cache, profiles):
        cli = profiles[0][1]
        write_session(cli, SESSION_A, "m1", tokens(100, 50))
        accounting = module.local_accounting(cache, profiles=profiles, now_s=self.now)
        self.assertEqual(accounting["statsDate"], module.local_date(self.now),
                         "the accounting must carry the local day its counters belong to")
        # The day is the local calendar day, not the UTC one.
        later = module.local_accounting(cache, profiles=profiles, now_s=self.now + 86400)
        self.assertEqual(later["statsDate"], module.local_date(self.now + 86400))

    def test_statistics_date_is_the_local_day(self):
        for name, module, cache, profiles in self.copies():
            with self.subTest(copy=name):
                self.check_statistics_date_is_the_local_day(module, cache, profiles)

    # -- the two shipped copies must stay identical ----------------------

    def test_shipped_copies_are_identical(self):
        repo = (ROOT / "runtime" / "local_usage.py").read_bytes()
        service = (ROOT / "omarchy" / "factory-usage-service" / "runtime"
                   / "local_usage.py").read_bytes()
        self.assertEqual(repo, service,
                         "the service copy of the accounting module must not drift")


class CivilCalendarDayTest(unittest.TestCase):
    """The day chart rows are CALENDAR days, not blocks of 86400 seconds.

    A civil day lasts 23 or 25 hours on the days the clock changes, so
    subtracting 86400 seconds from the timestamp repeated the same local
    date (or skipped one) around the change. Every scenario runs against
    both shipped copies of the module, in a timezone set by the test
    itself and restored afterwards: the machine's own timezone and
    configuration are never touched.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.original_tz = os.environ.get("TZ")

    def tearDown(self):
        if self.original_tz is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = self.original_tz
        time.tzset()
        self.tmp.cleanup()

    def in_timezone(self, name):
        os.environ["TZ"] = name
        time.tzset()

    def check_rows_are_consecutive_calendar_days(self, module, now, last, first):
        rows = module.recent_days({}, now)
        dates = [row["date"] for row in rows]
        self.assertEqual(len(dates), 7, "the chart keeps the same number of rows")
        self.assertEqual(len(set(dates)), 7,
                         "the same local date must not appear twice: %s" % dates)
        self.assertEqual(dates[-1], last, "the last row is today")
        self.assertEqual(dates[0], first, "the rows are consecutive calendar days")
        self.assertEqual(dates, sorted(dates), "the rows keep their order")

    def test_the_autumn_change_does_not_repeat_the_day(self):
        for name, path in RUNTIME_COPIES:
            with self.subTest(copy=name):
                module = load_module(path)
                self.in_timezone("America/New_York")
                # 23:30 on the day the clock goes back: 86400 seconds
                # earlier is still the same local date.
                now = datetime(2026, 11, 1, 23, 30).timestamp()
                self.check_rows_are_consecutive_calendar_days(
                    module, now, "2026-11-01", "2026-10-26")

    def test_the_spring_change_does_not_skip_the_day(self):
        for name, path in RUNTIME_COPIES:
            with self.subTest(copy=name):
                module = load_module(path)
                self.in_timezone("America/New_York")
                # 00:30 on the day the clock goes forward: 86400 seconds
                # earlier is already the next local date.
                now = datetime(2026, 3, 9, 0, 30).timestamp()
                self.check_rows_are_consecutive_calendar_days(
                    module, now, "2026-03-09", "2026-03-03")

    def test_the_same_instants_in_utc_are_unaffected(self):
        for name, path in RUNTIME_COPIES:
            with self.subTest(copy=name):
                module = load_module(path)
                self.in_timezone("UTC")
                now = datetime(2026, 11, 1, 23, 30).timestamp()
                self.check_rows_are_consecutive_calendar_days(
                    module, now, "2026-11-01", "2026-10-26")

    def check_the_collector_reports_the_day_once(self, module, cache, profiles, now):
        cli = profiles[0][1]
        write_session(cli, SESSION_A, "m1", tokens(100, 0))
        module.local_accounting(cache, profiles=profiles, now_s=now - 60)
        write_session(cli, SESSION_A, "m1", tokens(110, 0))
        record = module.local_accounting(cache, profiles=profiles, now_s=now)
        rows = record["recentDays"]
        dates = [row["date"] for row in rows]
        self.assertEqual(len(set(dates)), 7,
                         "the collected chart must not repeat a date: %s" % dates)
        self.assertEqual(dates.count("2026-11-01"), 1)
        self.assertEqual(record["todayTotalTokens"], 10)
        self.assertEqual(record["statsDate"], "2026-11-01")
        self.assertEqual(sum(row["messageCount"] for row in rows
                              if row["date"] == "2026-11-01"), 10,
                         "the day must carry its own total, not twice it")

    def test_the_collector_does_not_double_the_day_around_the_change(self):
        self.in_timezone("America/New_York")
        now = datetime(2026, 11, 1, 23, 30).timestamp()
        for name, path in RUNTIME_COPIES:
            with self.subTest(copy=name):
                module = load_module(path)
                cache = self.base / ("cache-" + name)
                profiles = [("cli", self.base / ("cli-" + name))]
                self.check_the_collector_reports_the_day_once(
                    module, cache, profiles, now)

    def test_the_day_rows_cross_a_month_a_year_and_a_leap_day(self):
        for name, path in RUNTIME_COPIES:
            with self.subTest(copy=name):
                module = load_module(path)
                self.in_timezone("UTC")
                # The calendar walk crosses the boundaries that a fixed
                # number of seconds would blur.
                for now, today, previous in (
                        (datetime(2024, 3, 1, 12), "2024-03-01", "2024-02-29"),
                        (datetime(2025, 1, 1, 12), "2025-01-01", "2024-12-31"),
                        (datetime(2023, 3, 1, 12), "2023-03-01", "2023-02-28"),
                        (datetime(2024, 12, 31, 12), "2024-12-31", "2024-12-30")):
                    dates = [row["date"] for row in module.recent_days({}, now.timestamp())]
                    self.assertEqual(len(dates), 7)
                    self.assertEqual(len(set(dates)), 7, dates)
                    self.assertEqual(dates[-1], today)
                    self.assertIn(previous, dates, "the day before today must be there: %s" % dates)


class LedgerFieldTest(unittest.TestCase):
    """The ledger does not persist a second representation of the envelope.

    The legacy "hwTotal" field had no reader left: the observed growth
    comes from the per-counter envelope, and the reader that used to read
    it falls back to that very envelope. Every scenario runs against both
    shipped copies of the module.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.now = 1700000000.0  # fixed observation clock

    def tearDown(self):
        self.tmp.cleanup()

    def copies(self):
        result = []
        for name, path in RUNTIME_COPIES:
            result.append((name, load_module(path), self.base / ("cache-" + name),
                           [("cli", self.base / ("cli-" + name))]))
        return result

    def check_the_field_is_not_written_anymore(self, module, cache, profiles):
        cli = profiles[0][1]
        write_session(cli, SESSION_A, "m1", tokens(100, 100))
        module.local_accounting(cache, profiles=profiles, now_s=self.now)
        path = cache / module.LEDGER_FILENAME
        ledger = json.loads(path.read_text())
        self.assertTrue(ledger["observations"])
        for obs in ledger["observations"].values():
            self.assertNotIn("hwTotal", obs,
                             "the ledger must not persist the second representation")
        # The growth itself is untouched by the removal.
        write_session(cli, SESSION_A, "m1", tokens(0, 150))
        grown = module.local_accounting(cache, profiles=profiles, now_s=self.now + 60)
        self.assertEqual(grown["todayTotalTokens"], 50)
        ledger = json.loads(path.read_text())
        for obs in ledger["observations"].values():
            self.assertNotIn("hwTotal", obs)
            self.assertIn("hw", obs, "the per-counter envelope stays")

    def test_the_field_is_not_written_anymore(self):
        for name, module, cache, profiles in self.copies():
            with self.subTest(copy=name):
                self.check_the_field_is_not_written_anymore(module, cache, profiles)

    def check_the_legacy_field_is_discarded_everywhere(self, module, cache, profiles):
        cli = profiles[0][1]
        write_session(cli, SESSION_A, "m1", tokens(100, 100))
        write_session(cli, SESSION_B, "m2", tokens(50, 50))
        module.local_accounting(cache, profiles=profiles, now_s=self.now)
        path = cache / module.LEDGER_FILENAME
        ledger = json.loads(path.read_text())
        self.assertEqual(len(ledger["observations"]), 2)
        # A ledger written by an older module: every observation carries
        # the second representation.
        for obs in ledger["observations"].values():
            obs["hwTotal"] = 999
        path.write_text(json.dumps(ledger))
        # The session of one of them goes away: the next scan does not
        # visit that observation, and the stale field must be discarded
        # from it anyway.
        (cli / f"{SESSION_B}.settings.json").unlink()
        (cli / f"{SESSION_B}.jsonl").unlink()
        module.local_accounting(cache, profiles=profiles, now_s=self.now + 60)
        ledger = json.loads(path.read_text())
        self.assertEqual(len(ledger["observations"]), 2,
                         "the ledger keeps the observation of the inactive session")
        for obs in ledger["observations"].values():
            self.assertNotIn("hwTotal", obs,
                             "the legacy field must be discarded from every observation")
            # Nothing else of the observation is touched.
            self.assertIn("hw", obs)
            self.assertIn("model", obs)
            self.assertIn("ts", obs)

    def test_the_legacy_field_is_discarded_from_every_observation(self):
        for name, module, cache, profiles in self.copies():
            with self.subTest(copy=name):
                self.check_the_legacy_field_is_discarded_everywhere(module, cache, profiles)

    def check_repeated_runs_do_not_drift(self, module, cache, profiles):
        cli = profiles[0][1]
        write_session(cli, SESSION_A, "m1", tokens(100, 100))
        module.local_accounting(cache, profiles=profiles, now_s=self.now)
        path = cache / module.LEDGER_FILENAME
        first = json.loads(path.read_text())
        module.local_accounting(cache, profiles=profiles, now_s=self.now + 120)
        second = json.loads(path.read_text())
        self.assertEqual(first["days"], second["days"],
                         "the day buckets must not drift between two runs")
        self.assertEqual(first["modelTotals"], second["modelTotals"],
                         "the per-model accumulator must not drift between two runs")
        for obs in second["observations"].values():
            self.assertNotIn("hwTotal", obs)

    def test_repeated_runs_do_not_drift(self):
        for name, module, cache, profiles in self.copies():
            with self.subTest(copy=name):
                self.check_repeated_runs_do_not_drift(module, cache, profiles)


if __name__ == "__main__":
    unittest.main()
