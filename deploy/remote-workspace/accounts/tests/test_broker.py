import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parents[1] / "broker.py"
module = importlib.util.spec_from_file_location("broker", path)
broker = importlib.util.module_from_spec(module)
module.loader.exec_module(broker)


class BrokerTests(unittest.TestCase):
    def test_namespace_validation_happens_before_any_work(self):
        with patch.object(broker, "allocation") as allocation:
            for ns in ("kolmogor", "kube-system", "kolmogor-ws-u-deadbeef", "", None):
                with self.assertRaises(ValueError):
                    broker.dispatch(ns, "ensure")
            allocation.assert_not_called()

    def test_capacity_and_existing_workspaces_survive_a_broker_restart(self):
        a, b = "kolmogor-ws-u-" + "a" * 40, "kolmogor-ws-u-" + "b" * 40
        with tempfile.TemporaryDirectory() as root, patch.object(broker, "STATE", Path(root)), patch.object(broker, "MAX_WORKSPACES", 1):
            (Path(root) / a).mkdir()
            (Path(root) / a / broker.READY_MARKER).touch()
            self.assertTrue(broker.allocation(a, ensure=True))
            with self.assertRaises(ValueError):
                broker.allocation(b, ensure=True)
            with self.assertRaises(ValueError):
                broker.dispatch(b, "display")

    def test_chat_runs_only_in_the_owned_pod_with_structured_stdin(self):
        ns = "kolmogor-ws-u-" + "b" * 40
        with patch.object(broker, "allocation", return_value=True), patch.object(broker, "provider_state", return_value=True), patch.object(broker.subprocess, "Popen") as launch:
            message = {"thread": None, "prompt": "A literal chat message"}
            for invalid in ({"thread": "--last", "prompt": "hi"}, dict(message, command="arbitrary"),
                            dict(message, model=["bad"]), dict(message, model="--config override"),
                            {"prompt": "hi"}, {"thread": None, "prompt": "x" * 8193}):
                with self.assertRaises(ValueError):
                    broker.dispatch(ns, "chat", turn=invalid)
            launch.assert_not_called()
            proc = launch.return_value.__enter__.return_value
            proc.stdout = io.BytesIO(b'{"delta":"first"}\n{"status":"interrupted"}\n')
            proc.wait.return_value = 0
            seen = []
            self.assertEqual(broker.dispatch(ns, "chat", turn=message, on_delta=seen.append), {"status": "interrupted"})
            self.assertEqual(seen, ["first"])
            self.assertEqual(launch.call_args.args[0], broker.container(ns, "codex", "node", "-e", broker.CHAT_WORKER, interactive=True))
            self.assertEqual(broker.json.loads(proc.stdin.write.call_args.args[0]), message)

    def test_catalog_uses_only_the_authenticated_workspace_codex_worker(self):
        ns = "kolmogor-ws-u-" + "b" * 40
        with patch.object(broker, "allocation", return_value=True), patch.object(broker, "provider_state") as signed, patch.object(broker, "run") as run:
            signed.return_value = False
            self.assertEqual(broker.dispatch(ns, "chat-models")["status"], "disconnected")
            run.assert_not_called()
            signed.return_value = True
            run.return_value.stdout = '{"models":[]}'
            self.assertEqual(broker.dispatch(ns, "chat-models"), {"models":[]})
            signed.assert_called_with(ns, "codex")
            self.assertEqual(run.call_args.args[0], broker.container(ns, "codex", "node", "-e", broker.CHAT_WORKER, interactive=True))
            self.assertEqual(broker.json.loads(run.call_args.kwargs["data"]), {"operation":"models"})

    def test_previous_workspace_is_upgraded_in_place(self):
        ns = "kolmogor-ws-u-" + "1" * 40
        with tempfile.TemporaryDirectory() as root, patch.object(broker, "STATE", Path(root)), \
                patch.object(broker, "run") as run, patch.dict(broker.preparing, {}, clear=True):
            workspace = Path(root, ns)
            workspace.mkdir()
            (workspace / "ready").touch()
            self.assertFalse(broker.allocation(ns))
            self.assertFalse(broker.allocation(ns, ensure=True))
            broker.preparing[ns].result(timeout=3)
            self.assertTrue(broker.allocation(ns))
            self.assertTrue((workspace / "ready").exists())
            self.assertEqual(run.call_args_list[-1].args[0], [str(broker.WORKSPACE), ns, "provision"])

    def test_only_official_provider_authorization_links_are_forwarded(self):
        actual = "https://claude.ai/oauth/authorize?opaque_request"
        results = broker.sign_in_details("claude", "Open " + actual + "\nPaste code here")
        self.assertEqual(results["url"], actual)
        for foreign in ("https://elsewhere.invalid/oauth/authorize", "https://claude.ai/other",
                        "https://unrelated@claude.ai/oauth/authorize", "https://claude.ai:9443/oauth/authorize"):
            self.assertNotIn("url", broker.sign_in_details("claude", foreign))
        self.assertNotIn("url", broker.sign_in_details("claude", actual))
        self.assertNotIn("url", broker.sign_in_details("codex", "Visit https://auth.openai.com/codex/device\n"))
        device = broker.sign_in_details("codex", "Visit https://auth.openai.com/codex/device\nABCD-EFGH")
        self.assertIn("ABCD-EFGH", device["message"])

    def test_antigravity_code_only_goes_to_its_registered_google_client(self):
        from urllib.parse import urlencode
        query = dict(client_id="1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
                     redirect_uri="https://antigravity.google/oauth-callback", response_type="code",
                     code_challenge_method="S256", code_challenge="fixture", state="fixture")
        def offer(**changes):
            url = "https://accounts.google.com/o/oauth2/auth?" + urlencode(query | changes)
            return broker.sign_in_details("antigravity", url + "\n")
        self.assertTrue(offer()["acceptsCode"])
        for invalid in ({"redirect_uri": "https://example.invalid/"}, {"client_id": "another-app"},
                        {"code_challenge_method": "plain"}, {"state": ""}):
            self.assertNotIn("url", offer(**invalid))

    def test_no_generic_exec_or_operations_for_the_display(self):
        ns = "kolmogor-ws-u-" + "f" * 40
        with patch.object(broker, "allocation", return_value=True), patch.object(broker, "run") as run:
            for op in ("run", "exec", "proxy", "delete"):
                with self.assertRaises(ValueError):
                    broker.dispatch(ns, op, "codex")
            with self.assertRaises(ValueError):
                broker.dispatch(ns, "code", "chrome", "abcdef012")
            run.assert_not_called()
