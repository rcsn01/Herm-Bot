"""Behavioral tests for the bark-notify plugin.

Run from the repo root (or anywhere):

    python3 -m pytest apps/mobile/push-notification/test_bark_notify.py -q

stdlib + unittest only; no network access — urllib is mocked.
"""

from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import time
import unittest
import urllib.error
from unittest import mock

KIT = pathlib.Path(__file__).resolve().parent


def _load_module():
    spec = importlib.util.spec_from_file_location(
        "bark_notify_plugin_under_test", KIT / "__init__.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _FakeResponse:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeCtx:
    """Minimal stand-in for hermes_cli.plugins.PluginContext.get_config."""

    def __init__(self, settings=None):
        self.settings = settings or {}

    def get_config(self, key, default):
        return self.settings.get(key, default)

    def register_hook(self, *args, **kwargs):
        pass

    def register_cli_command(self, *args, **kwargs):
        pass


class _Args:
    def __init__(self, **kw):
        defaults = dict(message=["hi"], title=None, url=None, level=None, group=None)
        defaults.update(kw)
        self.message = defaults["message"]
        self.title = defaults["title"]
        self.url = defaults["url"]
        self.level = defaults["level"]
        self.group = defaults["group"]


class BarkNotifyTest(unittest.TestCase):
    FAST_SETTINGS = {
        "min_turn_seconds": 1,
        "debounce_seconds": 0.01,
        "min_push_interval_seconds": 0,
    }

    def setUp(self):
        self.mod = _load_module()
        self.mod.register(_FakeCtx(dict(self.FAST_SETTINGS)))
        env = {"BARK_URL": "http://relay.test:8080", "BARK_KEY": "testkey"}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.mod._turns.clear()
        for timer in list(self.mod._timers.values()):
            timer.cancel()
        self.mod._timers.clear()
        self.mod._last_push_at = 0.0

    # -- helpers ------------------------------------------------------------

    def _with_urlopen(self, urlopen_mock):
        patcher = mock.patch.object(self.mod.urllib.request, "urlopen", urlopen_mock)
        patcher.start()
        self.addCleanup(patcher.stop)
        return patcher

    def _wait_for(self, predicate, timeout=3.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.02)
        return False

    def _run_turn(self, turn_id, session_id, duration, final="Task done.", finished=True):
        self.mod._on_stream_start(
            turn_id=turn_id, iteration=1, session_id=session_id,
            model="m", provider="p", surface="cli",
        )
        key = self.mod._activity_key(turn_id, session_id)
        self.mod._turns[key]["start"] -= duration  # age the turn deterministically
        self.mod._on_stream_end(
            turn_id=turn_id, iteration=2, session_id=session_id,
            final_text=final, finished=finished, error=None,
            surface="cli", model="m", provider="p",
        )

    @staticmethod
    def _captured_request(mocked_urlopen):
        request = mocked_urlopen.call_args[0][0]
        return json.loads(request.data.decode("utf-8")), request.full_url

    # -- tests --------------------------------------------------------------

    def test_long_turn_pushes_once_with_deep_link(self):
        urlopen = mock.MagicMock(return_value=_FakeResponse())
        self._with_urlopen(urlopen)
        self._run_turn("t1", "s-1", duration=35, final="Task done: built the widget.")
        self.assertTrue(self._wait_for(lambda: urlopen.call_count == 1))
        self._wait_for(lambda: not self.mod._timers, timeout=0.5)
        time.sleep(0.05)
        payload, url = self._captured_request(urlopen)
        self.assertTrue(url.endswith("/testkey"), url)
        self.assertEqual(payload["url"], "hermes://session/s-1")
        self.assertIn("task finished", payload["title"])
        self.assertIn("built the widget", payload["body"])
        self.assertEqual(payload["group"], "hermes")
        self.assertEqual(payload["level"], "timeSensitive")

    def test_short_turn_is_silent(self):
        urlopen = mock.MagicMock(return_value=_FakeResponse())
        self._with_urlopen(urlopen)
        self._run_turn("t2", "s-2", duration=0.2)
        self.assertTrue(self._wait_for(lambda: not self.mod._timers, timeout=1.0))
        time.sleep(0.05)
        urlopen.assert_not_called()

    def test_tool_loop_debounces_to_one_push(self):
        urlopen = mock.MagicMock(return_value=_FakeResponse())
        self._with_urlopen(urlopen)
        self.mod._on_stream_start(
            turn_id="t3", iteration=1, session_id="s-3",
            model="m", provider="p", surface="cli",
        )
        self.mod._turns["t3"]["start"] -= 2.0
        for i in range(4):
            self.mod._on_stream_end(
                turn_id="t3", iteration=i, session_id="s-3",
                final_text=f"iteration {i}", finished=True, error=None,
                surface="cli", model="m", provider="p",
            )
            time.sleep(0.02)
        self.assertTrue(self._wait_for(lambda: urlopen.call_count == 1))
        time.sleep(0.1)
        self.assertEqual(urlopen.call_count, 1)

    def test_failed_stream_never_pushes(self):
        urlopen = mock.MagicMock(return_value=_FakeResponse())
        self._with_urlopen(urlopen)
        self._run_turn("t4", "s-4", duration=5, finished=False)
        self.assertTrue(self._wait_for(lambda: not self.mod._timers, timeout=1.0))
        time.sleep(0.05)
        urlopen.assert_not_called()

    def test_missing_key_is_idle(self):
        os.environ.pop("BARK_KEY", None)
        try:
            urlopen = mock.MagicMock()
            self._with_urlopen(urlopen)
            self.assertFalse(self.mod._send("t", "b", "s-9", self.mod._settings))
            urlopen.assert_not_called()
        finally:
            os.environ["BARK_KEY"] = "testkey"

    def test_failed_relay_does_not_consume_rate_limit(self):
        urlopen = mock.MagicMock(
            side_effect=urllib.error.URLError("connection refused")
        )
        self._with_urlopen(urlopen)
        self._run_turn("t6a", "s-6", duration=5)
        self.assertTrue(self._wait_for(lambda: not self.mod._timers, timeout=1.0))
        time.sleep(0.05)
        self.assertEqual(urlopen.call_count, 1)
        self.assertEqual(self.mod._last_push_at, 0.0)  # interval NOT consumed

        urlopen.side_effect = None
        urlopen.return_value = _FakeResponse()
        self._run_turn("t6b", "s-6", duration=5)
        self.assertTrue(self._wait_for(lambda: urlopen.call_count == 2, timeout=1.0))

    def test_rate_limit_between_pushes(self):
        self.mod.register(_FakeCtx({**self.FAST_SETTINGS, "min_push_interval_seconds": 60}))
        urlopen = mock.MagicMock(return_value=_FakeResponse())
        self._with_urlopen(urlopen)
        self._run_turn("t7a", "s-7", duration=5)
        self.assertTrue(self._wait_for(lambda: urlopen.call_count == 1))
        self._run_turn("t7b", "s-7", duration=5)
        self.assertTrue(self._wait_for(lambda: not self.mod._timers, timeout=1.0))
        time.sleep(0.05)
        self.assertEqual(urlopen.call_count, 1)  # second turn within interval: silent

    def test_session_id_refreshed_from_later_events(self):
        urlopen = mock.MagicMock(return_value=_FakeResponse())
        self._with_urlopen(urlopen)
        self.mod._on_stream_start(
            turn_id="t8", iteration=1, session_id="s-old",
            model="m", provider="p", surface="cli",
        )
        self.mod._turns["t8"]["start"] -= 5
        self.mod._on_stream_end(
            turn_id="t8", iteration=2, session_id="s-new",
            final_text="done", finished=True, error=None,
            surface="cli", model="m", provider="p",
        )
        self.assertTrue(self._wait_for(lambda: urlopen.call_count == 1))
        payload, _ = self._captured_request(urlopen)
        self.assertEqual(payload["url"], "hermes://session/s-new")

    def test_numeric_settings_are_converted_to_float(self):
        self.mod.register(_FakeCtx({"min_turn_seconds": "2.5"}))
        self.assertIsInstance(self.mod._settings["min_turn_seconds"], float)
        self.assertEqual(self.mod._settings["min_turn_seconds"], 2.5)

    def test_invalid_numeric_settings_fall_back_to_defaults(self):
        self.mod.register(_FakeCtx({"min_turn_seconds": "soon"}))
        self.assertEqual(
            self.mod._settings["min_turn_seconds"], self.mod._DEFAULTS["min_turn_seconds"]
        )

    def test_cli_url_override_reaches_send(self):
        sent = {}
        with mock.patch.object(self.mod, "_send", return_value=True) as fake:
            rc = self.mod._cli_run(_Args(message=["hello", "there"], url="hermes://session/x"))
            self.assertEqual(rc, 0)
            sent = {
                "title": fake.call_args.args[0],
                "url": fake.call_args.kwargs["url_override"],
            }
        self.assertEqual(sent["url"], "hermes://session/x")
        self.assertEqual(sent["title"], "Hermes")


if __name__ == "__main__":
    unittest.main()