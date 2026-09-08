from __future__ import annotations

import asyncio
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from gateway.config import PlatformConfig

KIT = Path(__file__).resolve().parent


def load_plugin():
    spec = importlib.util.spec_from_file_location(
        "mobile_push_delivery_under_test", KIT / "__init__.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeContext:
    def __init__(self):
        self.platform = None

    def register_platform(self, **kwargs):
        self.platform = kwargs


class FakeResponse:
    def __init__(self, payload=None):
        self.payload = payload or {"sent": 2, "removed": 0, "failed": 0}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode()


class MobilePushDeliveryTest(unittest.TestCase):
    def setUp(self):
        self.plugin = load_plugin()
        self.config = PlatformConfig(
            enabled=True,
            extra={"relay_url": "https://mobile.example/push/v1/notify"},
        )

    def test_registers_webpush_platform_for_cron_and_standalone_delivery(self):
        context = FakeContext()
        with mock.patch.dict(
            os.environ, {"HERMES_WEB_PUSH_TOKEN": "s" * 32}, clear=False
        ):
            self.plugin.register(context)
        self.assertEqual(context.platform["name"], "webpush")
        self.assertEqual(
            context.platform["cron_deliver_env_var"],
            "WEBPUSH_HOME_CHANNEL",
        )
        self.assertIs(
            context.platform["standalone_sender_fn"],
            self.plugin._standalone_send,
        )
        self.assertIs(
            context.platform["parse_target_ref_fn"],
            self.plugin._parse_target_ref,
        )

    def test_user_plugin_discovery_registers_webpush(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            plugin_dir = home / "plugins" / "mobile-push-delivery"
            shutil.copytree(KIT, plugin_dir)
            (home / "config.yaml").write_text(
                "plugins:\n"
                "  enabled:\n"
                "    - mobile-push-delivery\n"
                "platforms:\n"
                "  webpush:\n"
                "    enabled: true\n"
                "    extra:\n"
                "      relay_url: https://mobile.example/push/v1/notify\n"
            )
            script = (
                "from hermes_cli.plugins import discover_plugins\n"
                "from gateway.platform_registry import platform_registry\n"
                "discover_plugins()\n"
                "entry = platform_registry.get('webpush')\n"
                "print(entry.name if entry else '')\n"
            )
            env = dict(os.environ)
            env.update({
                "HERMES_HOME": str(home),
                "HERMES_WEB_PUSH_TOKEN": "s" * 32,
            })
            completed = subprocess.run(
                [sys.executable, "-c", script],
                cwd=KIT.parents[2],
                env=env,
                text=True,
                capture_output=True,
                check=True,
            )
        self.assertEqual(completed.stdout.strip().splitlines()[-1], "webpush")

    def test_target_parser_accepts_only_all_subscribed_devices(self):
        self.assertEqual(self.plugin._parse_target_ref("broadcast"), ("all", None))
        self.assertEqual(self.plugin._parse_target_ref("ALL"), ("all", None))
        self.assertIsNone(self.plugin._parse_target_ref("someone-else"))
        self.assertIs(self.plugin._validate_target_ref("all"), True)
        self.assertIsInstance(self.plugin._validate_target_ref("device-1"), str)

    def test_posts_bearer_authenticated_notification(self):
        with mock.patch.object(
            self.plugin.urllib.request, "urlopen", return_value=FakeResponse()
        ) as urlopen:
            result = self.plugin._post_notification(
                "https://mobile.example/push/v1/notify",
                "secret-" * 8,
                "Deployment complete",
            )
        self.assertTrue(result["success"])
        self.assertEqual(result["sent"], 2)
        request = urlopen.call_args.args[0]
        self.assertEqual(
            request.headers["Authorization"],
            f"Bearer {'secret-' * 8}",
        )
        self.assertEqual(json.loads(request.data)["body"], "Deployment complete")
        self.assertEqual(json.loads(request.data)["url"], "/")

    def test_standalone_sender_uses_platform_config(self):
        with (
            mock.patch.dict(
                os.environ, {"HERMES_WEB_PUSH_TOKEN": "t" * 32}, clear=False
            ),
            mock.patch.object(
                self.plugin.urllib.request, "urlopen", return_value=FakeResponse()
            ) as urlopen,
        ):
            result = asyncio.run(
                self.plugin._standalone_send(self.config, "all", "Cron finished")
            )
        self.assertTrue(result["success"])
        self.assertEqual(
            urlopen.call_args.args[0].full_url,
            self.config.extra["relay_url"],
        )

    def test_invalid_configuration_and_relay_failure_are_reported(self):
        with mock.patch.dict(os.environ, {"HERMES_WEB_PUSH_TOKEN": ""}, clear=False):
            result = asyncio.run(self.plugin._deliver(self.config, "all", "hello"))
        self.assertIn("error", result)

        with mock.patch.object(
            self.plugin.urllib.request,
            "urlopen",
            side_effect=self.plugin.urllib.error.URLError("offline"),
        ):
            result = self.plugin._post_notification(
                "https://mobile.example/push/v1/notify",
                "s" * 32,
                "hello",
            )
        self.assertEqual(result, {"error": "Web Push relay is unavailable"})

    def test_no_active_subscriptions_is_not_reported_as_delivered(self):
        with mock.patch.object(
            self.plugin.urllib.request,
            "urlopen",
            return_value=FakeResponse({"sent": 0, "removed": 0, "failed": 0}),
        ):
            result = self.plugin._post_notification(
                "https://mobile.example/push/v1/notify",
                "s" * 32,
                "hello",
            )
        self.assertIn("No active Web Push subscription", result["error"])

    def test_cron_resolves_bare_webpush_to_home_channel(self):
        from cron import scheduler
        from gateway.config import HomeChannel, Platform
        from gateway.platform_registry import PlatformEntry, platform_registry

        context = FakeContext()
        self.plugin.register(context)
        kwargs = dict(context.platform)
        entry = PlatformEntry(source="plugin", **kwargs)
        platform_registry.register(entry)
        home = HomeChannel(
            platform=Platform("webpush"),
            chat_id="all",
            name="All subscribed devices",
        )
        try:
            with mock.patch.object(
                scheduler, "_get_config_home_channel", return_value=home
            ):
                target = scheduler._resolve_single_delivery_target({}, "webpush")
                gateway_config = mock.Mock()
                gateway_config.get_connected_platforms.return_value = [
                    Platform("webpush")
                ]
                with mock.patch(
                    "gateway.config.load_gateway_config",
                    return_value=gateway_config,
                ):
                    available = scheduler.cron_delivery_targets()
        finally:
            platform_registry.unregister("webpush")
        self.assertEqual(target["platform"], "webpush")
        self.assertEqual(target["chat_id"], "all")
        self.assertIn("webpush", {item["id"] for item in available})


if __name__ == "__main__":
    unittest.main()
