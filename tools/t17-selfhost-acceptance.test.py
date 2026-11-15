#!/usr/bin/env python3
"""Runner regressions only: no Docker processes, browser, lock or source build."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("t17_selfhost", Path(__file__).with_name("t17-selfhost-acceptance.py"))
h = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(h)


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="selfhost-regression-", dir="/tmp/opencode")
        self.addCleanup(self.tmp.cleanup)
        h.configure(["run", "--delivery", self.tmp.name])
        self.project = "vrata-demo-" + h.SHA[:8] + "-0123456789ab"
        self.state = {"project": self.project, "runId": "t17-0123456789ab", "phase": "prepared"}
        self.private = {"COMPOSE_PROJECT_NAME": self.project, "POSTGRES_PASSWORD": "private-password",
                        "API_IMAGE_REPO": "private-api", "ROOM_STATE_IMAGE_REPO": "private-state", "VRATA_HTTP_PORT": "47170"}
        h.ENVFILE.write_text("".join(f"{key}={value}\n" for key, value in self.private.items()))
        h.write("runner.private.json", self.state)
        directory = h.SOURCE / "infra/docker"
        directory.mkdir(parents=True)
        for name in ["compose.selfhost.yml", "compose.demo-local.yml"]:
            (directory / name).write_bytes((h.ROOT / "infra/docker" / name).read_bytes())
        self.model = {"name": self.project, "services": {}}
        h.write("compose.private.json", self.model)
        self.container = {"Id": "a" * 64, "Config": {"Labels": {
            "vrata.task": "T17", "vrata.run": self.state["runId"],
            "com.docker.compose.project": self.project, "com.docker.compose.service": "postgres"}}}

    def test_fresh_floor_reads_owned_postgres_and_accepts_absent_health_field(self):
        with mock.patch.object(h, "inventory", return_value=[self.container]), \
             mock.patch.object(h, "docker", return_value=b"t|1\n") as docker, \
             mock.patch.object(h, "health", return_value={"features": {}}):
            h.verify_fresh_identity_floor(self.state)
        command = docker.call_args.args
        self.assertEqual(command[:2], ("exec", "a" * 64))
        self.assertIn("ON_ERROR_STOP=1", command)
        self.assertEqual(command[-1], "select singleton, minimum_protocol from room_identity_protocol_policy;")
        proof = json.loads((h.Q / "fresh-identity-policy.json").read_text())
        self.assertEqual(proof["minimumProtocol"], 1)
        self.assertTrue(proof["singleton"])

    def test_absent_health_field_does_not_default_missing_wrong_or_duplicate_policy_to_one(self):
        for value in [b"", b"t|2\n", b"f|1\n", b"t|1\nt|1\n"]:
            with self.subTest(value=value), mock.patch.object(h, "inventory", return_value=[self.container]), \
                 mock.patch.object(h, "docker", return_value=value), \
                 mock.patch.object(h, "health", return_value={"features": {}}):
                with self.assertRaisesRegex(AssertionError, "not_fresh_identity_floor"):
                    h.verify_fresh_identity_floor(self.state)

    def test_fresh_health_must_match_exact_runtime_contract(self):
        with mock.patch.object(h, "inventory", return_value=[self.container]), \
             mock.patch.object(h, "docker", return_value=b"t|1\n"), \
             mock.patch.object(h, "health", return_value={"features": {"identityProtocolVersion": 2}}):
            with self.assertRaisesRegex(AssertionError, "unexpected_fresh_identity_health"):
                h.verify_fresh_identity_floor(self.state)

    def test_inventory_rejects_foreign_postgres_before_query(self):
        foreign = json.loads(json.dumps(self.container))
        foreign["Config"]["Labels"]["vrata.run"] = "foreign"
        with mock.patch.object(h, "docker", side_effect=[b"a" * 64, json.dumps([foreign]).encode()]) as docker:
            with self.assertRaises(AssertionError):
                h.verify_fresh_identity_floor(self.state)
        self.assertEqual(docker.call_count, 2)  # list/inspect only; no exec

    def test_all_compose_commands_pin_project_and_sanitize_inherited_values(self):
        poison = {key: "malicious-inherited" for key in self.private}
        poison.update(COMPOSE_PROJECT_NAME="existingproject", COMPOSE_FILE="foreign.yml", COMPOSE_PROFILES="foreign",
                      COMPOSE_ENV_FILES="foreign.env", COMPOSE_IGNORE_ORPHANS="1", MINIO_ENDPOINT="http://foreign",
                      ROOM_PLUGIN_BUCKET="foreign", DOCKER_CONTEXT="foreign", NODE_OPTIONS="--require=foreign.js",
                      WSLENV="COMPOSE_PROJECT_NAME:POSTGRES_PASSWORD:MINIO_ENDPOINT")
        calls = []

        def capture(argv, **kwargs):
            calls.append((argv, kwargs))
            return json.dumps(self.model).encode()

        with mock.patch.dict(os.environ, poison), mock.patch.object(h, "win", side_effect=str), \
             mock.patch.object(h, "capture", side_effect=capture):
            h.compose("config", "--format", "json", project=self.project, stock=True)
            h.compose("up", "-d")
            h.compose("down", "-v", "--remove-orphans")
        self.assertEqual(len(calls), 5)  # stock config, model check/up, model check/down
        for argv, kwargs in calls:
            self.assertEqual(argv[len(h.DOCKER):len(h.DOCKER) + 3], ["compose", "-p", self.project])
            env = kwargs["env"]
            for key, value in self.private.items():
                self.assertEqual(env[key], value)
            for key in ["COMPOSE_FILE", "COMPOSE_PROFILES", "COMPOSE_ENV_FILES", "MINIO_ENDPOINT", "ROOM_PLUGIN_BUCKET", "DOCKER_CONTEXT"]:
                self.assertEqual(env[key], "")
                self.assertIn(key, env["WSLENV"].split(":"))
            self.assertNotIn("COMPOSE_IGNORE_ORPHANS", env)
            self.assertNotIn("NODE_OPTIONS", env)
        self.assertNotIn(str(h.OVERLAY), calls[0][0])
        self.assertIn(str(h.OVERLAY), calls[-1][0])

    def test_conflicting_rendered_project_blocks_up_and_down_before_mutation(self):
        for operation in ["up", "down", "restart", "exec", "run"]:
            with self.subTest(operation=operation), mock.patch.object(h, "win", side_effect=str), \
                 mock.patch.object(h, "docker", return_value=b'{"name":"existingproject"}') as docker:
                with self.assertRaisesRegex(AssertionError, "t17_rendered_project_mismatch"):
                    h.compose(operation)
                self.assertEqual(docker.call_count, 1)
                self.assertEqual(docker.call_args.args[-3:], ("config", "--format", "json"))

    def test_preflight_rejects_wrong_model_name_before_any_docker_mutation(self):
        with mock.patch.object(h, "compose", return_value=b'{"name":"existingproject"}'), \
             mock.patch.object(h, "docker") as docker:
            with self.assertRaisesRegex(AssertionError, "t17_rendered_project_mismatch"):
                h.model_preflight(self.state)
        docker.assert_not_called()

    def test_changed_saved_project_blocks_even_config(self):
        changed = {**self.state, "project": "vrata-demo-" + h.SHA[:8] + "-aaaaaaaaaaaa"}
        h.write("runner.private.json", changed)
        with mock.patch.object(h, "docker") as docker:
            with self.assertRaisesRegex(AssertionError, "t17_saved_project_mismatch"):
                h.compose("config")
        docker.assert_not_called()

    def test_cleanup_rejects_model_changed_after_preflight_before_down(self):
        with mock.patch.object(h, "compose", return_value=json.dumps({**self.model, "services": {"foreign": {}}}).encode()) as compose:
            with self.assertRaisesRegex(AssertionError, "t17_cleanup_model_changed_since_preflight"):
                h.cleanup(self.state)
        self.assertEqual(compose.call_args.args, ("config", "--format", "json"))

    def test_cleanup_rejects_foreign_orphan_before_down(self):
        foreign = json.loads(json.dumps(self.container))
        foreign["Config"]["Labels"]["vrata.run"] = "foreign"
        with mock.patch.object(h, "compose", return_value=json.dumps(self.model).encode()) as compose, \
             mock.patch.object(h, "docker", side_effect=[b"a" * 64, json.dumps([foreign]).encode()]):
            with self.assertRaises(AssertionError):
                h.cleanup(self.state)
        self.assertEqual(compose.call_count, 1)  # config only, never down

    def test_cleanup_checks_volume_and_network_project_labels_before_down(self):
        for kind, identifier in [("volume", "owned-volume"), ("network", "b" * 64)]:
            def docker(*parts, **kwargs):
                if parts[0] == kind and parts[1] == "ls":
                    if kind == "network":
                        self.assertIn("--no-trunc", parts)
                    return identifier.encode()
                if parts[0] == kind and parts[1] == "inspect":
                    return json.dumps([{"Id": identifier, "Name": identifier, "Labels": {
                        "vrata.task": "T17", "vrata.run": self.state["runId"], "com.docker.compose.project": "foreign"}}]).encode()
                return b""

            with self.subTest(kind=kind), mock.patch.object(h, "compose", return_value=json.dumps(self.model).encode()) as compose, \
                 mock.patch.object(h, "docker", side_effect=docker):
                with self.assertRaises(AssertionError):
                    h.cleanup(self.state)
                self.assertEqual(compose.call_count, 1)

    def test_ownership_checked_cleanup_pins_down_despite_hostile_project(self):
        calls = []

        def capture(argv, **kwargs):
            calls.append(argv)
            if "config" in argv:
                return json.dumps(self.model).encode()
            return b""

        with mock.patch.dict(os.environ, {"COMPOSE_PROJECT_NAME": "existingproject"}), \
             mock.patch.object(h, "win", side_effect=str), mock.patch.object(h, "capture", side_effect=capture):
            result = h.cleanup(self.state)
        downs = [command for command in calls if "down" in command]
        self.assertEqual(len(downs), 1)
        self.assertEqual(downs[0][len(h.DOCKER):len(h.DOCKER) + 3], ["compose", "-p", self.project])
        self.assertFalse(any(result["remaining"].values()))

    def run_with_diagnostic_failure(self, *, write_failure=False, cleanup_failure=False, activated_health=2):
        def capture(argv, **kwargs):
            if argv[:2] == ["git", "show"]:
                return (h.ROOT / argv[2].split(":", 1)[1]).read_bytes()
            h.write("playwright.private.json", {"stats": {"expected": 1, "unexpected": 0, "skipped": 0, "flaky": 0}})
            h.write("lifecycle-facts.json", {"lifecyclePassed": True, "cleanupPassed": True})
            return b""

        def compose(*parts, **kwargs):
            if parts[0] == "logs":
                raise RuntimeError("test_logs_failed")
            return b""

        real_write = h.write

        def write(name, value):
            if write_failure and name == "terminal-containers.private.json":
                raise OSError("test_diagnostics_write_failed")
            real_write(name, value)

        with mock.patch.multiple(h, model_preflight=mock.DEFAULT, install_dependencies=mock.DEFAULT,
                                 verify_harness_types=mock.DEFAULT, source_build=mock.DEFAULT,
                                 verify_fresh_identity_floor=mock.DEFAULT, runtime_audit=mock.DEFAULT,
                                 owner_child=mock.DEFAULT), \
             mock.patch.object(h, "health", return_value={"features": {"identityProtocolVersion": activated_health}}), \
             mock.patch.object(h, "continuity", return_value={"runtimeSha": h.SHA}), \
             mock.patch.object(h, "inventory", return_value=[self.container]), \
             mock.patch.object(h, "compose", side_effect=compose), mock.patch.object(h, "capture", side_effect=capture), \
             mock.patch.object(h, "git", return_value="") as git, mock.patch.object(h, "write", side_effect=write), \
             mock.patch.object(h, "cleanup", side_effect=RuntimeError("test_cleanup_failed") if cleanup_failure else None) as cleanup, \
             mock.patch.object(h, "setup", return_value=self.state), \
             mock.patch.object(h, "open", mock.mock_open(), create=True), mock.patch.object(h.fcntl, "flock"):
            exit_code = h.main()
        cleanup.assert_called_once_with(self.state)
        git.assert_called_once_with("status", "--porcelain")
        result = json.loads((h.Q / "terminal.json").read_text())
        self.assertEqual(exit_code, 1)
        self.assertEqual(result["status"], "failed")
        self.assertFalse(result["diagnosticsPassed"])
        self.assertEqual(result["cleanupPassed"], not cleanup_failure)
        self.assertTrue(result["sourceStillClean"])
        self.assertTrue(result["harnessUnchanged"])
        self.assertEqual(json.loads(h.STATE.read_text())["phase"], "complete")
        self.assertTrue((h.SOURCE / "infra/docker/compose.selfhost.yml").exists())

    def test_logs_failure_still_cleans_up_and_fails_exit_and_result(self):
        self.run_with_diagnostic_failure()

    def test_diagnostics_write_failure_still_cleans_up_and_fails_result(self):
        self.run_with_diagnostic_failure(write_failure=True)

    def test_cleanup_failure_is_not_hidden_by_diagnostics_failure(self):
        self.run_with_diagnostic_failure(cleanup_failure=True)
        self.assertTrue((h.Q / "cleanup-failure.private.log").exists())

    def test_activation_health_still_requires_explicit_floor_two(self):
        self.run_with_diagnostic_failure(activated_health=1)
        self.assertIn("AssertionError", (h.Q / "failure.private.log").read_text())

    def test_shared_helpers_include_transitive_diagnostics_and_match_exact_candidate(self):
        helper = "tests/e2e/functional-diagnostics.ts"
        self.assertIn(helper, h.SHARED_HELPERS)
        with mock.patch.object(h, "capture", side_effect=lambda argv: (h.ROOT / argv[2].split(":", 1)[1]).read_bytes()) as capture:
            h.verify_shared_helpers()
        self.assertIn(mock.call(["git", "show", h.SHA + ":" + helper]), capture.call_args_list)

    def test_transitive_diagnostics_mismatch_blocks_harness(self):
        helper = "tests/e2e/functional-diagnostics.ts"

        def capture(argv):
            rel = argv[2].split(":", 1)[1]
            content = (h.ROOT / rel).read_bytes()
            return content + b"\nchanged" if rel == helper else content

        with mock.patch.object(h, "capture", side_effect=capture):
            with self.assertRaisesRegex(AssertionError, "shared_helper_not_exact_runtime_sha"):
                h.verify_shared_helpers()


if __name__ == "__main__":
    unittest.main()
