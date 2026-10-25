#!/usr/bin/env python3
"""On-demand staging stands shared by local agent sessions, CI and the owner.

A stand exists only while someone needs it. Each user of a stand holds a lease; creating a
stand is the first lease, removing it waits for the last one and for CI. Selectel credentials
live only on the operator machine, so creation and removal run here. Commands print JSON.
See docs/plans/2026-10-25-on-demand-stages.md.
"""

import argparse
from contextlib import contextmanager
import base64
import datetime as dt
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse

PURPOSE_TTL = {"deploy": 3 * 3600, "e2e": 2 * 3600, "debug": 2 * 3600, "manual": 4 * 3600, "user": 8 * 3600}
MAX_TTL = 24 * 3600
AGENT_COMMANDS = {"claude", "opencode"}
BUSY_STATUSES = {"queued", "in_progress", "waiting", "requested", "pending"}
HOST_KEY_TYPES = ("ed25519", "ecdsa", "rsa")
DEFAULT_CONFIG = Path.home() / "inprojects/vrata/.secrets/stage/stages.json"
DEFAULT_STATE = Path.home() / ".local/state/vrata-stage"
SELF = Path(__file__).resolve()


class StageError(Exception):
    pass


def utcnow():
    return dt.datetime.now(dt.timezone.utc)


def iso(moment):
    return moment.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(text):
    return dt.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)


def parse_duration(text):
    match = re.fullmatch(r"(\d+)([smhd]?)", text.strip())
    if not match:
        raise StageError("invalid_duration:" + text)
    return int(match.group(1)) * {"": 60, "s": 1, "m": 60, "h": 3600, "d": 86400}[match.group(2)]


# ---------------------------------------------------------------- processes

def proc_stat(pid):
    """(comm, ppid, start ticks) of a live process, or None."""
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return None
    comm = raw[raw.index("(") + 1:raw.rindex(")")]
    fields = raw[raw.rindex(")") + 2:].split()
    return comm, int(fields[1]), int(fields[19])


def process_identity(pid):
    stat = proc_stat(pid)
    return {"pid": pid, "start": stat[2]} if stat else None


def process_alive(identity):
    if not identity:
        return False
    stat = proc_stat(identity["pid"])
    # A recycled PID has another start time.
    return stat is not None and stat[2] == identity["start"]


def agent_owner(start_pid=None):
    """Nearest ancestor that is a Claude Code or opencode process."""
    if os.environ.get("VRATA_STAGE_OWNER_PID"):
        return process_identity(int(os.environ["VRATA_STAGE_OWNER_PID"]))
    pid = start_pid or os.getppid()
    for _ in range(64):
        stat = proc_stat(pid)
        if stat is None or pid <= 1:
            return None
        if stat[0] in AGENT_COMMANDS:
            return {"pid": pid, "start": stat[2], "command": stat[0]}
        pid = stat[1]
    return None


# ---------------------------------------------------------------- configuration

class Config:
    def __init__(self, path):
        self.path = Path(path)
        try:
            data = json.loads(self.path.read_text())
        except (OSError, ValueError):
            raise StageError("config_unreadable:" + str(self.path)) from None
        self.secrets_root = Path(data.get("secrets_root") or self.path.parent.parent).expanduser()
        self.selectel = data.get("selectel", {})
        self.stages = data.get("stages", {})
        for name, stage in self.stages.items():
            if not re.fullmatch(r"[a-z][a-z0-9-]{1,30}", name):
                raise StageError("config_invalid_stage_name:" + name)
            for key in ("server_name", "flavor", "image", "network", "floating_ip", "admin", "github", "hook"):
                if key not in stage:
                    raise StageError(f"config_missing:{name}.{key}")
            # Production is out of scope by construction; refuse anything that looks like it.
            if "prod" in stage["server_name"]:
                raise StageError("config_production_server_refused:" + stage["server_name"])

    def stage(self, name):
        if name not in self.stages:
            raise StageError("unknown_stage:" + name)
        return self.stages[name]

    def secret_path(self, relative):
        path = Path(relative).expanduser()
        return path if path.is_absolute() else self.secrets_root / path


# ---------------------------------------------------------------- state

def empty_state():
    return {"schema": 1, "phase": "absent", "server": None, "op": None, "reaper": None, "leases": {}, "history": []}


class Registry:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)

    def path(self, stage, suffix):
        return self.directory / f"{stage}{suffix}"

    @contextmanager
    def locked(self, stage):
        fd = os.open(self.path(stage, ".lock"), os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            path = self.path(stage, ".json")
            try:
                state = json.loads(path.read_text()) if path.exists() else empty_state()
            except ValueError:
                raise StageError("state_corrupt:" + str(path)) from None
            before = json.dumps(state, sort_keys=True)
            yield state
            if json.dumps(state, sort_keys=True) != before:
                state["history"] = state["history"][-50:]
                tmp = path.with_suffix(".json.tmp")
                tmp.write_text(json.dumps(state, indent=1, sort_keys=True) + "\n")
                os.chmod(tmp, 0o600)
                os.replace(tmp, path)
        finally:
            os.close(fd)

    def read(self, stage):
        with self.locked(stage) as state:
            return json.loads(json.dumps(state))


def record(state, event, **details):
    state["history"].append({"at": iso(utcnow()), "event": event, **details})


def lease_alive(lease, now):
    if parse_iso(lease["expires"]) <= now:
        return False
    return lease.get("owner") is None or process_alive(lease["owner"])


def prune(state, now):
    """Drop expired leases and leases of finished sessions; return the live ones."""
    for lease_id, lease in list(state["leases"].items()):
        if not lease_alive(lease, now):
            reason = "expired" if parse_iso(lease["expires"]) <= now else "owner_exited"
            del state["leases"][lease_id]
            record(state, "lease_dropped", lease=lease_id, reason=reason)
    for key in ("op", "reaper"):
        if state.get(key) and not process_alive(state[key]):
            if key == "op" and state["phase"] in ("creating", "destroying"):
                record(state, "operation_lost", phase=state["phase"])
                state["phase"] = "failed"
            state[key] = None
    return state["leases"]


# ---------------------------------------------------------------- external systems

class Selectel:
    def __init__(self, config, workdir):
        cli = Path(config.selectel.get("cli", "")).expanduser()
        if not cli.is_file():
            raise StageError("selectel_cli_missing")
        spec = importlib.util.spec_from_file_location("selectel_cli", cli)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.region = config.selectel.get("region", "ru-2")
        self.workdir = Path(workdir)

    def call(self, method, service, path, body=None, expect=(200, 201, 202, 204), retry=None):
        # The API link drops connections now and then; only requests safe to repeat are retried.
        attempts = 4 if (retry if retry is not None else method in ("GET", "PUT", "DELETE")) else 1
        for attempt in range(attempts):
            body_file = None
            try:
                if body is not None:
                    fd, body_file = tempfile.mkstemp(dir=self.workdir, suffix=".json")
                    with os.fdopen(fd, "w") as stream:
                        json.dump(body, stream)
                result = self.module.call(method, service, self.region, path, body_file)
                break
            except Exception as error:  # the CLI raises plain RuntimeError/KeyError on transport faults
                if attempt + 1 == attempts:
                    raise StageError(f"selectel_transport:{method}:{path}:{type(error).__name__}") from None
                time.sleep(5 * (attempt + 1))
            finally:
                if body_file:
                    os.unlink(body_file)
        if result["status"] not in expect:
            detail = json.dumps(result.get("data"))[:300]
            raise StageError(f"selectel_http_{result['status']}:{method}:{path}:{detail}")
        return result["status"], result["data"]

    def server(self, server_id):
        status, data = self.call("GET", "compute", f"servers/{server_id}", expect=(200, 404))
        return None if status == 404 else data["server"]

    def servers_named(self, name):
        _, data = self.call("GET", "compute", "servers/detail?name=" + urllib.parse.quote(f"^{name}$"))
        return [server for server in data["servers"] if server["name"] == name]

    def create_server(self, body):
        _, data = self.call("POST", "compute", "servers", {"server": body})
        return data["server"]["id"]

    def delete_server(self, server_id):
        self.call("DELETE", "compute", f"servers/{server_id}", expect=(204, 404))

    def console(self, server_id):
        _, data = self.call("POST", "compute", f"servers/{server_id}/action", {"os-getConsoleOutput": {"length": 2000}}, retry=True)
        return data.get("output") or ""

    def server_ports(self, server_id):
        _, data = self.call("GET", "network", f"v2.0/ports?device_id={server_id}")
        return data["ports"]

    def floating_ip(self, address):
        _, data = self.call("GET", "network", f"v2.0/floatingips?floating_ip_address={address}")
        if not data["floatingips"]:
            raise StageError("floating_ip_not_in_project:" + address)
        return data["floatingips"][0]

    def port(self, port_id):
        status, data = self.call("GET", "network", f"v2.0/ports/{port_id}", expect=(200, 404))
        return None if status == 404 else data["port"]

    def associate(self, fip_id, port_id):
        self.call("PUT", "network", f"v2.0/floatingips/{fip_id}", {"floatingip": {"port_id": port_id}})


class GitHub:
    def __init__(self, runner=subprocess.run):
        self.runner = runner

    def gh(self, *args, input_text=None):
        result = self.runner(["gh", *args], input=input_text, text=True, capture_output=True, timeout=120)
        if result.returncode:
            raise StageError("gh_failed:" + " ".join(args[:3]) + ":" + result.stderr.strip()[:300])
        return result.stdout

    def set_variable(self, repo, name, value):
        self.gh("variable", "set", name, "--repo", repo, "--body", value)

    def busy_runs(self, repo, workflows):
        """All active runs of the listed workflows, filtered by status on the API side so a long run is not
        lost behind newer ones; "CI@main" limits a workflow to one branch."""
        wanted = [entry.partition("@") for entry in workflows]
        busy = []
        for status in sorted(BUSY_STATUSES):
            data = json.loads(self.gh("api", f"repos/{repo}/actions/runs?status={status}&per_page=100"))
            if data["total_count"] > len(data["workflow_runs"]):
                # More active runs than one page: keep the stand rather than guess.
                return [{"databaseId": 0, "workflowName": f"{data['total_count']} {status} runs", "status": status}]
            busy += [{"databaseId": run["id"], "workflowName": run["name"], "status": run["status"],
                      "headBranch": run["head_branch"]}
                     for run in data["workflow_runs"]
                     if any(run["name"] == name and (not branch or run["head_branch"] == branch) for name, _, branch in wanted)]
        return busy

    def latest_success_sha(self, repo, workflow):
        runs = json.loads(self.gh("run", "list", "--repo", repo, "--workflow", workflow, "--branch", "main",
                                  "--status", "success", "--limit", "1", "--json", "headSha"))
        if not runs:
            raise StageError("no_successful_run:" + workflow)
        return runs[0]["headSha"]


class Shell:
    """SSH to a stand with the admin key and a pinned host identity."""

    def __init__(self, ssh_config, alias="stage"):
        self.ssh_config = str(ssh_config)
        self.alias = alias

    def run(self, command, input_bytes=None, timeout=600, check=True):
        result = subprocess.run(["ssh", "-F", self.ssh_config, self.alias, command], input=input_bytes,
                                capture_output=True, timeout=timeout)
        if check and result.returncode:
            raise StageError(f"ssh_failed:{result.returncode}:{result.stderr.decode(errors='replace').strip()[-300:]}")
        return result


# ---------------------------------------------------------------- stand operations

class Stands:
    def __init__(self, config, registry, cloud=None, github=None, spawner=None, log=None):
        self.config = config
        self.registry = registry
        self._cloud = cloud
        self.github = github or GitHub()
        self.spawner = spawner or spawn_detached
        self.log = log or (lambda message: print(f"{iso(utcnow())} {message}", file=sys.stderr, flush=True))
        self.sleep, self.clock = time.sleep, time.monotonic

    @property
    def cloud(self):
        if self._cloud is None:
            self._cloud = Selectel(self.config, self.registry.directory)
        return self._cloud

    # -------- public URL and SSH material

    def url(self, name):
        stage = self.config.stage(name)
        return stage.get("url") or f"https://{stage['floating_ip']}.sslip.io"

    def pinned_keys(self, name):
        directory = self.config.secret_path(self.config.stage(name).get("host_keys", f"stage/{name}/host-keys"))
        keys = {}
        for key_type in HOST_KEY_TYPES:
            private = directory / f"ssh_host_{key_type}_key"
            if private.is_file() and private.with_suffix(".pub").is_file():
                keys[key_type] = (private, private.with_suffix(".pub"))
        if "ed25519" not in keys:
            raise StageError("pinned_host_keys_missing:" + str(directory))
        return keys

    def write_ssh_config(self, name, host_keys):
        """host_keys: public key lines that identify the host for this connection."""
        stage = self.config.stage(name)
        known = self.registry.path(name, ".known_hosts")
        known.write_text("".join(f"{stage['floating_ip']} {' '.join(line.split()[:2])}\n" for line in host_keys))
        os.chmod(known, 0o600)
        config = self.registry.path(name, ".ssh_config")
        config.write_text(
            "Host stage\n"
            f"  HostName {stage['floating_ip']}\n"
            f"  User {stage['admin']['user']}\n"
            f"  IdentityFile {self.config.secret_path(stage['admin']['key'])}\n"
            "  IdentitiesOnly yes\n"
            f"  UserKnownHostsFile {known}\n"
            "  StrictHostKeyChecking yes\n"
            "  BatchMode yes\n"
            "  ConnectTimeout 10\n"
            "  ServerAliveInterval 15\n"
            "  ServerAliveCountMax 8\n")
        os.chmod(config, 0o600)
        return config

    def pinned_shell(self, name):
        public = [path.read_text().strip() for _, path in self.pinned_keys(name).values()]
        return Shell(self.write_ssh_config(name, public))

    # -------- leases

    def spawn(self, args, name):
        """Background operations run with the same configuration and registry as their parent."""
        prefix = ["--config", str(self.config.path.resolve()), "--state-dir", str(self.registry.directory.resolve())]
        return self.spawner(prefix + args, self.registry.path(name, ".log"))

    def acquire(self, name, purpose, ttl=None, note="", sha=None, owner="auto"):
        stage = self.config.stage(name)
        if purpose not in PURPOSE_TTL:
            raise StageError("invalid_purpose:" + purpose)
        ttl = min(ttl or PURPOSE_TTL[purpose], MAX_TTL)
        now = utcnow()
        lease_id = secrets.token_hex(4)
        with self.registry.locked(name) as state:
            prune(state, now)
            state["leases"][lease_id] = {
                "purpose": purpose, "created": iso(now), "expires": iso(now + dt.timedelta(seconds=ttl)),
                "owner": agent_owner() if owner == "auto" else owner, "cwd": os.getcwd(), "note": note[:200]}
            record(state, "lease_acquired", lease=lease_id, purpose=purpose)
            self.ensure_locked(name, state, sha, requester=lease_id)
            phase = state["phase"]
            others = sorted(set(state["leases"]) - {lease_id})
        result = {"stage": name, "lease": lease_id, "phase": phase, "expires": iso(now + dt.timedelta(seconds=ttl)),
                  "url": self.url(name), "repo": stage["github"]["repo"]}
        if phase == "failed":
            # Other users may still inspect the failed instance; it is replaced once they are gone.
            result["failed_stand_held_by"] = others
        return result

    def ensure_locked(self, name, state, sha=None, requester=None):
        """Start creation when someone holds a lease and nothing runs. A failed instance that still exists is
        replaced only for its sole user: another lease holder may be inspecting it."""
        if not state["op"] and state["leases"] and state["phase"] in ("absent", "failed"):
            if not (state["phase"] == "failed" and state["server"] and set(state["leases"]) - {requester}):
                state["phase"] = "creating"
                state["op"] = self.spawn(["up", name] + (["--sha", sha] if sha else [])
                                         + (["--requester", requester] if requester else []), name)
                record(state, "create_started", pid=state["op"]["pid"])
        self.schedule_watcher_locked(name, state)

    def renew(self, lease_id, ttl=None):
        for name in self.config.stages:
            with self.registry.locked(name) as state:
                lease = state["leases"].get(lease_id)
                if lease:
                    now = utcnow()
                    seconds = min(ttl or PURPOSE_TTL[lease["purpose"]], MAX_TTL)
                    lease["expires"] = iso(now + dt.timedelta(seconds=seconds))
                    record(state, "lease_renewed", lease=lease_id)
                    return {"stage": name, "lease": lease_id, "expires": lease["expires"]}
        raise StageError("unknown_lease:" + lease_id)

    def release(self, lease_id, now_down=False):
        for name in self.config.stages:
            with self.registry.locked(name) as state:
                if lease_id not in state["leases"]:
                    continue
                del state["leases"][lease_id]
                record(state, "lease_released", lease=lease_id)
                live = prune(state, utcnow())
                self.schedule_watcher_locked(name, state)
                result = {"stage": name, "lease": lease_id, "remaining_leases": len(live),
                          "watcher": bool(state["reaper"])}
            if not result["remaining_leases"] and now_down:
                result["down"] = self.down(name)
            return result
        raise StageError("unknown_lease:" + lease_id)

    def schedule_watcher_locked(self, name, state):
        """One watcher per existing stand notices expired leases and finished sessions on its own."""
        if (state["phase"] != "absent" or state["server"]) and not state["reaper"]:
            state["reaper"] = self.spawn(["reap", name], name)
            record(state, "watcher_started", pid=state["reaper"]["pid"])

    # -------- status and waiting

    def status(self, name, cloud=False):
        stage = self.config.stage(name)
        with self.registry.locked(name) as state:
            prune(state, utcnow())
            self.schedule_watcher_locked(name, state)
            view = json.loads(json.dumps(state))
        view.pop("history")
        view.update(stage=name, url=self.url(name), repo=stage["github"]["repo"])
        if cloud and view["server"]:
            server = self.cloud.server(view["server"]["id"])
            view["cloud"] = server and {"status": server["status"], "name": server["name"]}
        return view

    def wait(self, name, timeout, sha=None, poll=10):
        deadline = time.monotonic() + timeout
        while True:
            with self.registry.locked(name) as state:
                prune(state, utcnow())
                if state["phase"] == "absent":
                    self.ensure_locked(name, state, sha)
                phase = state["phase"]
            if phase == "ready":
                return {"stage": name, "phase": phase, "url": self.url(name)}
            if phase == "failed":
                raise StageError("stage_failed:" + name + ":" + self.log_tail(name))
            if phase == "absent":
                raise StageError("stage_absent_without_lease:" + name)
            if time.monotonic() >= deadline:
                return {"stage": name, "phase": phase, "waiting": True, "log": str(self.registry.path(name, ".log"))}
            time.sleep(poll)

    def log_tail(self, name, lines=8):
        path = self.registry.path(name, ".log")
        if not path.exists():
            return ""
        return " | ".join(path.read_text(errors="replace").strip().splitlines()[-lines:])

    # -------- removal

    def ci_busy(self, name):
        github = self.config.stage(name)["github"]
        return self.github.busy_runs(github["repo"], github.get("busy_workflows", []))

    def set_ci(self, name, present):
        github = self.config.stage(name)["github"]
        if github.get("variable"):
            self.github.set_variable(github["repo"], github["variable"],
                                     github.get("present", "true") if present else github.get("absent", "false"))

    def down(self, name, force=False):
        me = process_identity(os.getpid())
        with self.registry.locked(name) as state:
            live = prune(state, utcnow())
            if live and not force:
                return {"stage": name, "removed": False, "reason": "leases", "leases": sorted(live)}
            if state["op"] and state["op"]["pid"] != os.getpid():
                return {"stage": name, "removed": False, "reason": "operation_running", "phase": state["phase"]}
            if state["phase"] == "absent" and not state["server"]:
                return {"stage": name, "removed": False, "reason": "absent"}
            previous = state["phase"]
            state["phase"], state["op"] = "destroying", me
            record(state, "destroy_started", force=force)
        switched = False
        try:
            if force:
                try:
                    self.set_ci(name, False)
                except StageError as error:
                    self.log(f"ci variable not switched: {error}")
            else:
                # Check, switch CI off, check again: a run that started in between keeps the stand.
                busy = self.ci_busy(name)
                if not busy:
                    self.set_ci(name, False)
                    switched = True
                    busy = self.ci_busy(name)
                if busy:
                    return self.cancel_destroy(name, previous, switched, [], busy)
            self.save_caddy(name)
            with self.registry.locked(name) as state:
                # Final barrier: a lease or a CI run that arrived while certificates were saved keeps this
                # instance. Deletion is requested under the lock, so a later lease waits for a new instance.
                live = [] if force else sorted(prune(state, utcnow()))
                busy = [] if force or live else self.ci_busy(name)
                if not live and not busy:
                    servers = self.owned_servers(name, state["server"], strict=False)
                    for server_id in servers:
                        self.request_delete(name, server_id)
                    record(state, "delete_requested", servers=servers)
            if live or busy:
                return self.cancel_destroy(name, previous, switched, live, busy)
            for server_id in servers:
                self.wait_deleted(server_id)
            with self.registry.locked(name) as state:
                state["phase"], state["server"], state["op"] = "absent", None, None
                record(state, "destroyed", servers=servers)
                if prune(state, utcnow()):
                    self.ensure_locked(name, state)
            return {"stage": name, "removed": bool(servers), "servers": servers}
        except Exception as error:
            with self.registry.locked(name) as state:
                state["phase"], state["op"] = "failed", None
                record(state, "destroy_failed", error=str(error)[:300])
            raise

    def cancel_destroy(self, name, previous, switched, leases, runs):
        with self.registry.locked(name) as state:
            state["phase"], state["op"] = previous, None
            record(state, "destroy_cancelled", leases=leases, runs=[run["databaseId"] for run in runs])
        if switched and previous == "ready":
            self.set_ci(name, True)
        if leases:
            return {"stage": name, "removed": False, "reason": "leases", "leases": leases}
        return {"stage": name, "removed": False, "reason": "ci_busy",
                "runs": [f"{run['workflowName']}#{run['databaseId']}" for run in runs]}

    def owned_servers(self, name, recorded, strict=True):
        """The recorded server plus tagged servers with the stage name: a creation interrupted between the API
        call and the registry leaves one behind. A foreign server with the same name is never touched."""
        stage = self.config.stage(name)
        servers = [recorded["id"]] if recorded else []
        for server in self.cloud.servers_named(stage["server_name"]):
            if server.get("metadata", {}).get("vrata-stage") == name:
                if server["id"] not in servers:
                    servers.append(server["id"])
            elif strict:
                raise StageError("server_name_taken:" + server["id"])
        return servers

    def request_delete(self, name, server_id):
        stage = self.config.stage(name)
        server = self.cloud.server(server_id)
        if server is None:
            return
        if server["name"] != stage["server_name"] or server.get("metadata", {}).get("vrata-stage") != name:
            raise StageError(f"refusing_to_delete_unowned_server:{server_id}:{server['name']}")
        self.log(f"deleting server {server_id}")
        self.cloud.delete_server(server_id)

    def wait_deleted(self, server_id):
        for _ in range(60):
            if self.cloud.server(server_id) is None:
                return
            self.sleep(5)
        raise StageError("server_delete_timeout:" + server_id)

    def reap(self, name, poll=60, busy_retry=300):
        """Watch the stand while it exists; remove it after the grace period without leases and operations."""
        grace = int(self.config.stage(name).get("grace_minutes", 20)) * 60
        idle_since = None
        while True:
            with self.registry.locked(name) as state:
                live = prune(state, utcnow())
                if state["phase"] == "absent" and not state["server"]:
                    if state["reaper"] and state["reaper"]["pid"] == os.getpid():
                        state["reaper"] = None
                    return {"stage": name, "phase": "absent"}
                in_use = bool(live or state["op"])
            if in_use:
                idle_since = None
                self.sleep(poll)
                continue
            idle_since = self.clock() if idle_since is None else idle_since
            left = grace - (self.clock() - idle_since)
            if left > 0:
                self.sleep(min(poll, left))
                continue
            try:
                result = self.down(name)
            except StageError as error:
                self.log(f"removal failed, retrying later: {error}")
                self.sleep(busy_retry)
                continue
            if result.get("reason") == "ci_busy":
                self.log(f"watcher waits for CI: {result['runs']}")
                self.sleep(busy_retry)
            elif not result.get("removed") and result.get("reason") != "absent":
                idle_since = None

    # -------- caddy certificates survive the server

    def caddy_cache(self, name):
        return self.config.secret_path(f"stage/{name}/caddy-data.tgz")

    def save_caddy(self, name):
        volume = self.config.stage(name).get("caddy_volume")
        if not volume:
            return
        try:
            shell = self.pinned_shell(name)
            result = shell.run(f"set -e; m=$(sudo docker volume inspect -f '{{{{.Mountpoint}}}}' {volume['name']}); "
                               "sudo tar -C \"$m\" -czf - .", timeout=180)
        except (StageError, subprocess.TimeoutExpired) as error:
            self.log(f"caddy data not saved, previous cache kept: {error}")
            return
        cache = self.caddy_cache(name)
        cache.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = cache.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(result.stdout)
        os.replace(tmp, cache)
        self.log(f"caddy data saved ({len(result.stdout)} bytes)")

    def restore_caddy(self, name, shell):
        volume = self.config.stage(name).get("caddy_volume")
        cache = self.caddy_cache(name)
        if not volume or not cache.is_file():
            return False
        labels = f"--label com.docker.compose.project={volume['project']} --label com.docker.compose.volume={volume['volume']}"
        shell.run(f"set -e; sudo docker volume inspect {volume['name']} >/dev/null 2>&1 || sudo docker volume create {labels} {volume['name']} >/dev/null; "
                  f"m=$(sudo docker volume inspect -f '{{{{.Mountpoint}}}}' {volume['name']}); sudo tar -C \"$m\" -xzf -",
                  input_bytes=cache.read_bytes(), timeout=180)
        self.log("caddy data restored")
        return True

    # -------- creation

    def up(self, name, sha=None, requester=None, force=False):
        stage = self.config.stage(name)
        me = process_identity(os.getpid())
        with self.registry.locked(name) as state:
            if state["op"] and state["op"]["pid"] != os.getpid() and process_alive(state["op"]):
                raise StageError("operation_running:" + state["phase"])
            others = sorted(set(prune(state, utcnow())) - {requester})
            refusal = None
            if state["phase"] == "ready" and not force:
                refusal = "stage_ready"
            elif state["server"] and others and not force:
                refusal = "failed_stand_in_use:" + ",".join(others)
            if refusal:
                if state["op"] and state["op"]["pid"] == os.getpid():
                    state["phase"] = "failed" if state["server"] else "absent"
                    state["op"] = None
                raise StageError(refusal)
            state["phase"], state["op"] = "creating", me
            self.schedule_watcher_locked(name, state)
            leftover = state["server"]
        try:
            stale = self.owned_servers(name, leftover)
            if stale:
                # Replacing a failed instance is a removal too: CI must not be using it.
                busy = self.ci_busy(name)
                if busy and not force:
                    raise StageError("ci_busy:" + ",".join(f"{run['workflowName']}#{run['databaseId']}" for run in busy))
                self.save_caddy(name)
                for server_id in stale:
                    self.request_delete(name, server_id)
                for server_id in stale:
                    self.wait_deleted(server_id)
                with self.registry.locked(name) as state:
                    state["server"] = None
                    record(state, "replaced", servers=stale)
            github = stage["github"]
            sha = sha or self.github.latest_success_sha(github["repo"], github["deploy_after"])
            fip = self.cloud.floating_ip(stage["floating_ip"])
            if fip.get("port_id") and self.cloud.port(fip["port_id"]):
                raise StageError("floating_ip_in_use:" + fip["port_id"])
            with tempfile.TemporaryDirectory(prefix="vrata-stage-hook-") as workdir:
                hook = self.checkout_hook(name, Path(workdir))
                env = self.hook_env(name, sha)
                user_data = self.run_hook(hook, "user-data", env, capture=True)
                server_id = self.cloud.create_server(self.server_body(name, user_data))
                with self.registry.locked(name) as state:
                    state["server"] = {"id": server_id, "created": iso(utcnow()), "sha": sha}
                    record(state, "server_created", server=server_id, sha=sha)
                self.log(f"server {server_id} created for {sha}")
                self.wait_active(server_id)
                ports = self.cloud.server_ports(server_id)
                if len(ports) != 1:
                    raise StageError(f"expected_one_port:{len(ports)}")
                self.cloud.associate(fip["id"], ports[0]["id"])
                self.log(f"floating ip {stage['floating_ip']} attached")
                shell = self.adopt_host(name, server_id)
                shell.run("cloud-init status --wait >/dev/null; cloud-init status --format json", timeout=1800, check=False)
                env["STAGE_SSH_CONFIG"] = shell.ssh_config
                self.run_hook(hook, "prepare", env)
                self.restore_caddy(name, shell)
                self.run_hook(hook, "deploy", env)
                # Only now may CI deploy: an earlier automatic run could put a newer SHA on the empty host
                # and the first deploy would then roll it back to the older one.
                self.set_ci(name, True)
            newest = self.github.latest_success_sha(github["repo"], github["deploy_after"])
            with self.registry.locked(name) as state:
                state["phase"], state["op"] = "ready", None
                state["server"]["ready"] = iso(utcnow())
                if newest != sha:
                    state["server"]["behind"] = newest
                record(state, "ready", server=server_id, sha=sha, behind=newest if newest != sha else None)
            self.log(f"stage {name} ready" + (f"; {newest} was published meanwhile and is not deployed" if newest != sha else ""))
            return {"stage": name, "phase": "ready", "server": server_id, "sha": sha, "url": self.url(name)}
        except Exception as error:
            with self.registry.locked(name) as state:
                state["phase"], state["op"] = "failed", None
                record(state, "create_failed", error=str(error)[:300])
            self.log(f"creation failed: {error}")
            raise

    def server_body(self, name, user_data):
        stage = self.config.stage(name)
        body = {
            "name": stage["server_name"], "flavorRef": stage["flavor"],
            "networks": [{"uuid": stage["network"]}],
            "security_groups": [{"name": group} for group in stage.get("security_groups", [])],
            "user_data": base64.b64encode(user_data.encode()).decode(),
            "metadata": {**stage.get("metadata", {}), "vrata-stage": name, "managed-by": "vrata-stage"},
        }
        if stage.get("availability_zone"):
            body["availability_zone"] = stage["availability_zone"]
        if stage.get("boot_volume"):
            body["block_device_mapping_v2"] = [{
                "boot_index": 0, "uuid": stage["image"], "source_type": "image", "destination_type": "volume",
                "volume_size": stage["boot_volume"]["size_gb"], "volume_type": stage["boot_volume"]["type"],
                "delete_on_termination": True}]
        else:
            body["imageRef"] = stage["image"]
        return body

    def wait_active(self, server_id, timeout=900):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            server = self.cloud.server(server_id)
            if server and server["status"] == "ACTIVE":
                return
            if server and server["status"] == "ERROR":
                raise StageError("server_error:" + json.dumps(server.get("fault", {}))[:200])
            time.sleep(10)
        raise StageError("server_active_timeout:" + server_id)

    def adopt_host(self, name, server_id, timeout=900):
        """Trust the first host key only as printed by cloud-init on the provider console, then
        install the pinned keys so CI known_hosts stays valid across recreations."""
        deadline = time.monotonic() + timeout
        console_keys = []
        while time.monotonic() < deadline and not console_keys:
            console_keys = console_host_keys(self.cloud.console(server_id))
            if not console_keys:
                time.sleep(15)
        if not console_keys:
            raise StageError("console_host_keys_missing:" + server_id)
        shell = Shell(self.write_ssh_config(name, console_keys))
        while True:
            try:
                shell.run("true", timeout=30)
                break
            except (StageError, subprocess.TimeoutExpired):
                if time.monotonic() >= deadline:
                    raise StageError("ssh_unreachable:" + name) from None
                time.sleep(10)
        shell.run("set -e; sudo tar -C /etc/ssh -xzf -; sudo systemctl restart ssh", input_bytes=self.host_key_archive(name), timeout=120)
        pinned = self.pinned_shell(name)
        for _ in range(12):
            try:
                pinned.run("true", timeout=30)
                self.log("pinned host keys installed")
                return pinned
            except (StageError, subprocess.TimeoutExpired):
                time.sleep(5)
        raise StageError("pinned_host_key_not_served:" + name)

    def host_key_archive(self, name):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            for private, public in self.pinned_keys(name).values():
                for path, mode in ((private, 0o600), (public, 0o644)):
                    data = path.read_bytes()
                    info = tarfile.TarInfo(path.name)
                    info.size, info.mode, info.uid, info.gid, info.uname, info.gname = len(data), mode, 0, 0, "root", "root"
                    info.mtime = int(time.time())
                    archive.addfile(info, io.BytesIO(data))
        return buffer.getvalue()

    # -------- project hooks

    def checkout_hook(self, name, workdir):
        """Hooks come from the remote main of the project, never from a local working tree."""
        hook = self.config.stage(name)["hook"]
        clone = Path(hook["clone"]).expanduser()
        ref = hook.get("ref", "origin/main")
        if hook.get("fetch", True):
            subprocess.run(["git", "-C", str(clone), "fetch", "-q", "origin", "main"], check=True, timeout=120)
        archive = subprocess.run(["git", "-C", str(clone), "archive", ref, *hook.get("paths", [str(Path(hook["path"]).parent)])],
                                 check=True, capture_output=True, timeout=120).stdout
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(workdir, filter="data")
        path = workdir / hook["path"]
        if not path.is_file():
            raise StageError("hook_missing:" + hook["path"])
        return path, workdir

    def hook_env(self, name, sha):
        stage = self.config.stage(name)
        env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "LANG", "USER", "GH_TOKEN", "GH_CONFIG_DIR")}
        env.update({
            "STAGE_NAME": name, "STAGE_SERVER_NAME": stage["server_name"], "STAGE_PUBLIC_IP": stage["floating_ip"],
            "STAGE_DEPLOY_SHA": sha, "STAGE_REPO": stage["github"]["repo"], "STAGE_SSH_ALIAS": "stage",
            "VRATA_STAGE_BIN": str(SELF)})
        for key, relative in stage.get("hook_env", {}).items():
            path = self.config.secret_path(relative)
            if not path.exists():
                raise StageError(f"hook_input_missing:{key}")
            env[key] = str(path)
        return env

    def run_hook(self, hook, phase, env, capture=False):
        """Run a hook phase from the root of the project archive, so it can use repository paths."""
        path, root = hook
        self.log(f"hook {phase}")
        result = subprocess.run(["bash", str(path), phase], cwd=root, env=env, text=True,
                                stdout=subprocess.PIPE if capture else None, timeout=4 * 3600)
        if result.returncode:
            raise StageError(f"hook_failed:{phase}:{result.returncode}")
        return result.stdout if capture else None


def console_host_keys(output):
    match = re.search(r"-----BEGIN SSH HOST KEY KEYS-----(.*?)-----END SSH HOST KEY KEYS-----", output, re.S)
    if not match:
        return []
    return [line.strip() for line in match.group(1).splitlines()
            if re.match(r"(ssh-ed25519|ecdsa-sha2-nistp\d+|ssh-rsa) [A-Za-z0-9+/=]+", line.strip())]


def spawn_detached(args, log_path):
    """Run a long operation outside the caller's process group; agent shells time out."""
    log_path = Path(log_path)
    fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        child = subprocess.Popen([sys.executable, "-B", str(SELF), *args], stdin=subprocess.DEVNULL, stdout=fd,
                                 stderr=fd, start_new_session=True, close_fds=True,
                                 env={**os.environ, "VRATA_STAGE_DETACHED": "1"})
    finally:
        os.close(fd)
    for _ in range(50):
        identity = process_identity(child.pid)
        if identity:
            return identity
        time.sleep(0.02)
    raise StageError("spawn_failed")


# ---------------------------------------------------------------- GitHub workflow helper for hooks

def dispatch(repo, workflow, fields, ref="main", github=None, poll=20, timeout=4 * 3600):
    """Run a workflow and wait for that very run: its run-name carries a unique request id."""
    github = github or GitHub()
    request = secrets.token_hex(6)
    inputs = dict(field.split("=", 1) for field in fields)
    inputs["request"] = request
    github.gh("workflow", "run", workflow, "--repo", repo, "--ref", ref, "--json", input_text=json.dumps(inputs))
    deadline = time.monotonic() + timeout
    run_id = None
    while time.monotonic() < deadline:
        time.sleep(poll)
        runs = json.loads(github.gh("run", "list", "--repo", repo, "--workflow", workflow, "--event",
                                    "workflow_dispatch", "--limit", "20", "--json",
                                    "databaseId,displayTitle,status,conclusion"))
        if run_id is None:
            mine = [run for run in runs if request in run["displayTitle"].split()]
            if not mine:
                continue
            run_id = mine[0]["databaseId"]
            print(f"{iso(utcnow())} dispatched {workflow} run {run_id} ({request})", file=sys.stderr, flush=True)
        run = next((run for run in runs if run["databaseId"] == run_id), None)
        if run is None:
            run = json.loads(github.gh("run", "view", str(run_id), "--repo", repo, "--json", "status,conclusion"))
        if run["status"] == "completed":
            if run["conclusion"] != "success":
                raise StageError(f"workflow_failed:{workflow}:{run_id}:{run['conclusion']}")
            return {"run": run_id, "conclusion": run["conclusion"]}
    raise StageError(f"workflow_timeout:{workflow}:{run_id or request}")


# ---------------------------------------------------------------- command line

def main(argv=None):
    parser = argparse.ArgumentParser(prog="vrata-stage", description=__doc__.splitlines()[0])
    parser.add_argument("--config", default=os.environ.get("VRATA_STAGE_CONFIG", str(DEFAULT_CONFIG)))
    parser.add_argument("--state-dir", default=os.environ.get("VRATA_STAGE_STATE_DIR", str(DEFAULT_STATE)))
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("status", help="stands, leases and running operations")
    p.add_argument("stage", nargs="?")
    p.add_argument("--cloud", action="store_true", help="also read the server from the provider")
    p = sub.add_parser("acquire", help="take a lease; creates the stand if it is absent")
    p.add_argument("stage")
    p.add_argument("--purpose", required=True, choices=sorted(PURPOSE_TTL))
    p.add_argument("--ttl", type=parse_duration)
    p.add_argument("--note", default="")
    p.add_argument("--sha", help="deploy this SHA when the stand has to be created")
    p = sub.add_parser("hold", help="lease for the owner: no session, only a deadline")
    p.add_argument("stage")
    p.add_argument("--ttl", type=parse_duration, default=PURPOSE_TTL["user"])
    p.add_argument("--note", default="")
    p = sub.add_parser("wait", help="wait until the stand is ready (returns waiting=true on timeout)")
    p.add_argument("stage")
    p.add_argument("--timeout", type=parse_duration, default=540)
    p = sub.add_parser("renew")
    p.add_argument("lease")
    p.add_argument("--ttl", type=parse_duration)
    p = sub.add_parser("release", help="return a lease; the last one removes the stand after a pause")
    p.add_argument("lease")
    p.add_argument("--now", action="store_true", help="remove at once if idle instead of after the pause")
    p = sub.add_parser("down", help="remove the stand if no lease and no CI run needs it")
    p.add_argument("stage")
    p.add_argument("--force", action="store_true", help="ignore leases and CI (emergency)")
    p = sub.add_parser("reap", help="watch the stand and remove it after the grace period (started automatically)")
    p.add_argument("stage")
    p = sub.add_parser("up", help="create the stand now (normally started by acquire)")
    p.add_argument("stage")
    p.add_argument("--sha")
    p.add_argument("--requester", help="lease that asked for the creation")
    p.add_argument("--force", action="store_true", help="replace even a ready or shared stand (emergency)")
    p = sub.add_parser("known-hosts", help="print the pinned host keys as known_hosts lines")
    p.add_argument("stage")
    p = sub.add_parser("dispatch", help="run a workflow and wait for its conclusion (used by hooks)")
    p.add_argument("--repo", required=True)
    p.add_argument("--workflow", required=True)
    p.add_argument("--ref", default="main")
    p.add_argument("-f", "--field", action="append", default=[])
    args = parser.parse_args(argv)
    try:
        if args.command == "dispatch":
            result = dispatch(args.repo, args.workflow, args.field, args.ref)
        else:
            stands = Stands(Config(args.config), Registry(args.state_dir))
            if args.command == "status":
                names = [args.stage] if args.stage else list(stands.config.stages)
                result = [stands.status(name, args.cloud) for name in names]
            elif args.command == "acquire":
                result = stands.acquire(args.stage, args.purpose, args.ttl, args.note, args.sha)
            elif args.command == "hold":
                result = stands.acquire(args.stage, "user", args.ttl, args.note, owner=None)
            elif args.command == "wait":
                result = stands.wait(args.stage, args.timeout)
            elif args.command == "renew":
                result = stands.renew(args.lease, args.ttl)
            elif args.command == "release":
                result = stands.release(args.lease, args.now)
            elif args.command == "down":
                result = stands.down(args.stage, args.force)
            elif args.command == "reap":
                result = stands.reap(args.stage)
            elif args.command == "up":
                result = stands.up(args.stage, args.sha, args.requester, args.force)
            elif args.command == "known-hosts":
                stage = stands.config.stage(args.stage)
                lines = [path.read_text().split()[:2] for _, path in stands.pinned_keys(args.stage).values()]
                print("".join(f"{stage['floating_ip']} {kind} {key}\n" for kind, key in lines), end="")
                return 0
    except StageError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
