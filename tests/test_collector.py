"""Fixture-based tests for the Factory usage collector.

Run with: python3 -m unittest discover -s tests -p 'test_*.py'
Every test runs offline against synthetic fixtures; no helper process is
spawned and no real credentials, home directories, or network are touched.
"""

import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"


def load_collector():
    spec = importlib.util.spec_from_file_location(
        "collector", ROOT / "runtime" / "collector.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fixture(name):
    return json.loads((FIXTURES / name).read_text())


class NormalizationTest(unittest.TestCase):
    def setUp(self):
        self.c = load_collector()
        # Fixed clock inside every window.
        self.now = time.mktime(time.strptime("2026-10-11T12:00:00", "%Y-%m-%dT%H:%M:%S"))

    def test_percent_and_reset_normalization(self):
        metrics = fixture("limits-ok.json")
        record = self.c.build_record(metrics, now_s=self.now)
        self.assertTrue(record["ready"])
        self.assertEqual(record["id"], "factory")
        self.assertEqual(record["schemaVersion"], 1)
        by_label = {entry["label"]: entry for entry in record["limits"]}
        self.assertIn("5-Hour", by_label)
        self.assertIn("Weekly", by_label)
        self.assertIn("Monthly", by_label)
        self.assertIn("Core 5-Hour", by_label)
        # 42.5% used, window active: 0.425 with a reset time.
        self.assertAlmostEqual(by_label["5-Hour"]["percent"], 0.425)
        self.assertEqual(by_label["5-Hour"]["resetsAt"], "2026-10-11T16:00:00Z")
        # Expired window: not active consumption, so zero and no reset.
        self.assertEqual(by_label["Weekly"]["percent"], 0.0)
        self.assertNotIn("resetsAt", by_label["Weekly"])
        # Above 100% is clamped.
        self.assertEqual(by_label["Monthly"]["percent"], 1.0)

    def test_expired_windows_report_zero(self):
        metrics = fixture("limits-expired.json")
        record = self.c.build_record(metrics, now_s=self.now)
        for entry in record["limits"]:
            self.assertEqual(entry["percent"], 0.0)
            self.assertNotIn("resetsAt", entry)

    def test_missing_window_is_not_active(self):
        metrics = fixture("limits-notstarted.json")
        record = self.c.build_record(metrics, now_s=self.now)
        for entry in record["limits"]:
            self.assertEqual(entry["percent"], 0.0)
            self.assertNotIn("resetsAt", entry)

    def test_balance_from_cents(self):
        metrics = fixture("limits-ok.json")
        record = self.c.build_record(metrics, now_s=self.now)
        # 4500 cents of prepaid extra usage.
        self.assertEqual(record["balance"], {"remaining": 45.0, "currency": "USD", "estimated": False})

    def test_no_balance_when_absent_or_zero(self):
        self.assertIsNone(self.c.normalize_balance({"extraUsageBalanceCents": None}))
        self.assertIsNone(self.c.normalize_balance({"extraUsageBalanceCents": 0}))
        self.assertIsNone(self.c.normalize_balance({"extraUsageBalanceCents": -5}))
        self.assertIsNone(self.c.normalize_balance({}))
        record = self.c.build_record({"standard": None, "core": None}, now_s=self.now)
        self.assertNotIn("balance", record)

    def test_limits_have_explicit_titles_and_groups(self):
        metrics = fixture("limits-ok.json")
        record = self.c.build_record(metrics, now_s=self.now)
        groups = [entry.get("group") for entry in record["limits"]]
        titles = [entry.get("title") for entry in record["limits"]]
        # Pools are explicitly identified and ordered STANDARD first.
        self.assertEqual(groups[:3], ["STANDARD", "STANDARD", "STANDARD"])
        self.assertEqual(groups[3:], ["DROID CORE", "DROID CORE", "DROID CORE"])
        self.assertEqual(titles, ["5-hour", "Weekly", "Monthly"] * 2)
        for entry in record["limits"]:
            self.assertIn(entry["group"], ("STANDARD", "DROID CORE"))
            self.assertTrue(entry["title"])

    def test_tier_labels_grounded_and_mechanical(self):
        self.assertEqual(self.c.tier_label("team"), "Pro")
        self.assertEqual(self.c.tier_label("team_annual"), "Pro")
        self.assertEqual(self.c.tier_label("teams"), "Teams")
        self.assertEqual(self.c.tier_label("pro_plus"), "Pro Plus")
        self.assertEqual(self.c.tier_label("max"), "Max")
        self.assertEqual(self.c.tier_label(None), "")

    def test_status_text_reports_pools_without_mode_claims(self):
        # Returns (status, help): a healthy account is QUIET (empty strings)
        # so the panel shows the plan and draws no blank warning box.
        self.assertEqual(
            self.c.usage_status_text(False, False, (0.1, "5-Hour")), ("", ""))
        self.assertEqual(
            self.c.usage_status_text(True, False, (1.0, "5-Hour")),
            ("Standard pool exhausted.",
             "The standard allowance is used up for this window. Wait for "
             "the reset shown below, switch to Droid Core, or use prepaid "
             "Extra Usage if available."))
        self.assertEqual(
            self.c.usage_status_text(False, True, (1.0, "Core 5-Hour"))[0],
            "Droid Core pool exhausted.")
        self.assertEqual(
            self.c.usage_status_text(True, True, (1.0, "Core 5-Hour"))[0],
            "Standard and Droid Core pools are exhausted.")
        # Standard-low / Core-full: Core exhaustion is named, not Standard.
        self.assertEqual(
            self.c.usage_status_text(False, True, (0.1, "5-Hour"))[0],
            "Droid Core pool exhausted.")
        # Warnings name the actual bucket and always carry a help text (the
        # panel renders the help inside the warning card).
        status, help_text = self.c.usage_status_text(False, False, (0.75, "Weekly"))
        self.assertEqual(status, "Weekly is at 75%.")
        self.assertNotEqual(help_text, "")
        status, help_text = self.c.usage_status_text(False, False, (0.75, "Core Weekly"))
        self.assertEqual(status, "Core Weekly is at 75%.")
        self.assertNotEqual(help_text, "")

    def test_quiet_success_record_shows_plan_not_blank_card(self):
        metrics = fixture("limits-ok.json")
        # All buckets comfortably active and below 70%: adjust the fixture's
        # 133.4% monthly by using the expired fixture's standard-only shape.
        quiet_metrics = fixture("limits-notstarted.json")
        record = self.c.build_record(quiet_metrics, now_s=self.now)
        self.assertEqual(record["usageStatusText"], "")
        self.assertEqual(record["authHelpText"], "")
        self.assertEqual(record["tierLabel"], "Max")
        self.assertTrue(record["ready"])

    def test_warning_record_pairs_status_with_help(self):
        metrics = fixture("limits-ok.json")
        record = self.c.build_record(metrics, now_s=self.now)
        if record["usageStatusText"]:
            self.assertNotEqual(record["authHelpText"], "")

    def test_standard_low_core_full_reports_core(self):
        metrics = fixture("limits-core-full.json")
        record = self.c.build_record(metrics, now_s=self.now)
        self.assertIn("Droid Core pool exhausted", record["usageStatusText"])
        self.assertNotIn("Standard pool exhausted", record["usageStatusText"])
        self.assertNotEqual(record["authHelpText"], "")
        core_entry = next(e for e in record["limits"] if e["label"] == "Core 5-Hour")
        self.assertEqual(core_entry["percent"], 1.0)
        standard_entry = next(e for e in record["limits"] if e["label"] == "5-Hour")
        self.assertAlmostEqual(standard_entry["percent"], 0.1)

    def test_record_has_no_account_identifiers(self):
        metrics = fixture("limits-ok.json")
        metrics["token"] = "super-secret-token-value"
        metrics["email"] = "person@example.com"
        metrics["orgId"] = "org_123"
        record = self.c.build_record(metrics, now_s=self.now)
        text = json.dumps(record)
        for forbidden in ("super-secret-token-value", "person@example.com",
                          "org_123", "Bearer ", "Authorization"):
            self.assertNotIn(forbidden, text)
        self.assertNotRegex(text, r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

    def test_account_session_inventory_passthrough_is_scoped_and_incomplete(self):
        metrics = fixture("limits-ok.json")
        metrics["accountRecentSessions"] = {
            "requestedLimit": 20, "sessionCount": 12, "creditsSampleTotal": 45.6,
            "unknownOwnerRows": 1, "hasMore": True, "complete": False,
            "scope": "recent sample of the account session inventory; not a total account ledger",
        }
        record = self.c.build_record(metrics, now_s=self.now)
        inventory = record["accountRecentSessions"]
        self.assertFalse(inventory["complete"])
        self.assertEqual(inventory["creditsSampleTotal"], 45.6)
        self.assertEqual(inventory["unknownOwnerRows"], 1)
        self.assertIn("recent sample", inventory["scope"])
        text = json.dumps(record)
        self.assertNotRegex(text, r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

    def test_account_session_inventory_zero_sample_stays_zero(self):
        metrics = fixture("limits-ok.json")
        metrics["accountRecentSessions"] = {
            "requestedLimit": 20, "sessionCount": 0, "creditsSampleTotal": 0,
            "unknownOwnerRows": 3, "hasMore": False, "complete": False,
        }
        record = self.c.build_record(metrics, now_s=self.now)
        inventory = record["accountRecentSessions"]
        # A real zero survives; it is not silently turned into absence.
        self.assertEqual(inventory["sessionCount"], 0)
        self.assertEqual(inventory["creditsSampleTotal"], 0)
        self.assertEqual(inventory["unknownOwnerRows"], 3)

    def test_account_session_inventory_missing_value_stays_missing(self):
        metrics = fixture("limits-ok.json")
        metrics["accountRecentSessions"] = {"sessionCount": 5, "hasMore": True}
        record = self.c.build_record(metrics, now_s=self.now)
        inventory = record["accountRecentSessions"]
        # Missing values stay missing - never fabricated to 0.
        self.assertNotIn("creditsSampleTotal", inventory)
        self.assertNotIn("unknownOwnerRows", inventory)
        self.assertEqual(inventory["sessionCount"], 5)

    def test_account_session_inventory_scope_rejects_identifiers(self):
        metrics = fixture("limits-ok.json")
        metrics["accountRecentSessions"] = {
            "sessionCount": 5,
            "scope": "sample for org_123 / person@example.com / 123e4567-e89b-12d3-a456-426614174000",
        }
        record = self.c.build_record(metrics, now_s=self.now)
        self.assertNotIn("scope", record["accountRecentSessions"])

    def test_account_session_inventory_dropped_on_drift(self):
        metrics = fixture("limits-ok.json")
        metrics["accountRecentSessions"] = {"sessionCount": "many", "creditsSampleTotal": None}
        record = self.c.build_record(metrics, now_s=self.now)
        self.assertNotIn("accountRecentSessions", record)


class SchemaDriftTest(unittest.TestCase):
    def setUp(self):
        self.c = load_collector()

    def test_validate_metrics_accepts_known_shape(self):
        metrics = fixture("limits-ok.json")
        self.assertIs(self.c.validate_metrics(metrics), metrics)

    def test_validate_metrics_rejects_drift(self):
        for name in ("drift-limits-array.json", "drift-percent-string.json",
                     "drift-not-object.json", "drift-no-ok.json"):
            with self.assertRaises(ValueError, msg=name):
                self.c.validate_metrics(fixture(name))

    def test_failure_mapping_is_static(self):
        for category in ("unauthenticated", "unsupported-deployment", "schema-error",
                         "helper-timeout", "helper-missing", "helper-error", "network"):
            record = self.c.build_failure_record(category)
            self.assertFalse(record["ready"])
            self.assertEqual(record["limits"], [])
            self.assertNotEqual(record["usageStatusText"], "")
            self.assertNotEqual(record["authHelpText"], "")
        # Unknown categories collapse to the static helper-error text.
        self.assertEqual(
            self.c.build_failure_record("exploding-unknown")["usageStatusText"],
            self.c.build_failure_record("helper-error")["usageStatusText"])


class HelperOutputTest(unittest.TestCase):
    def setUp(self):
        self.c = load_collector()

    def test_sentinel_extraction_ignores_sdk_noise(self):
        sample = (FIXTURES / "helper-output-sample.txt").read_text()
        payload = self.c.parse_helper_output(sample)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["credentialSource"], "workos")

    def test_failure_payload_parses(self):
        text = 'log line\nFACTORY-USAGE-JSON-1\n{"ok": false, "error": "unauthenticated"}\n'
        payload = self.c.parse_helper_output(text)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"], "unauthenticated")

    def test_missing_sentinel_fails(self):
        with self.assertRaises(ValueError):
            self.c.parse_helper_output("no sentinel here")

    def test_payload_without_ok_field_fails(self):
        with self.assertRaises(ValueError):
            self.c.parse_helper_output('FACTORY-USAGE-JSON-1\n{"token": "x"}\n')

    def test_last_sentinel_wins(self):
        text = ('FACTORY-USAGE-JSON-1\n{"ok": true, "stale": true}\n'
                'noise\nFACTORY-USAGE-JSON-1\n{"ok": true, "credentialSource": "workos"}\n')
        payload = self.c.parse_helper_output(text)
        self.assertNotIn("stale", payload)

    def test_secrets_never_reach_the_record(self):
        metrics = fixture("limits-ok.json")
        metrics["token"] = "super-secret-token-value"
        metrics["email"] = "person@example.com"
        metrics["orgId"] = "org_123"
        record = self.c.build_record(metrics, now_s=0)
        text = json.dumps(record)
        self.assertNotIn("super-secret-token-value", text)
        self.assertNotIn("person@example.com", text)
        self.assertNotIn("org_123", text)


class CacheAndProfileTest(unittest.TestCase):
    def setUp(self):
        self.c = load_collector()
        self.tmp = tempfile.TemporaryDirectory()
        self.old_home = os.environ.get("HOME")
        self.old_cache = os.environ.get("XDG_CACHE_HOME")
        os.environ["HOME"] = self.tmp.name
        os.environ["XDG_CACHE_HOME"] = str(Path(self.tmp.name) / "cache")
        os.environ.pop("FACTORY_HOME_OVERRIDE", None)

    def tearDown(self):
        if self.old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self.old_home
        if self.old_cache is None:
            os.environ.pop("XDG_CACHE_HOME", None)
        else:
            os.environ["XDG_CACHE_HOME"] = self.old_cache

    def test_profile_selects_cache_identity(self):
        key_a = self.c.cache_key("/tmp/profile-a")
        key_b = self.c.cache_key("/tmp/profile-b")
        self.assertNotEqual(key_a, key_b)
        self.assertEqual(key_a, self.c.cache_key("/tmp/profile-a"))

    def test_cache_roundtrip_and_expiry(self):
        path = Path(self.tmp.name) / "usage-cache.json"
        metrics = {"ok": True, "credentialSource": "workos", "standard": None, "core": None}
        self.c.store_cache(path, "key1", metrics, now_s=1000)
        self.assertIsNotNone(self.c.load_cache(path, "key1", 300, now_s=1100))
        self.assertIsNone(self.c.load_cache(path, "key1", 300, now_s=5000))
        self.assertIsNone(self.c.load_cache(path, "key2", 300, now_s=1100))
        self.assertIsNone(self.c.load_cache(path, "key1", 300, now_s=100000))
        stored = json.loads(path.read_text())
        # The cache stores raw metrics, never a prebuilt record and never
        # account identifiers.
        self.assertIn("payload", stored)
        self.assertNotIn("record", stored)

    def test_cache_rejects_foreign_payload(self):
        path = Path(self.tmp.name) / "usage-cache.json"
        path.write_text(json.dumps({"key": "key1", "fetchedAt": 1,
                                    "payload": {"ok": "not a bool"}}))
        self.assertIsNone(self.c.load_cache(path, "key1", 300, now_s=2))

    def test_store_is_atomic_no_temp_leftovers(self):
        path = Path(self.tmp.name) / "usage-cache.json"
        self.c.store_cache(path, "key1", {"a": 1}, 0)
        entries = [p.name for p in path.parent.iterdir()]
        self.assertEqual(entries, ["usage-cache.json"])


class LockingTest(unittest.TestCase):
    def setUp(self):
        self.c = load_collector()
        self.tmp = tempfile.TemporaryDirectory()

    def test_lock_is_exclusive(self):
        lock_path = Path(self.tmp.name) / "test.lock"
        with self.c.RefreshLock(lock_path):
            with self.assertRaises(self.c.LockBusy):
                with self.c.RefreshLock(lock_path):
                    pass

    def test_lock_releases(self):
        lock_path = Path(self.tmp.name) / "test.lock"
        with self.c.RefreshLock(lock_path):
            pass
        with self.c.RefreshLock(lock_path):
            pass

    def test_write_record_atomic(self):
        target = Path(self.tmp.name) / "factory.json"
        record = self.c.build_record({"standard": None, "core": None}, now_s=0)
        self.c.write_record(target, record)
        stored = json.loads(target.read_text())
        self.assertEqual(stored["id"], "factory")
        leftovers = [p.name for p in target.parent.iterdir()]
        self.assertEqual(leftovers, ["factory.json"])


if __name__ == "__main__":
    unittest.main()
