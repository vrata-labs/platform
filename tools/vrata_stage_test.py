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
import urllib.parse

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

    def busy_runs(self, repo, workflows, others_except=None):
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
        self.cloud, self.github, self.spawned, self.prefixes = FakeCloud(), FakeGitHub(), [], []
        self.stands = self.make()

    def make(self):
        def spawner(args, log):
            self.prefixes.append(args[:4])
            self.spawned.append(args[4:])
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
        self.assertEqual(self.spawned, [["up", "demo", "--requester", first["lease"]], ["reap", "demo"]])
        self.assertEqual((first["phase"], second["phase"]), ("creating", "creating"))
        self.assertEqual(len(self.state()["leases"]), 2)

    def test_background_operations_keep_the_configuration_and_registry(self):
        self.stands.acquire("demo", "e2e", owner=None)
        config, registry = str(self.config_path.resolve()), str(self.stands.registry.directory.resolve())
        self.assertEqual(self.prefixes, [["--config", config, "--state-dir", registry]] * 2)

    def test_acquire_on_ready_stand_does_not_create(self):
        self.set_state(phase="ready", server={"id": "srv"}, reaper=vs.process_identity(os.getpid()))
        self.assertEqual(self.stands.acquire("demo", "deploy", owner=None)["phase"], "ready")
        self.assertEqual(self.spawned, [])

    def test_ttl_is_capped(self):
        result = self.stands.acquire("demo", "user", ttl=10 * 86400, owner=None)
        expires = vs.parse_iso(result["expires"]) - vs.utcnow()
        self.assertLessEqual(expires.total_seconds(), vs.MAX_TTL)

    def test_release_keeps_the_single_watcher(self):
        self.set_state(phase="ready", server={"id": "srv"})
        a = self.stands.acquire("demo", "e2e", owner=None)["lease"]
        b = self.stands.acquire("demo", "e2e", owner=None)["lease"]
        self.assertEqual(self.stands.release(a)["remaining_leases"], 1)
        self.assertTrue(self.stands.release(b)["watcher"])
        self.assertEqual(self.spawned, [["reap", "demo"]])
        with self.assertRaises(vs.StageError):
            self.stands.release(b)

    def test_status_restarts_a_lost_watcher(self):
        self.set_state(phase="ready", server={"id": "srv"}, reaper=dead_identity())
        self.stands.status("demo")
        self.assertEqual(self.spawned, [["reap", "demo"]])
        self.set_state(phase="absent", server=None, reaper=None)
        self.spawned.clear()
        self.stands.status("demo")
        self.assertEqual(self.spawned, [])

    def test_failed_stand_held_by_another_lease_is_not_replaced(self):
        server_id = self.cloud.create_server({"name": "vrata-demo-stage", "metadata": {"vrata-stage": "demo"}})
        self.cloud.calls.clear()
        self.set_state(phase="failed", server={"id": server_id}, reaper=vs.process_identity(os.getpid()))
        holder = self.stands.acquire("demo", "debug", owner=None)["lease"]
        self.assertEqual(self.spawned, [["up", "demo", "--requester", holder]])
        self.set_state(phase="failed", op=None)
        self.spawned.clear()
        result = self.stands.acquire("demo", "e2e", owner=None)
        self.assertEqual((result["phase"], result["failed_stand_held_by"]), ("failed", [holder]))
        self.assertEqual(self.spawned, [])
        self.assertEqual(self.cloud.calls, [])

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

    def test_lease_taken_while_certificates_are_saved_keeps_the_instance(self):
        server_id = self.ready()
        self.stands.save_caddy = lambda name: self.stands.acquire("demo", "user", owner=None)
        result = self.stands.down("demo")
        self.assertEqual(result["reason"], "leases")
        self.assertIn(server_id, self.cloud.servers)
        self.assertEqual(self.github.variables, [("STAGE_PRESENT", "false"), ("STAGE_PRESENT", "true")])
        self.assertEqual(self.state()["phase"], "ready")

    def test_run_started_before_the_delete_keeps_the_instance(self):
        server_id = self.ready()
        self.github.busy = [[], [], [{"databaseId": 11, "workflowName": "CI", "status": "queued"}]]
        self.assertEqual(self.stands.down("demo")["reason"], "ci_busy")
        self.assertIn(server_id, self.cloud.servers)
        self.assertEqual(self.github.variables[-1], ("STAGE_PRESENT", "true"))

    def test_cancelled_removal_restores_ci_before_releasing_the_stand(self):
        self.ready()
        phases = []
        real = self.github.set_variable
        def recording(repo, name, value):
            phases.append((value, self.stands.registry.read("demo")["phase"]))
            real(repo, name, value)
        self.github.set_variable = recording
        self.github.busy = [[], [{"databaseId": 3, "workflowName": "CI", "status": "queued"}]]
        self.stands.down("demo")
        self.assertEqual(phases, [("false", "destroying"), ("true", "destroying")])
        self.assertEqual(self.state()["phase"], "ready")

    def test_lease_after_the_commit_point_gets_a_new_instance(self):
        server_id = self.ready()
        self.stands.acquire("demo", "e2e", owner=None)
        self.stands.release(next(iter(self.state()["leases"])))
        late = {}
        def busy(repo, workflows, others_except=None):
            if self.github.calls == 2 and not late:
                late.update(self.stands.acquire("demo", "user", owner=None))
            self.github.calls += 1
            return []
        self.github.calls = 0
        self.github.busy_runs = busy
        self.spawned.clear()
        self.assertTrue(self.stands.down("demo")["removed"])
        self.assertNotIn(server_id, self.cloud.servers)
        self.assertEqual(late["phase"], "destroying")
        self.assertIn("new one", late["note"])
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

    def watch(self):
        ticks = iter(range(0, 10**6, 100))
        self.stands.sleep, self.stands.clock = (lambda seconds: None), (lambda: next(ticks))
        return self.stands.reap("demo", poll=0, busy_retry=0)

    def test_watcher_removes_after_lease_expiry_and_waits_for_ci(self):
        server_id = self.ready()
        now = vs.utcnow()
        self.set_state(reaper=vs.process_identity(os.getpid()), leases={"old": {
            "purpose": "e2e", "created": vs.iso(now), "expires": vs.iso(now - dt.timedelta(seconds=1)), "owner": None}})
        self.github.busy = [[{"databaseId": 9, "workflowName": "CI", "status": "in_progress"}]]
        self.assertEqual(self.watch(), {"stage": "demo", "phase": "absent"})
        self.assertNotIn(server_id, self.cloud.servers)
        self.assertIsNone(self.state()["reaper"])

    def test_watcher_keeps_a_stand_in_use(self):
        self.ready()
        self.stands.acquire("demo", "e2e", owner=vs.process_identity(os.getpid()))
        calls = []
        def sleep(seconds):
            calls.append(seconds)
            if len(calls) > 3:
                raise KeyboardInterrupt
        self.stands.sleep = sleep
        with self.assertRaises(KeyboardInterrupt):
            self.stands.reap("demo", poll=7)
        self.assertEqual(calls, [7, 7, 7, 7])
        self.assertEqual(self.state()["phase"], "ready")

    def test_watcher_retries_a_ci_variable_that_could_not_be_restored(self):
        self.ready()
        self.stands.acquire("demo", "e2e", owner=vs.process_identity(os.getpid()))
        self.set_state(ci_variable="restore_pending")
        attempts = []
        def set_variable(repo, name, value):
            attempts.append(value)
            # While CI is switched back the watcher owns the stand, so a removal by another process waits.
            self.assertEqual(self.stands.registry.read("demo")["op"], vs.process_identity(os.getpid()))
            if len(attempts) == 1:
                raise vs.StageError("gh_unavailable")
        self.github.set_variable = set_variable
        sleeps = []
        def sleep(seconds):
            sleeps.append(seconds)
            if len(sleeps) == 2:
                raise KeyboardInterrupt
        self.stands.sleep = sleep
        with self.assertRaises(KeyboardInterrupt):
            self.stands.reap("demo", poll=1)
        self.assertEqual(attempts, ["true", "true"])
        self.assertEqual((self.state()["ci_variable"], self.state()["op"]), ("synced", None))

    def test_failed_ci_restore_is_recorded(self):
        self.ready()
        self.github.busy = [[], [{"databaseId": 3, "workflowName": "CI", "status": "queued"}]]
        def set_variable(repo, name, value):
            if value == "true":
                raise vs.StageError("gh_unavailable")
        self.github.set_variable = set_variable
        self.stands.down("demo")
        self.assertEqual((self.state()["phase"], self.state()["ci_variable"]), ("ready", "restore_pending"))

    def test_only_one_watcher_runs(self):
        self.ready()
        self.set_state(reaper=vs.process_identity(os.getppid()))
        self.assertEqual(self.stands.reap("demo")["watcher"], "already_running")

    def test_watcher_survives_unexpected_errors(self):
        server_id = self.ready()
        self.set_state(reaper=vs.process_identity(os.getpid()))
        failures = [RuntimeError("transport"), vs.StageError("gh_unavailable")]
        real = self.stands.down
        def flaky(name, force=False):
            if failures:
                raise failures.pop(0)
            return real(name, force)
        self.stands.down = flaky
        self.assertEqual(self.watch()["phase"], "absent")
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
        self.stands.save_caddy = lambda name: self.steps.append(("save",))
        real_set = self.stands.set_ci
        self.stands.set_ci = lambda name, present: self.steps.append(("ci", present)) or real_set(name, present)

    def test_creation_order(self):
        self.stands.acquire("demo", "e2e", owner=None)
        result = self.stands.up("demo")
        self.assertEqual(result["phase"], "ready")
        kinds = [step[:2] if step[0] == "hook" else step for step in self.steps]
        self.assertEqual(kinds, [("ci", False), ("hook", "user-data"), ("ssh", "cloud-init"), ("hook", "prepare"), ("caddy",), ("hook", "deploy"), ("ci", True)])
        self.assertEqual([call[0] for call in self.cloud.calls], ["create", "associate"])
        body = self.cloud.calls[0][1]
        self.assertEqual(body["metadata"]["vrata-stage"], "demo")
        self.assertEqual(body["imageRef"], "img")
        self.assertEqual(body["security_groups"], [{"name": "edge"}])
        self.assertEqual(self.state()["server"]["sha"], "a" * 40)

    def test_sha_published_during_creation_is_reported(self):
        shas = iter(["a" * 40, "c" * 40])
        self.github.latest_success_sha = lambda repo, workflow: next(shas)
        self.stands.up("demo")
        self.assertEqual(self.state()["server"]["behind"], "c" * 40)

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

    def test_replacing_a_failed_instance_saves_certificates_first(self):
        old = self.cloud.create_server({"name": "vrata-demo-stage", "metadata": {"vrata-stage": "demo"}})
        self.cloud.calls.clear()
        lease = self.stands.acquire("demo", "e2e", owner=None)["lease"]
        self.set_state(phase="failed", server={"id": old}, op=None)
        self.stands.up("demo", requester=lease)
        self.assertEqual(self.steps[:2], [("ci", False), ("save",)])
        self.assertEqual([call[0] for call in self.cloud.calls], ["delete", "create", "associate"])

    def test_replacement_refuses_while_ci_uses_the_failed_instance(self):
        old = self.cloud.create_server({"name": "vrata-demo-stage", "metadata": {"vrata-stage": "demo"}})
        self.cloud.calls.clear()
        self.set_state(phase="failed", server={"id": old})
        self.github.busy = [[{"databaseId": 5, "workflowName": "CI", "status": "in_progress"}]]
        with self.assertRaisesRegex(vs.StageError, "ci_busy"):
            self.stands.up("demo")
        self.assertEqual(self.cloud.calls, [])

    def test_direct_up_respects_other_users(self):
        old = self.cloud.create_server({"name": "vrata-demo-stage", "metadata": {"vrata-stage": "demo"}})
        self.cloud.calls.clear()
        holder = self.stands.acquire("demo", "debug", owner=None)["lease"]
        self.set_state(phase="failed", server={"id": old}, op=None)
        with self.assertRaisesRegex(vs.StageError, "failed_stand_in_use:" + holder):
            self.stands.up("demo")
        self.set_state(phase="ready")
        with self.assertRaisesRegex(vs.StageError, "stage_ready"):
            self.stands.up("demo")
        self.assertEqual(self.cloud.calls, [])

    def test_refused_background_creation_leaves_a_consistent_phase(self):
        old = self.cloud.create_server({"name": "vrata-demo-stage", "metadata": {"vrata-stage": "demo"}})
        holder = self.stands.acquire("demo", "debug", owner=None)["lease"]
        self.set_state(phase="creating", server={"id": old}, op=vs.process_identity(os.getpid()))
        with self.assertRaisesRegex(vs.StageError, "failed_stand_in_use"):
            self.stands.up("demo", requester="someone-else")
        self.assertEqual((self.state()["phase"], self.state()["op"]), ("failed", None))
        self.assertIn(holder, self.state()["leases"])

    def test_hold_survives_a_creation_whose_answer_was_lost(self):
        # The provider created the server, the answer never arrived: failed, nothing recorded, a tagged orphan.
        orphan = self.cloud.create_server({"name": "vrata-demo-stage", "metadata": {"vrata-stage": "demo"}})
        self.cloud.calls.clear()
        self.set_state(phase="failed", server=None, reaper=vs.process_identity(os.getpid()))
        hold = self.stands.acquire("demo", "user", owner=None)
        self.spawned.clear()
        self.set_state(phase="failed", op=None)
        other = self.stands.acquire("demo", "e2e", owner=None)
        self.assertEqual((other["phase"], other["failed_stand_held_by"]), ("failed", [hold["lease"]]))
        self.assertEqual(self.spawned, [])
        with self.assertRaisesRegex(vs.StageError, "failed_stand_in_use"):
            self.stands.up("demo", requester=other["lease"])
        self.assertEqual(self.cloud.calls, [])
        self.assertIn(orphan, self.cloud.servers)

    def test_lease_taken_while_a_failed_instance_is_replaced_stops_the_delete(self):
        old = self.cloud.create_server({"name": "vrata-demo-stage", "metadata": {"vrata-stage": "demo"}})
        self.cloud.calls.clear()
        lease = self.stands.acquire("demo", "e2e", owner=None)["lease"]
        self.set_state(phase="failed", server={"id": old}, op=None)
        self.stands.save_caddy = lambda name: self.stands.acquire("demo", "debug", owner=None)
        with self.assertRaisesRegex(vs.StageError, "failed_stand_in_use"):
            self.stands.up("demo", requester=lease)
        self.assertEqual(self.cloud.calls, [])

    def test_unavailable_github_after_deploy_keeps_the_stand_ready(self):
        calls = []
        def latest(repo, workflow):
            calls.append(workflow)
            if len(calls) > 1:
                raise vs.StageError("gh_unavailable")
            return "a" * 40
        self.github.latest_success_sha = latest
        self.assertEqual(self.stands.up("demo")["phase"], "ready")
        self.assertEqual(self.state()["phase"], "ready")

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

    def api(self, runs, page_size=100, insert_on_page=None):
        """Fake gh api for the runs list: pages of the newest-first list, optional run inserted between pages."""
        queries = []
        listing = list(runs)

        def runner(args, **kwargs):
            query = args[2]
            queries.append(query)
            page = int(urllib.parse.parse_qs(urllib.parse.urlsplit(query).query)["page"][0])
            if insert_on_page and page == insert_on_page[0]:
                listing.insert(0, insert_on_page[1])
            chunk = listing[(page - 1) * page_size:page * page_size]
            body = {"total_count": len(listing), "workflow_runs": chunk}
            return type("Done", (), {"returncode": 0, "stderr": "", "stdout": json.dumps(body)})()
        return vs.GitHub(runner=runner), queries

    @staticmethod
    def mkrun(run_id, name, status, branch="main"):
        return {"id": run_id, "name": name, "status": status, "head_branch": branch}

    def test_busy_runs_filter_by_workflow_branch_and_status(self):
        github, queries = self.api([self.mkrun(1, "CI", "in_progress", "feature"), self.mkrun(2, "CI", "pending"),
                                    self.mkrun(3, "CI", "completed"), self.mkrun(4, "Deliver", "waiting"),
                                    self.mkrun(5, "Docs", "in_progress")])
        self.assertEqual(sorted(run["databaseId"] for run in github.busy_runs("o/r", ["CI@main", "Deliver"])), [2, 4])
        self.assertTrue(all("status=" not in query and "created=%3E%3D" in query for query in queries))

    def test_an_old_active_run_behind_a_full_page_is_found(self):
        finished = [self.mkrun(n, "Staging Deploy", "completed") for n in range(100, 300)]
        github, queries = self.api(finished + [self.mkrun(1, "Staging Deploy", "in_progress")])
        self.assertEqual([run["databaseId"] for run in github.busy_runs("o/r", ["Staging Deploy"])], [1])
        self.assertEqual(len(queries), 3)

    def test_a_run_created_during_paging_does_not_hide_others(self):
        runs = [self.mkrun(n, "Staging Deploy", "completed") for n in range(10, 110)] + [self.mkrun(2, "Staging Deploy", "queued")]
        github, _ = self.api(runs, insert_on_page=(2, self.mkrun(500, "CI", "completed")))
        self.assertEqual([run["databaseId"] for run in github.busy_runs("o/r", ["Staging Deploy"])], [2])

    def test_other_active_workflows_count_unless_excepted(self):
        github, _ = self.api([self.mkrun(1, "Staging Deploy", "completed"), self.mkrun(2, "CI", "in_progress", "feature"),
                              self.mkrun(3, "PR70 staging read-only verification", "queued", "pr70")])
        busy = github.busy_runs("o/r", ["Staging Deploy"], others_except=["CI"])
        self.assertEqual([(run["databaseId"], run["workflowName"]) for run in busy], [(3, "PR70 staging read-only verification")])
        self.assertEqual(github.busy_runs("o/r", ["Staging Deploy"]), [])

    def test_too_many_recent_runs_refuse_to_guess(self):
        github, _ = self.api([self.mkrun(n, "CI", "completed") for n in range(2100)])
        with self.assertRaisesRegex(vs.StageError, "too_many_recent_runs"):
            github.busy_runs("o/r", ["CI"])

    def test_gh_timeout_is_a_stage_error(self):
        calls = []

        def runner(args, **kwargs):
            calls.append(args)
            raise subprocess.TimeoutExpired(args, 120)
        sleeps = []
        with self.assertRaisesRegex(vs.GitHubUnreachable, "gh_unavailable"):
            vs.GitHub(runner=runner, sleep=sleeps.append).set_variable("o/r", "X", "true")
        self.assertEqual((len(calls), sleeps), (5, [5, 10, 20, 40]))

    @staticmethod
    def gh_results(*results):
        """A gh runner answering with (returncode, stdout, stderr) in turn; records every call."""
        calls, queue = [], list(results)

        def runner(args, **kwargs):
            calls.append(args)
            code, out, err = queue.pop(0)
            return subprocess.CompletedProcess(args, code, out, err)
        return runner, calls

    def test_gh_repeats_network_and_server_failures_until_success(self):
        runner, calls = self.gh_results(
            (1, "", "error connecting to api.github.com\ncheck your internet connection"),
            (1, "", "HTTP 502: Bad Gateway (https://api.github.com/graphql)"),
            (0, '[{"headSha": "abc"}]', ""))
        sleeps = []
        self.assertEqual(vs.GitHub(runner=runner, sleep=sleeps.append).latest_success_sha("o/r", "CI"), "abc")
        self.assertEqual((len(calls), sleeps), (3, [5, 10]))

    def test_gh_does_not_repeat_refusals_or_a_missing_binary(self):
        runner, calls = self.gh_results((1, "", "HTTP 404: Not Found (https://api.github.com/repos/o/r)"))
        with self.assertRaisesRegex(vs.StageError, "gh_failed:run list --repo:HTTP 404") as caught:
            vs.GitHub(runner=runner, sleep=lambda s: None).latest_success_sha("o/r", "CI")
        self.assertNotIsInstance(caught.exception, vs.GitHubUnreachable)
        self.assertEqual(len(calls), 1)

        def missing(args, **kwargs):
            raise FileNotFoundError("gh")
        with self.assertRaisesRegex(vs.StageError, "gh_unavailable:.*FileNotFoundError") as caught:
            vs.GitHub(runner=missing, sleep=lambda s: None).set_variable("o/r", "X", "true")
        self.assertNotIsInstance(caught.exception, vs.GitHubUnreachable)

    def test_gh_gives_up_after_five_attempts_and_never_repeats_an_unsafe_call(self):
        runner, calls = self.gh_results(*[(1, "", "read: connection reset by peer")] * 5)
        with self.assertRaisesRegex(vs.GitHubUnreachable, "connection reset"):
            vs.GitHub(runner=runner, sleep=lambda s: None).set_variable("o/r", "X", "true")
        self.assertEqual(len(calls), 5)
        runner, calls = self.gh_results((1, "", "error connecting to api.github.com"))
        with self.assertRaises(vs.GitHubUnreachable):
            vs.GitHub(runner=runner, sleep=lambda s: None).gh("workflow", "run", "x.yml", retry=False)
        self.assertEqual(len(calls), 1)

    class DispatchGh:
        """Fake GitHub for dispatch: answers polls from a script and records dispatches."""

        def __init__(self, dispatch_errors, polls):
            self.dispatch_errors, self.polls, self.requests, self.calls = list(dispatch_errors), list(polls), [], []

        def gh(self, *args, input_text=None, retry=True):
            self.calls.append((args[:2], retry))
            if args[0] == "workflow":
                self.requests.append(json.loads(input_text)["request"])
                if self.dispatch_errors.pop(0):
                    raise vs.GitHubUnreachable("gh_failed:workflow run x.yml:error connecting to api.github.com")
                return ""
            answer = self.polls.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return json.dumps(answer(self.requests[0]) if callable(answer) else answer)

    def test_dispatch_after_a_lost_answer_follows_the_run_that_was_created(self):
        mine = lambda request: [{"databaseId": 5, "displayTitle": f"Staging Deploy {request}", "status": "completed",
                                 "conclusion": "success"}]
        github = self.DispatchGh([True], [[], mine])
        self.assertEqual(vs.dispatch("o/r", "x.yml", [], github=github, poll=0), {"run": 5, "conclusion": "success"})
        self.assertEqual(len(github.requests), 1)
        self.assertIn((("workflow", "run"), False), github.calls)

    def test_dispatch_repeats_a_start_that_never_appeared_with_the_same_request(self):
        mine = lambda request: [{"databaseId": 6, "displayTitle": f"Staging Deploy {request}", "status": "completed",
                                 "conclusion": "success"}]
        github = self.DispatchGh([True, False], [[], [], [], mine])
        self.assertEqual(vs.dispatch("o/r", "x.yml", [], github=github, poll=0, confirm_polls=3)["run"], 6)
        self.assertEqual(len(github.requests), 2)
        self.assertEqual(github.requests[0], github.requests[1])
        github = self.DispatchGh([True, True], [[], [], []])
        with self.assertRaisesRegex(vs.StageError, "workflow_not_started:x.yml"):
            vs.dispatch("o/r", "x.yml", [], github=github, poll=0, confirm_polls=1, dispatches=2)

    def test_dispatch_skips_polls_that_fail_on_the_network(self):
        running = lambda request: [{"databaseId": 7, "displayTitle": f"Staging Deploy {request}", "status": "in_progress",
                                    "conclusion": ""}]
        done = lambda request: [{"databaseId": 7, "displayTitle": f"Staging Deploy {request}", "status": "completed",
                                 "conclusion": "success"}]
        unreachable = vs.GitHubUnreachable("gh_failed:run list --repo:error connecting to api.github.com")
        github = self.DispatchGh([False], [running, unreachable, unreachable, done])
        self.assertEqual(vs.dispatch("o/r", "x.yml", [], github=github, poll=0)["run"], 7)
        refusal = vs.StageError("gh_failed:run list --repo:HTTP 401: Bad credentials")
        github = self.DispatchGh([False], [running, refusal])
        with self.assertRaisesRegex(vs.StageError, "HTTP 401"):
            vs.dispatch("o/r", "x.yml", [], github=github, poll=0)

    def test_durations(self):
        self.assertEqual([vs.parse_duration(x) for x in ("90", "90m", "2h", "1d", "30s")], [5400, 5400, 7200, 86400, 30])
        with self.assertRaises(vs.StageError):
            vs.parse_duration("soon")

    def test_dispatch_follows_its_own_run(self):
        seen = {}

        class Gh:
            calls = 0

            def gh(self, *args, input_text=None, retry=True):
                if args[0] == "workflow":
                    seen.update(json.loads(input_text))
                    return ""
                Gh.calls += 1
                mine = f"Deliver stage {seen['request']}"
                if Gh.calls == 1:
                    return json.dumps([{"databaseId": 1, "displayTitle": "Deliver prod abcdefabcdef", "status": "completed", "conclusion": "success"},
                                       {"databaseId": 2, "displayTitle": mine, "status": "in_progress", "conclusion": ""}])
                return json.dumps([{"databaseId": 2, "displayTitle": mine, "status": "completed", "conclusion": "failure"}])
        with self.assertRaisesRegex(vs.StageError, "workflow_failed:deliver.yml:2:failure"):
            vs.dispatch("o/r", "deliver.yml", ["target=stage"], github=Gh(), poll=0)
        self.assertEqual(seen["target"], "stage")
        self.assertRegex(seen["request"], r"^[0-9a-f]{12}$")


if __name__ == "__main__":
    unittest.main()
