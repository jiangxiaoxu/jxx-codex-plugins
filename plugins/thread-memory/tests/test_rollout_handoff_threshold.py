import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "skills" / "thread-memory" / "scripts"))

from rollout_handoff_threshold import (
    LEAD_TOKENS_ENV,
    START_TOKENS_ENV,
    ReminderStage,
    reminder_plan,
    tomllib,
)


class HandoffThresholdTest(unittest.TestCase):
    @unittest.skipIf(tomllib is None, "automatic threshold needs a TOML parser")
    def test_enabled_async_compaction_uses_verified_model_metadata_and_ordered_tiers(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, clear=True):
            home = Path(directory)
            config = home / "config.toml"
            enabled = "model_context_window = 500000\n[features.async_compaction]\nenabled = true\n"
            config.write_text(enabled, encoding="utf-8")
            self.assertIsNone(reminder_plan(home, "fixture-model"))

            model = {
                "slug": "fixture-model",
                "context_window": 500_000,
                "effective_context_window_percent": 95,
            }
            (home / "models_cache.json").write_text(json.dumps({"models": [model]}), encoding="utf-8")
            self.assertIsNone(reminder_plan(home, "unverified-model"))
            standard = ((65, 280_000), (80, 355_000))
            cases = (
                ("", standard),
                ("model_async_compact_threshold_percent = 65\n", standard),
                ("model_async_compact_threshold_percent = 70\n", ((65, 280_000), (70, 305_000), (80, 355_000))),
            )
            for settings, expected in cases:
                with self.subTest(settings=settings):
                    config.write_text(enabled + settings, encoding="utf-8")
                    plan = reminder_plan(home, "fixture-model")
                    self.assertIsNotNone(plan)
                    self.assertEqual(plan.levels, expected)
                    self.assertEqual(plan.usable_window, 475_000)

            config.write_text(enabled.replace("true", "false"), encoding="utf-8")
            self.assertIsNone(reminder_plan(home, "fixture-model"))
            with patch.dict(os.environ, {"THREAD_MEMORY_ASYNC_START_TOKENS": "350000"}):
                plan = reminder_plan(home, "fixture-model")
                self.assertIsNotNone(plan)
                self.assertEqual(plan.levels, ((0, 305_000),))
                self.assertIsNone(plan.usable_window)

    def test_stages_are_relative_to_startup_tokens(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {START_TOKENS_ENV: "350000"}, clear=True
        ):
            plan = reminder_plan(Path(directory), None)
            cases = (
                (304_999, ()),
                (305_000, ((0, ReminderStage.FIRST),)),
                (309_999, ((0, ReminderStage.FIRST),)),
                (310_000, ((0, ReminderStage.CHECK),)),
                (313_999, ((0, ReminderStage.CHECK),)),
                (314_000, ((0, ReminderStage.FINAL_CHECK),)),
            )
            for used, expected in cases:
                with self.subTest(used=used):
                    self.assertEqual(plan.reached(used), expected)

    def test_custom_lead_keeps_only_checks_after_the_first_reminder(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {START_TOKENS_ENV: "350000", LEAD_TOKENS_ENV: "40000"}, clear=True
        ):
            home = Path(directory)
            plan = reminder_plan(home, None)
            self.assertEqual(plan.reached(310_000), ((0, ReminderStage.FIRST),))
            self.assertEqual(plan.reached(314_000), ((0, ReminderStage.FINAL_CHECK),))

            os.environ[LEAD_TOKENS_ENV] = "36000"
            plan = reminder_plan(home, None)
            self.assertEqual(plan.reached(313_999), ())
            self.assertEqual(plan.reached(319_000), ((0, ReminderStage.FIRST),))


if __name__ == "__main__":
    unittest.main()
