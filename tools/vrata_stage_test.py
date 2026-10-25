"""Unit checks for tools/vrata-stage.py; run through tools/vrata-stage.test.mjs."""

import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("vrata_stage", Path(__file__).with_name("vrata-stage.py"))
vs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vs)


def dead_identity():
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    identity = vs.process_identity(child.pid) or {"pid": child.pid, "start": 1}
    child.wait()
    return identity


class FakeCloud:
    def __init__(self):
        self.servers = {}
        self.calls = []
        self.fip = {"id": "fip-1", "floating_ip_address": "203.0.113.7", "port_id": None}
        self.ports = {}

    def server(self, server_id):
        return self.servers.get(server_id)

    def servers_named(self, name):
        return [server for server in self.servers.values() if server["name"] == name]

    def create_server(self, body):
        server_id = f"srv-{len(self.calls)}"
        self.servers[server_id] = {"id": server_id, "name": body["name"], "status": "ACTIVE", "metadata": body["metadata"]}
        self.ports[server_id] = [{"id": "port-" + server_id}]
        self.calls.append(("create", body))
        return server_id

    def delete_server(self, server_id):
        self.calls.append(("delete", server_id))
        self.servers.pop(server_id, None)

    def server_ports(self, server_id):
        return self.ports[server_id]

    def floating_ip(self, address):
        return self.fip

    def port(self, port_id):
        return {"id": port_id} if any(port_id == ports[0]["id"] for sid, ports in self.ports.items() if sid in self.servers) else None

    def associate(self, fip_id, port_id):
        self.calls.append(("associate", port_id))
        self.fip["port_id"] = port_id


class FakeGitHub:
    def __init__(self, busy=None):
        self.busy = list(busy or [])
        self.variables = []

    def set_variable(self, repo, name, value):
        self.variables.append((name, value))

    def busy_runs(self, repo, workflows):
        return self.busy.pop(0) if self.busy else []

    def latest_success_sha(self, repo, workflow):
        return "a" * 40


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        (root / "secrets/stage/demo/host-keys").mkdir(parents=True)
        for kind in ("ed25519",):
            (root / f"secrets/stage/demo/host-keys/ssh_host_{kind}_key").write_text("private\n")
            (root / f"secrets/stage/demo/host-keys/ssh_host_{kind}_key.pub").write_text(f"ssh-{kind} AAAAkey demo\n")
        self.config_path = root / "secrets/stage/stages.json"
        self.config_path.write_text(json.dumps({
            "secrets_root": str(root / "secrets"),
            "stages": {"demo": {
                "server_name": "vrata-demo-stage", "flavor": "1", "image": "img", "network": "net",
                "floating_ip": "203.0.113.7", "security_groups": ["edge"],
                "admin": {"user": "vrata", "key": "stage/demo/admin"},
                "github": {"repo": "o/r", "variable": "STAGE_PRESENT", "busy_workflows": ["CI"], "deploy_after": "CI"},
                "hook": {"clone": str(root), "path": "infra/hook.sh"}, "grace_minutes": 1}}}))
        self.cloud, self.github, self.spawned = FakeCloud(), FakeGitHub(), []
        self.stands = self.make()

    def make(self):
        def spawner(args, log):
            self.spawned.append(args)
            return vs.process_identity(os.getpid())
        return vs.Stands(vs.Config(self.config_path), vs.Registry(Path(self.tmp.name) / "state"), self.cloud,
                         self.github, spawner, log=lambda message: None)

    def tearDown(self):
        self.tmp.cleanup()

    def state(self):
        return self.stands.registry.read("demo")

    def set_state(self, **values):
        with self.stands.registry.locked("demo") as state:
            state.update(values)


class LeaseTests(Base):
    def lease(self, expires_in=3600, owner="none"):
        now = vs.utcnow()
        return {"purpose": "e2e", "created": vs.iso(now), "expires": vs.iso(now + dt.timedelta(seconds=expires_in)),
                "owner": None if owner == "none" else owner}

    def test_lease_lives_by_deadline_and_owner(self):
        now = vs.utcnow()
        me = vs.process_identity(os.getpid())
        self.assertTrue(vs.lease_alive(self.lease(owner=me), now))
        self.assertTrue(vs.lease_alive(self.lease(), now))
        self.assertFalse(vs.lease_alive(self.lease(expires_in=-1), now))
        self.assertFalse(vs.lease_alive(self.lease(owner=dead_identity()), now))
        recycled = dict(me, start=me["start"] + 1)
        self.assertFalse(vs.lease_alive(self.lease(owner=recycled), now))

    def test_prune_drops_dead_leases_and_marks_lost_operation_failed(self):
        state = vs.empty_state()
        state["leases"] = {"a": self.lease(owner=dead_identity()), "b": self.lease()}
        state["phase"], state["op"] = "creating", dead_identity()
        live = vs.prune(state, vs.utcnow())
        self.assertEqual(sorted(live), ["b"])
        self.assertEqual(state["phase"], "failed")
        self.assertIsNone(state["op"])

    def test_first_acquire_creates_once_and_second_joins(self):
        first = self.stands.acquire("demo", "e2e", owner=None)
        second = self.stands.acquire("demo", "manual", owner=None)
        self.assertEqual(self.spawned, [["up", "demo"]])
        self.assertEqual((first["phase"], second["phase"]), ("creating", "creating"))
        self.assertEqual(len(self.state()["leases"]), 2)

    def test_acquire_on_ready_stand_does_not_create(self):
        self.set_state(phase="ready", server={"id": "srv"})
        self.assertEqual(self.stands.acquire("demo", "deploy", owner=None)["phase"], "ready")
        self.assertEqual(self.spawned, [])

    def test_ttl_is_capped(self):
        result = self.stands.acquire("demo", "user", ttl=10 * 86400, owner=None)
        expires = vs.parse_iso(result["expires"]) - vs.utcnow()
        self.assertLessEqual(expires.total_seconds(), vs.MAX_TTL)

    def test_last_release_schedules_reaper_and_shared_release_does_not(self):
        self.set_state(phase="ready", server={"id": "srv"})
        a = self.stands.acquire("demo", "e2e", owner=None)["lease"]
        b = self.stands.acquire("demo", "e2e", owner=None)["lease"]
        self.assertEqual(self.stands.release(a)["remaining_leases"], 1)
        self.assertEqual(self.spawned, [])
        self.assertTrue(self.stands.release(b)["reaper"])
        self.assertEqual(self.spawned, [["reap", "demo", "--after", "60"]])
        with self.assertRaises(vs.StageError):
            self.stands.release(b)

    def test_status_heals_missing_reaper_for_idle_stand(self):
        self.set_state(phase="ready", server={"id": "srv"})
        self.stands.status("demo")
        self.assertEqual(self.spawned, [["reap", "demo", "--after", "60"]])

    def test_renew_extends_only_known_lease(self):
        lease = self.stands.acquire("demo", "e2e", ttl=60, owner=None)["lease"]
        self.assertGreater(vs.parse_iso(self.stands.renew(lease, 7200)["expires"]), vs.utcnow() + dt.timedelta(seconds=3600))
        with self.assertRaises(vs.StageError):
            self.stands.renew("missing")


class RemovalTests(Base):
    def ready(self):
        server_id = self.cloud.create_server({"name": "vrata-demo-stage", "metadata": {"vrata-stage": "demo"}})
        self.set_state(phase="ready", server={"id": server_id})
        self.stands.save_caddy = lambda name: None
        return server_id

    def test_live_lease_keeps_the_stand(self):
        self.ready()
        self.stands.acquire("demo", "manual", owner=None)
        result = self.stands.down("demo")
        self.assertEqual(result["reason"], "leases")
        self.assertEqual(self.github.variables, [])

    def test_busy_ci_keeps_the_stand_without_touching_the_variable(self):
        self.ready()
        self.github.busy = [[{"databaseId": 7, "workflowName": "CI", "status": "in_progress"}]]
        result = self.stands.down("demo")
        self.assertEqual((result["reason"], result["runs"]), ("ci_busy", ["CI#7"]))
        self.assertEqual(self.github.variables, [])
        self.assertEqual(self.state()["phase"], "ready")

    def test_run_started_after_switch_restores_the_variable(self):
        server_id = self.ready()
        self.github.busy = [[], [{"databaseId": 8, "workflowName": "CI", "status": "queued"}]]
        self.assertEqual(self.stands.down("demo")["reason"], "ci_busy")
        self.assertEqual(self.github.variables, [("STAGE_PRESENT", "false"), ("STAGE_PRESENT", "true")])
        self.assertIn(server_id, self.cloud.servers)

    def test_idle_stand_switches_ci_off_then_deletes(self):
        server_id = self.ready()
        result = self.stands.down("demo")
        self.assertTrue(result["removed"])
        self.assertEqual(self.github.variables, [("STAGE_PRESENT", "false")])
        self.assertNotIn(server_id, self.cloud.servers)
        self.assertEqual((self.state()["phase"], self.state()["server"]), ("absent", None))

    def test_force_ignores_leases(self):
        server_id = self.ready()
        self.stands.acquire("demo", "manual", owner=None)
        self.spawned.clear()
        self.assertTrue(self.stands.down("demo", force=True)["removed"])
        self.assertNotIn(server_id, self.cloud.servers)
        # The lease still wants a stand, so removal hands over to a new creation.
        self.assertEqual(self.spawned, [["up", "demo"]])

    def test_never_deletes_a_server_it_does_not_own(self):
        for metadata, name in (({}, "vrata-demo-stage"), ({"vrata-stage": "demo"}, "vrata-portal-prod-ru-v1")):
            self.cloud.servers["foreign"] = {"id": "foreign", "name": name, "status": "ACTIVE", "metadata": metadata}
            self.set_state(phase="ready", server={"id": "foreign"})
            self.stands.save_caddy = lambda name: None
            with self.assertRaises(vs.StageError):
                self.stands.down("demo")
            self.assertIn("foreign", self.cloud.servers)
            self.assertEqual(self.state()["phase"], "failed")

    def test_removal_also_finds_a_tagged_server_missing_from_the_registry(self):
        orphan = self.cloud.create_server({"name": "vrata-demo-stage", "metadata": {"vrata-stage": "demo"}})
        self.set_state(phase="failed", server=None)
        self.stands.save_caddy = lambda name: None
        self.stands.down("demo")
        self.assertNotIn(orphan, self.cloud.servers)
        self.assertEqual(self.state()["phase"], "absent")

    def test_reaper_waits_for_ci_then_removes(self):
        server_id = self.ready()
        self.github.busy = [[{"databaseId": 9, "workflowName": "CI", "status": "in_progress"}], [], []]
        self.assertTrue(self.stands.reap("demo", busy_retry=0)["removed"])
        self.assertNotIn(server_id, self.cloud.servers)

    def test_running_operation_blocks_removal(self):
        self.ready()
        self.set_state(phase="creating", op=vs.process_identity(os.getppid()))
        self.assertEqual(self.stands.down("demo")["reason"], "operation_running")


class CreationTests(Base):
    def setUp(self):
        super().setUp()
        self.steps = []
        shell = vs.Shell("/dev/null")
        shell.run = lambda command, **kwargs: self.steps.append(("ssh", command.split()[0]))
        self.stands.checkout_hook = lambda name, workdir: (Path("hook.sh"), workdir)
        self.stands.run_hook = lambda hook, phase, env, capture=False: self.steps.append(("hook", phase, env["STAGE_DEPLOY_SHA"])) or "#cloud-config\n"
        self.stands.adopt_host = lambda name, server_id: shell
        self.stands.restore_caddy = lambda name, shell: self.steps.append(("caddy",))
        self.stands.hook_env = lambda name, sha: {"STAGE_DEPLOY_SHA": sha}
        real_set = self.stands.set_ci
        self.stands.set_ci = lambda name, present: self.steps.append(("ci", present)) or real_set(name, present)

    def test_creation_order(self):
        self.stands.acquire("demo", "e2e", owner=None)
        result = self.stands.up("demo")
        self.assertEqual(result["phase"], "ready")
        kinds = [step[:2] if step[0] == "hook" else step for step in self.steps]
        self.assertEqual(kinds, [("hook", "user-data"), ("ssh", "cloud-init"), ("hook", "prepare"), ("caddy",), ("ci", True), ("hook", "deploy")])
        self.assertEqual([call[0] for call in self.cloud.calls], ["create", "associate"])
        body = self.cloud.calls[0][1]
        self.assertEqual(body["metadata"]["vrata-stage"], "demo")
        self.assertEqual(body["imageRef"], "img")
        self.assertEqual(body["security_groups"], [{"name": "edge"}])
        self.assertEqual(self.state()["server"]["sha"], "a" * 40)

    def test_floating_ip_held_by_another_server_stops_before_creation(self):
        self.cloud.servers["old"] = {"id": "old", "name": "vrata-demo-stage-v1", "status": "ACTIVE", "metadata": {}}
        self.cloud.ports["old"] = [{"id": "port-old"}]
        self.cloud.fip["port_id"] = "port-old"
        with self.assertRaises(vs.StageError):
            self.stands.up("demo")
        self.assertEqual(self.cloud.calls, [])
        self.assertEqual(self.state()["phase"], "failed")

    def test_leftover_owned_server_is_replaced(self):
        old = self.cloud.create_server({"name": "vrata-demo-stage", "metadata": {"vrata-stage": "demo"}})
        self.cloud.calls.clear()
        self.stands.up("demo", sha="b" * 40)
        self.assertEqual([call[0] for call in self.cloud.calls], ["delete", "create", "associate"])
        self.assertNotIn(old, self.cloud.servers)
        self.assertIn(("hook", "deploy", "b" * 40), self.steps)

    def test_foreign_server_with_the_name_stops_creation(self):
        self.cloud.servers["x"] = {"id": "x", "name": "vrata-demo-stage", "status": "ACTIVE", "metadata": {}}
        with self.assertRaises(vs.StageError):
            self.stands.up("demo")
        self.assertIn("x", self.cloud.servers)

    def test_failed_hook_leaves_server_for_inspection_until_leases_end(self):
        self.stands.acquire("demo", "e2e", owner=None)
        self.spawned.clear()
        def failing(hook, phase, env, capture=False):
            if phase == "deploy":
                raise vs.StageError("hook_failed:deploy:1")
            return "#cloud-config\n"
        self.stands.run_hook = failing
        with self.assertRaises(vs.StageError):
            self.stands.up("demo")
        state = self.state()
        self.assertEqual(state["phase"], "failed")
        self.assertIn(state["server"]["id"], self.cloud.servers)
        self.assertEqual(self.spawned, [])


class HelperTests(Base):
    def test_config_refuses_production(self):
        data = json.loads(self.config_path.read_text())
        data["stages"]["demo"]["server_name"] = "vrata-portal-prod-ru-v1"
        self.config_path.write_text(json.dumps(data))
        with self.assertRaises(vs.StageError):
            vs.Config(self.config_path)

    def test_console_keys(self):
        output = ("noise\n-----BEGIN SSH HOST KEY KEYS-----\necdsa-sha2-nistp256 AAAAE2 root@h\n"
                  "ssh-ed25519 AAAAC3 root@h\n-----END SSH HOST KEY KEYS-----\n")
        self.assertEqual(vs.console_host_keys(output), ["ecdsa-sha2-nistp256 AAAAE2 root@h", "ssh-ed25519 AAAAC3 root@h"])
        self.assertEqual(vs.console_host_keys("booting"), [])

    def test_ssh_config_pins_the_host(self):
        config = self.stands.write_ssh_config("demo", ["ssh-ed25519 AAAAkey demo"]).read_text()
        self.assertIn("StrictHostKeyChecking yes", config)
        known = self.stands.registry.path("demo", ".known_hosts").read_text()
        self.assertEqual(known, "203.0.113.7 ssh-ed25519 AAAAkey\n")

    def test_boot_volume_variant(self):
        data = json.loads(self.config_path.read_text())
        data["stages"]["demo"]["boot_volume"] = {"size_gb": 40, "type": "universal.ru-2c"}
        self.config_path.write_text(json.dumps(data))
        body = self.make().server_body("demo", "#cloud-config\n")
        self.assertNotIn("imageRef", body)
        self.assertTrue(body["block_device_mapping_v2"][0]["delete_on_termination"])

    def test_busy_runs_filter_by_workflow_and_branch(self):
        runs = [{"databaseId": 1, "workflowName": "CI", "status": "in_progress", "headBranch": "feature"},
                {"databaseId": 2, "workflowName": "CI", "status": "queued", "headBranch": "main"},
                {"databaseId": 3, "workflowName": "Deliver", "status": "completed", "headBranch": "main"},
                {"databaseId": 4, "workflowName": "Deliver", "status": "waiting", "headBranch": "main"},
                {"databaseId": 5, "workflowName": "Docs", "status": "in_progress", "headBranch": "main"}]

        class Done:
            returncode, stderr, stdout = 0, "", json.dumps(runs)
        github = vs.GitHub(runner=lambda *args, **kwargs: Done())
        self.assertEqual([run["databaseId"] for run in github.busy_runs("o/r", ["CI@main", "Deliver"])], [2, 4])

    def test_durations(self):
        self.assertEqual([vs.parse_duration(x) for x in ("90", "90m", "2h", "1d", "30s")], [5400, 5400, 7200, 86400, 30])
        with self.assertRaises(vs.StageError):
            vs.parse_duration("soon")

    def test_dispatch_follows_the_new_run(self):
        started = vs.iso(vs.utcnow() + dt.timedelta(seconds=1))
        replies = [
            "",
            json.dumps([{"databaseId": 1, "createdAt": "2000-01-01T00:00:00Z", "status": "completed", "conclusion": "success"},
                        {"databaseId": 2, "createdAt": started, "status": "in_progress", "conclusion": ""}]),
            json.dumps([{"databaseId": 2, "createdAt": started, "status": "completed", "conclusion": "failure"}]),
        ]

        class Gh:
            def gh(self, *args, input_text=None):
                return replies.pop(0)
        with self.assertRaisesRegex(vs.StageError, "workflow_failed:deploy.yml:2:failure"):
            vs.dispatch("o/r", "deploy.yml", ["sha=abc"], github=Gh(), poll=0)


if __name__ == "__main__":
    unittest.main()
