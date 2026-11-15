#!/usr/bin/env python3
"""Exact-main fresh self-host acceptance. No stage/CI/SSH and no daemon restart.

Run `preflight` for bounded configuration checks, `run` once for source build and
browser lifecycle. Both acquire the shared browser lock without waiting. The
browser invokes continuity/restart only while its owning runner is alive.
Private output stays under the explicitly selected delivery directory.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import subprocess
import sys
import time
import traceback
import urllib.request

os.umask(0o077)
SHA = "4d5ca28883cffbf08a82112f33a25fca18431164"
ORIGIN = "https://github.com/vrata-labs/platform.git"
ROOT = Path(__file__).resolve().parent.parent
DOCKER = ["/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe", "--host", "npipe:////./pipe/dockerDesktopLinuxEngine"]
NODE = "/usr/bin/node"
PORTS = {"http": 47170, "state": 27170, "livekit": 27880, "rtc": 27881, "storage": 29170}
HARNESS_FILES = ["tools/t17-selfhost-acceptance.py", "tools/t17-selfhost-acceptance.test.py", "tests/selfhost/playwright.config.ts", "tests/selfhost/runtime-lifecycle.spec.ts"]
SHARED_HELPERS = ["tests/e2e/" + name + ".ts" for name in ["plugin-author-scenarios", "plugin-author-ui", "room-state-observation", "meeting-tools-acceptance", "functional-diagnostics", "test-cleanup"]]
seq = 0


def configure(argv=None):
    global args, BASE, Q, SOURCE, LOGS, ENVFILE, OVERLAY, STATE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["preflight", "run", "continuity", "restart", "cleanup"])
    parser.add_argument("--delivery", default="/tmp/opencode/vrata-t17-delivery")
    parser.add_argument("--wait-lock", action="store_true", help="Only for the main session's asynchronous run; default never waits")
    args = parser.parse_args(argv)
    if args.wait_lock and args.operation != "run":
        parser.error("--wait-lock is available only for an asynchronous run")
    BASE = Path(args.delivery).resolve()
    if not str(BASE).startswith("/tmp/opencode/"):
        raise SystemExit("t17_private_delivery_required")
    Q = BASE / "selfhost"
    SOURCE = BASE / "selfhost-source"
    Q.mkdir(parents=True, exist_ok=True, mode=0o700)
    LOGS = Q / "logs"
    LOGS.mkdir(exist_ok=True, mode=0o700)
    ENVFILE = Q / "selfhost.private.env"
    OVERLAY = Q / "isolation.yml"
    STATE = Q / "runner.private.json"


def write(name, value):
    path = Q / name
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    path.chmod(0o600)


def capture(argv, *, cwd=None, timeout=120, env=None, input=None):
    global seq
    seq += 1
    child = subprocess.Popen(argv, cwd=SOURCE if cwd is None else cwd, env=env, stdin=subprocess.DEVNULL if input is None else subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    timed_out = False
    try:
        stdout, stderr = child.communicate(input=input, timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(child.pid, signal.SIGKILL)
        stdout, stderr = child.communicate()
    (LOGS / f"{time.time_ns()}-{seq}.stdout.private.log").write_bytes(stdout)
    (LOGS / f"{time.time_ns()}-{seq}.stderr.private.log").write_bytes(stderr)
    if timed_out:
        raise RuntimeError(f"t17_command_timeout_{seq}")
    if child.returncode:
        # No argv/env/exception/raw payload is printed to a public terminal.
        raise RuntimeError(f"t17_command_failed_{seq}_exit_{child.returncode}")
    return stdout


def git(*parts):
    return capture(["git", *parts]).decode().strip()


def win(path):
    return subprocess.check_output(["wslpath", "-w", str(path)], stdin=subprocess.DEVNULL, text=True).strip()


def docker_environment():
    # Shell values outrank --env-file. Do not inherit Compose controls, credentials,
    # image/port knobs, NODE_OPTIONS or Docker endpoint overrides from the caller.
    host_keys = {"HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "SYSTEMROOT", "WINDIR",
                 "WSL_INTEROP", "WSL_DISTRO_NAME", "TEMP", "TMP"}
    env = {key: value for key, value in os.environ.items() if key in host_keys}
    env["PATH"] = "/usr/bin:/bin"
    private = readenv()
    # Also pin optional interpolation inputs absent from the generated env file.
    # Forward them explicitly through WSLENV: docker.exe must not recover shell
    # overrides from its Windows parent environment either.
    for name in ["compose.selfhost.yml", "compose.demo-local.yml"]:
        text = (SOURCE / "infra/docker" / name).read_text()
        for key in re.findall(r"\$\{([A-Z][A-Z0-9_]*)", text):
            env[key] = private.get(key, "")
    env.update(private)
    env.update(COMPOSE_FILE="", COMPOSE_PROFILES="", COMPOSE_ENV_FILES="", COMPOSE_DISABLE_ENV_FILE="1",
               DOCKER_CONTEXT="", DOCKER_HOST="", DOCKER_TLS_VERIFY="", DOCKER_CERT_PATH="")
    env["WSLENV"] = ":".join(sorted(set(env) - {"PATH", "HOME", "WSL_INTEROP", "WSL_DISTRO_NAME"}))
    return env


def docker(*parts, **kwargs):
    return capture(DOCKER + list(parts), env=docker_environment(), **kwargs)


def checked_project(project=None):
    saved = json.loads(STATE.read_text())["project"] if project is None else project
    assert re.fullmatch(r"vrata-demo-" + SHA[:8] + r"-[0-9a-f]{12}", saved), "t17_project_invalid"
    assert saved == readenv()["COMPOSE_PROJECT_NAME"], "t17_saved_project_mismatch"
    return saved


def compose(*parts, project=None, stock=False, **kwargs):
    project = checked_project(project)
    command = ["compose", "-p", project, "--env-file", win(ENVFILE), "-f", win(SOURCE / "infra/docker/compose.selfhost.yml"),
               "-f", win(SOURCE / "infra/docker/compose.demo-local.yml")]
    if not stock:
        command += ["-f", win(OVERLAY)]
    # Including manual cleanup/restart: no mutation may use a model that disagrees
    # with the persisted and validated namespace. All config calls use the same -p.
    if not parts or parts[0] != "config":
        model = json.loads(docker(*command, "config", "--format", "json"))
        assert model.get("name") == project, "t17_rendered_project_mismatch"
    return docker(*command, *parts, **kwargs)


def readenv():
    return dict(line.split("=", 1) for line in ENVFILE.read_text().splitlines() if line and not line.startswith("#"))


def assert_clone():
    assert (SOURCE / ".git").is_dir(), "t17_requires_fresh_origin_clone_not_worktree"
    assert not (SOURCE / ".git/objects/info/alternates").exists(), "t17_clone_has_alternates"
    assert git("remote", "get-url", "origin") == ORIGIN
    assert git("rev-parse", "HEAD") == SHA
    assert git("status", "--porcelain") == "", "t17_source_tree_dirty"


def setup():
    if not SOURCE.exists():
        capture(["git", "clone", "--no-checkout", ORIGIN, str(SOURCE)], cwd=BASE)
        git("checkout", "--detach", SHA)
    assert_clone()
    if STATE.exists():
        return json.loads(STATE.read_text())
    run_id = "t17-" + secrets.token_hex(6)
    capture([NODE, "tools/public-demo-local-env.mjs", "--source-sha", SHA, "--output", str(ENVFILE)])
    original = readenv()
    # Validate the STOCK rendered profile before changing only isolation coordinates.
    stock = compose("config", "--format", "json", project=original["COMPOSE_PROJECT_NAME"], stock=True)
    assert json.loads(stock).get("name") == original["COMPOSE_PROJECT_NAME"], "t17_stock_project_mismatch"
    stock_file = Q / "stock-compose.private.json"
    stock_file.write_bytes(stock)
    capture([NODE, "--input-type=module", "-e",
             "import fs from 'node:fs';import {parsePublicDemoLocalEnv,assertPublicDemoLocalComposeModel} from './tools/public-demo-local-env.mjs';"
             "assertPublicDemoLocalComposeModel(JSON.parse(fs.readFileSync(process.argv[1])),parsePublicDemoLocalEnv(fs.readFileSync(process.argv[2],'utf8')));",
             str(stock_file), str(ENVFILE)])
    env = dict(original)
    env.update({"API_IMAGE_REPO": f"vrata-{run_id}-api", "ROOM_STATE_IMAGE_REPO": f"vrata-{run_id}-room-state",
                "VRATA_APP_BASE_URL": f"http://127.0.0.1:{PORTS['http']}", "API_CORS_ORIGIN": f"http://127.0.0.1:{PORTS['http']}",
                "ROOM_STATE_PUBLIC_URL": f"ws://127.0.0.1:{PORTS['state']}", "LIVEKIT_URL": f"ws://127.0.0.1:{PORTS['livekit']}",
                "VRATA_HTTP_PORT": str(PORTS['http']), "VRATA_ROOM_STATE_PORT": str(PORTS['state']),
                "VRATA_LIVEKIT_PORT": str(PORTS['livekit']), "VRATA_LIVEKIT_TCP_PORT": str(PORTS['rtc']),
                "VRATA_LIVEKIT_UDP_PORT": str(PORTS['rtc']), "MINIO_API_PORT": str(PORTS['storage']),
                "ROOM_PLUGIN_ANONYMOUS_ENDPOINT": "http://minio:9000"})
    ENVFILE.write_text("".join(f"{k}={v}\n" for k, v in env.items()))
    labels = f"      vrata.task: T17\n      vrata.run: {run_id}\n"
    overlay = "services:\n"
    for service in ["postgres", "livekit", "room-state", "minio", "minio-bootstrap", "api", "caddy"]:
        overlay += f"  {service}:\n    labels:\n" + labels
        if service == "livekit":
            config = json.loads(stock)["services"]["livekit"]["environment"]["LIVEKIT_CONFIG"]
            config = config.replace("tcp_port: 7881", f"tcp_port: {PORTS['rtc']}").replace("udp_port: 7881", f"udp_port: {PORTS['rtc']}")
            overlay += "    environment:\n      LIVEKIT_CONFIG: |\n" + "".join("        " + line + "\n" for line in config.splitlines())
            overlay += "    ports: !override\n"
            for target, published, protocol in [(7880, PORTS['livekit'], "tcp"), (PORTS['rtc'], PORTS['rtc'], "tcp"), (PORTS['rtc'], PORTS['rtc'], "udp")]:
                overlay += f"      - target: {target}\n        published: '{published}'\n        host_ip: 127.0.0.1\n        protocol: {protocol}\n"
    overlay += "volumes:\n"
    for volume in ["postgres-data", "storage-data", "caddy-data", "caddy-config"]:
        overlay += f"  {volume}:\n    labels:\n" + labels
    overlay += "networks:\n  default:\n    labels:\n" + labels
    OVERLAY.write_text(overlay)
    state = {"runtimeSha": SHA, "runId": run_id, "project": env["COMPOSE_PROJECT_NAME"], "phase": "prepared", "ports": PORTS,
             "harness": str(Path(__file__).resolve()), "sourceTree": git("rev-parse", "HEAD^{tree}"), "origin": ORIGIN}
    write("runner.private.json", state)
    return state


def model_preflight(state):
    assert checked_project() == state["project"], "t17_state_project_mismatch"
    model = json.loads(compose("config", "--format", "json"))
    assert model.get("name") == state["project"], "t17_rendered_project_mismatch"
    stock = json.loads((Q / "stock-compose.private.json").read_text())
    assert stock.get("name") == state["project"], "t17_stock_project_mismatch"
    services = model["services"]
    assert set(services) == set(stock["services"])
    changed_env = {"api": {"API_CORS_ORIGIN", "API_PUBLIC_URL", "RUNTIME_BASE_URL", "ROOM_STATE_PUBLIC_URL", "LIVEKIT_URL", "ROOM_PLUGIN_ANONYMOUS_ENDPOINT"},
                   "livekit": {"LIVEKIT_CONFIG"}}
    for name, service in services.items():
        assert service["labels"]["vrata.task"] == "T17" and service["labels"]["vrata.run"] == state["runId"]
        for key, value in stock["services"][name].get("environment", {}).items():
            if key not in changed_env.get(name, set()):
                assert service.get("environment", {}).get(key) == value, f"unintended_env_change_{name}_{key}"
        for port in service.get("ports", []):
            assert port["host_ip"] == "127.0.0.1"
        if name not in {"api", "room-state"}:
            assert service["image"] == stock["services"][name]["image"]
    actual = {(name, int(p['published']), int(p['target']), p['protocol']) for name, s in services.items() for p in s.get('ports', [])}
    assert actual == {("caddy", PORTS['http'], 80, "tcp"), ("room-state", PORTS['state'], 2567, "tcp"),
                      ("minio", PORTS['storage'], 9000, "tcp"), ("livekit", PORTS['livekit'], 7880, "tcp"),
                      ("livekit", PORTS['rtc'], PORTS['rtc'], "tcp"), ("livekit", PORTS['rtc'], PORTS['rtc'], "udp")}
    # Bind-mount resolution must point only into the pristine source checkout.
    for service in services.values():
        for mount in service.get("volumes", []):
            if mount["type"] == "bind":
                assert win(SOURCE).lower() in mount["source"].lower(), "unexpected_bind_source"
    for port in PORTS.values():
        for kind in ([socket.SOCK_STREAM, socket.SOCK_DGRAM] if port == PORTS["rtc"] else [socket.SOCK_STREAM]):
            with socket.socket(socket.AF_INET, kind) as probe:
                probe.bind(("127.0.0.1", port))
    for kind, command in [("container", ["ps", "-aq"]), ("volume", ["volume", "ls", "-q"]), ("network", ["network", "ls", "-q"])]:
        assert not docker(*command, "--filter", f"label=com.docker.compose.project={state['project']}").strip(), "project_not_fresh_" + kind
    proof = {"runtimeSha": SHA, "origin": ORIGIN, "cleanClone": True, "stockModelValidated": True,
              "onlyIsolationCoordinatesChanged": True, "projectFresh": True, "ports": PORTS, "runId": state["runId"]}
    write("compose.private.json", model)
    write("preflight.json", proof)
    return proof


def inventory(state):
    assert checked_project() == state["project"], "t17_state_project_mismatch"
    # Include orphans too: Compose down --remove-orphans would remove them.
    ids = docker("ps", "-aq", "--no-trunc", "--filter", f"label=com.docker.compose.project={state['project']}").decode().split()
    if not ids:
        return []
    rows = json.loads(docker("inspect", *ids))
    assert {row["Id"] for row in rows} == set(ids), "t17_container_inventory_mismatch"
    assert all(re.fullmatch(r"[0-9a-f]{64}", value) for value in ids), "t17_requires_full_container_ids"
    for row in rows:
        labels = row["Config"]["Labels"]
        assert labels.get("vrata.task") == "T17" and labels.get("vrata.run") == state["runId"]
        assert labels.get("com.docker.compose.project") == state["project"]
    return rows


def continuity(state):
    rows = inventory(state)
    assert rows, "selfhost_not_running"
    containers = {r["Config"]["Labels"]["com.docker.compose.service"]: {"id": r["Id"], "imageId": r["Image"], "startedAt": r["State"]["StartedAt"]}
                  for r in rows if r["Config"]["Labels"]["com.docker.compose.service"] in {"api", "room-state"}}
    assert set(containers) == {"api", "room-state"}
    for service in containers:
        image = json.loads(docker("image", "inspect", containers[service]["imageId"]))[0]
        labels = image["Config"]["Labels"]
        assert labels.get("org.opencontainers.image.revision") == SHA
        assert labels.get("vrata.run") == state["runId"]
    return {"runtimeSha": SHA, "containers": containers}


def health():
    url = f"http://127.0.0.1:{PORTS['http']}/health"
    with urllib.request.urlopen(url, timeout=15) as response:
        return json.load(response)


def verify_fresh_identity_floor(state):
    rows = inventory(state)
    postgres = [row for row in rows if row["Config"]["Labels"].get("com.docker.compose.service") == "postgres"]
    assert len(postgres) == 1, "t17_owned_postgres_required"
    # The fresh floor-1 health contract deliberately omits identityProtocolVersion.
    # Absence alone is not evidence of floor 1: query the actual singleton on our DB.
    policy = docker("exec", postgres[0]["Id"], "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "vrata", "-d", "vrata",
                    "-At", "-c", "select singleton, minimum_protocol from room_identity_protocol_policy;").decode().strip()
    assert policy == "t|1", "not_fresh_identity_floor"
    assert "identityProtocolVersion" not in health()["features"], "unexpected_fresh_identity_health"
    write("fresh-identity-policy.json", {"runtimeSha": SHA, "runId": state["runId"], "project": state["project"],
                                         "singleton": True, "minimumProtocol": 1, "healthProtocolFieldAbsent": True})


def owner_child(state):
    assert state["phase"] == "browser-running" and os.environ.get("T17_RUN_ID") == state["runId"]
    os.kill(state["ownerPid"], 0)


def restart(state):
    owner_child(state)
    before = continuity(state)
    compose("restart", "api", timeout=120)
    after = continuity(state)
    assert before["containers"]["room-state"] == after["containers"]["room-state"]
    assert before["containers"]["api"]["id"] == after["containers"]["api"]["id"]
    assert before["containers"]["api"]["imageId"] == after["containers"]["api"]["imageId"]
    assert before["containers"]["api"]["startedAt"] != after["containers"]["api"]["startedAt"]
    # Docker's own finite health wait, not an external CI poll.
    compose("up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "120", "api", timeout=150)
    assert health()["features"]["identityProtocolVersion"] == 2
    proof = {**after, "apiRestarted": True, "before": before}
    write("restart.json", proof)
    return proof


def cleanup(state):
    model = json.loads(compose("config", "--format", "json"))
    assert model.get("name") == state["project"] == checked_project(), "t17_rendered_project_mismatch"
    assert model == json.loads((Q / "compose.private.json").read_text()), "t17_cleanup_model_changed_since_preflight"
    inventory(state)  # Every container must match the ownership labels before down.
    for kind in ["volume", "network"]:
        full_ids = ["--no-trunc"] if kind == "network" else []
        ids = docker(kind, "ls", "-q", *full_ids, "--filter", f"label=com.docker.compose.project={state['project']}").decode().split()
        if ids:
            rows = json.loads(docker(kind, "inspect", *ids))
            assert {row["Id" if kind == "network" else "Name"] for row in rows} == set(ids), "t17_resource_inventory_mismatch"
            for row in rows:
                labels = row.get("Labels", {})
                assert labels.get("com.docker.compose.project") == state["project"]
                assert labels.get("vrata.task") == "T17" and labels.get("vrata.run") == state["runId"]
    compose("down", "-v", "--remove-orphans", timeout=180)
    remaining = {}
    for kind, command in [("containers", ["ps", "-aq"]), ("volumes", ["volume", "ls", "-q"]), ("networks", ["network", "ls", "-q"])]:
        remaining[kind] = docker(*command, "--filter", f"label=com.docker.compose.project={state['project']}").decode().split()
    assert not any(remaining.values()), "t17_cleanup_incomplete"
    removed_images = []
    env = readenv()
    for repo_key in ["API_IMAGE_REPO", "ROOM_STATE_IMAGE_REPO"]:
        ref = env[repo_key] + ":" + SHA
        ids = docker("image", "ls", "-q", ref).decode().split()
        if not ids:
            continue
        image = json.loads(docker("image", "inspect", ref))[0]
        labels = image["Config"].get("Labels", {})
        assert labels.get("vrata.task") == "T17" and labels.get("vrata.run") == state["runId"]
        docker("image", "rm", ref)
        removed_images.append(ref)
    proof = {"runtimeSha": SHA, "runId": state["runId"], "project": state["project"], "remaining": remaining}
    proof["removedOwnedImages"] = removed_images
    write("cleanup.json", proof)
    return proof


def install_dependencies():
    env = {**os.environ, "PATH": "/usr/bin:/bin", "CI": "1", "TMPDIR": str(Q), "npm_config_update_notifier": "false"}
    capture(["corepack", "pnpm", "install", "--frozen-lockfile"], env=env, timeout=600)
    # pnpm's workspace bin chmod is the documented clean-clone exception; no content restore.
    summary = git("diff", "--summary")
    if summary:
        assert summary == "mode change 100644 => 100755 packages/asset-pipeline/bin/vrata.mjs"
        path = SOURCE / "packages/asset-pipeline/bin/vrata.mjs"
        path.chmod(path.stat().st_mode & ~0o111)
    assert_clone()
    link = ROOT / "node_modules"
    if not link.exists():
        link.symlink_to(SOURCE / "node_modules", target_is_directory=True)
    capture(["corepack", "pnpm", "exec", "playwright", "install", "chromium"], env=env, timeout=600)


def verify_harness_types():
    # The harness lives beside, not inside, the pristine checkout. Resolve its
    # transitive type-only author-helper imports to that checkout's installed
    # dependencies/source, without building or patching the product locally.
    paths = {
        "pg": [str(SOURCE / "apps/api/node_modules/@types/pg/index.d.ts")],
        "*": [str(SOURCE / "apps/api/node_modules/*"), str(SOURCE / "node_modules/*")]
    }
    for name in ["shared-types", "templates", "room-plugin-sdk"]:
        paths["@vrata/" + name] = [str(SOURCE / f"packages/{name}/src/index.ts")]
        paths["@vrata/" + name + "/*"] = [str(SOURCE / f"packages/{name}/src/*")]
    config = {"compilerOptions": {"noEmit": True, "strict": True, "esModuleInterop": True, "module": "ESNext",
                                  "moduleResolution": "Bundler", "target": "ES2022", "skipLibCheck": True,
                                  "baseUrl": str(SOURCE), "paths": paths, "typeRoots": [str(SOURCE / "node_modules/@types")]},
              "files": [str(ROOT / rel) for rel in HARNESS_FILES if rel.endswith(".ts")]}
    write("harness-tsconfig.private.json", config)
    capture([str(SOURCE / "node_modules/.bin/tsc"), "-p", str(Q / "harness-tsconfig.private.json")],
            env={**os.environ, "PATH": "/usr/bin:/bin"}, timeout=120)


def source_build(state):
    archive = capture(["git", "archive", "--format=tar", SHA], timeout=120)
    write("source-provenance.json", {"runtimeSha": SHA, "tree": state["sourceTree"], "origin": ORIGIN,
                                     "gitArchiveSha256": hashlib.sha256(archive).hexdigest(), "clean": True})
    env = readenv()
    for service, repo in [("api", "API_IMAGE_REPO"), ("room-state", "ROOM_STATE_IMAGE_REPO")]:
        docker("build", "--progress=plain", "--label", "org.opencontainers.image.revision=" + SHA,
               "--label", "vrata.task=T17", "--label", "vrata.run=" + state["runId"],
               "-f", f"apps/{service}/Dockerfile", "-t", env[repo] + ":" + SHA, "-", input=archive, timeout=3600)
    assert_clone()


def runtime_audit(state):
    # Counts only: no DSNs/credentials/private keys/source escape into the proof.
    query = "select (select count(*) from room_plugin_packages) as packages,(select count(*) from room_plugin_bindings) as bindings;"
    counts = compose("exec", "-T", "postgres", "psql", "-U", "vrata", "-d", "vrata", "-At", "-c", query).decode().strip()
    assert counts == "0|0", "t17_plugin_rows_remain"
    script = 'mc alias set owned "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc find "owned/$ROOM_PLUGIN_BUCKET" --json'
    objects = compose("run", "--rm", "--no-deps", "--entrypoint", "/bin/sh", "minio-bootstrap", "-c", script, timeout=120).decode().strip()
    assert objects == "", "t17_private_objects_remain"
    write("storage-audit.json", {"pluginRows": 0, "bindings": 0, "privateBucketObjects": 0, "runtimeSha": SHA})


def verify_shared_helpers():
    for rel in SHARED_HELPERS:
        assert (ROOT / rel).read_bytes() == capture(["git", "show", SHA + ":" + rel]), "shared_helper_not_exact_runtime_sha"


def run(state):
    assert state["phase"] == "prepared", "t17_run_is_single_attempt_preserve_existing_result"
    model_preflight(state)
    state.update(phase="running", ownerPid=os.getpid())
    write("runner.private.json", state)
    hashes = {rel: hashlib.sha256((ROOT / rel).read_bytes()).hexdigest() for rel in HARNESS_FILES + SHARED_HELPERS}
    verify_shared_helpers()
    write("harness-provenance.json", {"files": hashes, "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                                      "sharedHelpersMatchRuntimeSha": True})
    result = {"runtimeSha": SHA, "runId": state["runId"], "status": "failed", "startedAt": time.time()}
    try:
        install_dependencies()
        verify_harness_types()
        source_build(state)
        compose("up", "-d", "--no-build", "--pull", "missing", "--wait", "--wait-timeout", "180", timeout=600)
        verify_fresh_identity_floor(state)
        for cli in ["identity/activate-v2.js", "identity/activate-media-codec.js"]:
            compose("exec", "-T", "api", "node", "apps/api/dist/" + cli, "--dry-run")
            compose("exec", "-T", "api", "node", "apps/api/dist/" + cli, "--confirm-irreversible")
        compose("exec", "-T", "api", "node", "apps/api/dist/template-catalog-cli.js", "preflight", timeout=600)
        compose("exec", "-T", "-e", "VRATA_TEMPLATE_WAVE2_SHA=" + SHA, "api", "node", "apps/api/dist/template-catalog-cli.js", "activate",
                "--expected-image-sha", SHA, "--rollback-sha", SHA, timeout=900)
        assert health()["features"]["identityProtocolVersion"] == 2
        before = continuity(state)
        write("before-browser.json", before)
        control_file = Q / "control.py"
        control_file.write_text("import runpy,sys\nsys.argv.extend(['--delivery'," + repr(str(BASE)) + "])\nrunpy.run_path(" + repr(str(Path(__file__).resolve())) + ",run_name='__main__')\n")
        state["phase"] = "browser-running"
        write("runner.private.json", state)
        env = {**os.environ, "PATH": "/usr/bin:/bin", "TMPDIR": str(Q), "T17_SELFHOST_ORIGIN": f"http://127.0.0.1:{PORTS['http']}",
               "T17_SELFHOST_OUTPUT": str(Q), "T17_SELFHOST_CONTROL": str(control_file), "T17_BROWSER_LOCK_HELD": "1",
               "T17_RUN_ID": state["runId"], "VRATA_ADMIN_TOKEN": readenv()["CONTROL_PLANE_ADMIN_TOKEN"]}
        capture(["corepack", "pnpm", "exec", "playwright", "test", "--config", str(ROOT / "tests/selfhost/playwright.config.ts")], env=env, timeout=900)
        report = json.loads((Q / "playwright.private.json").read_text())
        assert report["stats"]["expected"] == 1 and report["stats"]["unexpected"] == report["stats"]["skipped"] == report["stats"]["flaky"] == 0
        runtime_audit(state)
        facts = json.loads((Q / "lifecycle-facts.json").read_text())
        assert facts["lifecyclePassed"] and facts["cleanupPassed"]
        result["status"] = "passed"
    except Exception:
        (Q / "failure.private.log").write_text(traceback.format_exc())
    finally:
        result["diagnosticsPassed"] = True
        try:
            rows = inventory(state)
            if rows:
                # Preserve raw diagnostics privately before removing only owned resources.
                write("terminal-containers.private.json", rows)
                compose("logs", "--no-color", timeout=120)
        except Exception:
            record_failure(result, "diagnosticsPassed", "diagnostics-failure.private.log")
        try:
            cleanup(state)
            result["cleanupPassed"] = True
        except Exception:
            record_failure(result, "cleanupPassed", "cleanup-failure.private.log")
        state["phase"] = "complete"
        write("runner.private.json", state)
        result["finishedAt"] = time.time()
        result.update(sourceStillClean=False, harnessUnchanged=False)
        try:
            result["harnessSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
            result["docsHarnessHead"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
            result["sourceStillClean"] = git("status", "--porcelain") == ""
            result["harnessUnchanged"] = all(hashlib.sha256((ROOT / rel).read_bytes()).hexdigest() == digest for rel, digest in hashes.items())
            if not result["harnessUnchanged"] or not result["sourceStillClean"]:
                result["status"] = "failed"
            link = ROOT / "node_modules"
            if link.is_symlink() and link.resolve() == SOURCE / "node_modules":
                link.unlink()
        except Exception:
            record_failure(result, "terminalVerificationPassed", "terminal-verification-failure.private.log")
        write("terminal.json", result)
    return result


def record_failure(result, field, filename):
    result[field] = False
    result["status"] = "failed"
    try:
        (Q / filename).write_text(traceback.format_exc())
    except OSError:
        # A diagnostic filesystem failure must not cancel the teardown attempt.
        result[field + "LogSaved"] = False


def main():
    lock = None
    if args.operation in {"preflight", "run", "cleanup"}:
        lock = open("/tmp/opencode/vrata-t17-browser.lock", "a")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | (0 if args.wait_lock else fcntl.LOCK_NB))
        except BlockingIOError:
            print(json.dumps({"status": "blocked", "reason": "browser_lock_busy", "runtimeSha": SHA}))
            return 75
    state = setup() if args.operation in {"preflight", "run"} else json.loads(STATE.read_text())
    if args.operation == "preflight":
        result = model_preflight(state)
    elif args.operation == "run":
        result = run(state)
    elif args.operation == "continuity":
        owner_child(state)
        result = continuity(state)
    elif args.operation == "restart":
        result = restart(state)
    else:
        result = cleanup(state)
    print(json.dumps(result, ensure_ascii=False))
    return 1 if result.get("status") == "failed" else 0


if __name__ == "__main__":
    configure()
    try:
        sys.exit(main())
    except Exception:
        (Q / "runner-error.private.log").write_text(traceback.format_exc())
        print(json.dumps({"status": "blocked", "reason": "runner_error_see_private_log", "runtimeSha": SHA}))
        sys.exit(2)
