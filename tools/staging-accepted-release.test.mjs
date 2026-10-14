import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("./staging-accepted-release.py", import.meta.url));

function runAssertions(code) {
  return execFileSync("python3", ["-B", "-c", `
import importlib.util, json, subprocess, sys, tempfile
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("accepted", ${JSON.stringify(helper)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
a, b, assets = "a"*40, "b"*40, "c"*40
identity, ip = "d"*64, "203.0.113.10"
def release(image=a, run="123", attempt=1):
    return {"schemaVersion":1,"imageSha":image,"assetSha":assets,"snapshotId":image+"-"+assets,
            "foundationDigests":{name:"registry.example/"+name+"@sha256:"+"e"*64 for name in m.FOUNDATIONS},
            "runId":run,"runAttempt":attempt}
def proof(path, image=a, run="123", attempt=1):
    path.write_text(json.dumps({"schemaVersion":1,"imageSha":image,"runId":run,"runAttempt":attempt,"gate":"passed"}))
def make_snapshot(state, record):
    from staging_scene_files import inventory
    target = state.directory / "snapshots" / record["snapshotId"]
    scene = target / "public/assets/scenes/test-scene"
    scene.mkdir(parents=True)
    (scene / "scene.json").write_text(json.dumps({"sceneId":"test-scene","glbPath":"scene.glb"}))
    (scene / "scene.glb").write_bytes(b"accepted scene bytes")
    (target / "snapshot.json").write_text(json.dumps({"schemaVersion":1,"imageSha":record["imageSha"],"assetSha":record["assetSha"],"scenes":["test-scene"],"files":inventory(target / "public")}))
def rejects(fn, code):
    try: fn()
    except (ValueError, RuntimeError, OSError) as error:
        assert code in str(error), str(error)
    else: raise AssertionError("expected " + code)
with tempfile.TemporaryDirectory() as directory:
    base = Path(directory)
    root = base / "checkout"
    (root / "infra/docker").mkdir(parents=True)
    state = m.AcceptedState(root, base / "state")
    evidence = base / "proof.json"
    ${code.split("\n").join("\n    ")}
print("accepted staging assertions passed")
`], { encoding: "utf8" });
}

test("only a designated fresh host can bootstrap; legacy and IO failures are not absence", () => {
  assert.match(runAssertions(`
rejects(lambda: state.preflight(), "missing")
rejects(lambda: state.preflight(True, ip, identity), "designation_mismatch")
state.designate(ip, identity)
assert state.preflight(True, ip, identity) == {"mode":"bootstrap","release":None}
state.designate(ip, identity)
rejects(lambda: state.preflight(True, "203.0.113.11", identity), "designation_mismatch")
with patch.object(Path, "lstat", side_effect=PermissionError("denied")):
    rejects(lambda: state.preflight(True, ip, identity), "denied")
state.legacy_path.write_text(a)
rejects(lambda: state.preflight(True, ip, identity), "legacy_without_manifest")
rejects(lambda: state.designate(ip, identity), "already_designated_or_accepted")
state.legacy_path.unlink()
state.manifest_path.write_text("{broken")
rejects(lambda: state.preflight(True, ip, identity), "staging_json_invalid")
`), /assertions passed/);
});

test("post-gate publication binds the immutable asset and exact run attempt", () => {
  runAssertions(`
state.designate(ip, identity)
proof(evidence)
rejects(lambda: state.publish(release(), evidence, True, ip, identity), "asset_binding_required")
state.bind(a, assets)
rejects(lambda: state.publish(release(), evidence, True, ip, identity), "snapshot_missing")
make_snapshot(state, release())
proof(evidence, b)
rejects(lambda: state.publish(release(), evidence, True, ip, identity), "image_mismatch")
proof(evidence, a, "124")
rejects(lambda: state.publish(release(), evidence, True, ip, identity), "gate_run_mismatch")
proof(evidence, a, "123", 2)
rejects(lambda: state.publish(release(), evidence, True, ip, identity), "gate_run_mismatch")
proof(evidence)
state.publish(release(), evidence, True, ip, identity)
assert state.preflight()["release"] == release()
assert state.committed(a, "123", 1)["published"] is True
assert state.committed(a, "123", 2)["published"] is False
assert state.committed(a, "124", 1)["published"] is False
rejects(lambda: state.preflight(True, ip, identity), "bootstrap_on_accepted_host")
assert state.manifest_path.stat().st_mode & 0o777 == 0o600
assert state.legacy_path.stat().st_mode & 0o777 == 0o600
`);
});

test("a failed candidate retains its asset binding without becoming accepted", () => {
  runAssertions(`
state.designate(ip, identity)
state.bind(b, assets)
assert state.binding(b) == {"imageSha":b,"assetSha":assets}
assert state.preflight(True, ip, identity)["release"] is None
state.bind(b, assets)
rejects(lambda: state.bind(b, "f"*40), "asset_binding_mismatch")
assert state.binding(a) is None
rejects(lambda: state.binding("../escape"), "invalid_sha")
`);
});

test("legacy failure after publication requires repair, not rollback to the old manifest", () => {
  runAssertions(`
state.designate(ip, identity)
state.bind(a, assets)
make_snapshot(state, release())
proof(evidence)
original = m.atomic_write
def fail_legacy(path, content):
    if Path(path) == state.legacy_path: raise OSError("simulated storage failure")
    return original(path, content)
with patch.object(m, "atomic_write", side_effect=fail_legacy):
    rejects(lambda: state.publish(release(), evidence, True, ip, identity), "legacy_repair_required")
assert state.committed(a, "123", 1)["published"] is True
assert state.manifest() == release()
rejects(lambda: state.preflight(), "legacy_repair_required")
state.repair_legacy()
assert state.preflight()["release"] == release()
state.legacy_path.write_text(b)
rejects(lambda: state.preflight(), "legacy_repair_required")
state.repair_legacy()
assert state.legacy() == a
`);
});

test("atomic rename failure preserves the previously accepted release", () => {
  runAssertions(`
state.designate(ip, identity)
state.bind(a, assets)
make_snapshot(state, release())
proof(evidence)
state.publish(release(), evidence, True, ip, identity)
state.bind(b, assets)
next_release = release(b, "124")
make_snapshot(state, next_release)
proof(evidence, b, "124")
with patch.object(m.os, "replace", side_effect=OSError("simulated rename failure")):
    rejects(lambda: state.publish(next_release, evidence), "rename failure")
assert state.preflight()["release"] == release()
assert state.committed(b, "124", 1)["published"] is False
assert not list(state.directory.glob(".staging-state-*"))
`);
});

test("directory fsync failure after rename is an unconfirmed publication, not an uncommitted release", () => {
  runAssertions(`
state.designate(ip, identity)
state.bind(a, assets)
make_snapshot(state, release())
proof(evidence)
original_open = m.os.open
def fail_directory(path, flags, *args, **kwargs):
    if flags & m.os.O_DIRECTORY and Path(path) == state.directory:
        raise OSError("simulated directory synchronization failure")
    return original_open(path, flags, *args, **kwargs)
with patch.object(m.os, "open", side_effect=fail_directory):
    rejects(lambda: state.publish(release(), evidence, True, ip, identity), "accepted_release_publication_unconfirmed")
assert state.committed(a, "123", 1)["published"] is True
rejects(state.preflight, "accepted_release_legacy_repair_required")
state.repair_legacy()
assert state.preflight()["release"] == release()
`);
});

test("malformed legacy has a repair path and CLI preflight has no filesystem side effects", () => {
  runAssertions(`
fresh = m.AcceptedState(root, base / "fresh-state")
result = subprocess.run([sys.executable,"-B",m.__file__,"read","--root",str(root),"--state-dir",str(fresh.directory)], capture_output=True, text=True)
assert result.returncode == 1
assert result.stderr.strip() == "accepted_release_missing"
assert not fresh.directory.exists(), "read-only preflight must not create state or locks"
state.designate(ip, identity)
state.bind(a, assets)
make_snapshot(state, release())
proof(evidence)
state.publish(release(), evidence, True, ip, identity)
for malformed in (b"garbage", b"\\xff\\xfe"):
    state.legacy_path.write_bytes(malformed)
    rejects(state.preflight, "accepted_release_legacy_repair_required")
    result = subprocess.run([sys.executable,"-B",m.__file__,"read","--root",str(root),"--state-dir",str(state.directory)], capture_output=True, text=True)
    assert result.returncode == 1
    assert result.stderr.strip() == "accepted_release_legacy_repair_required"
    state.repair_legacy()
    assert state.preflight()["mode"] == "ordinary"
rejects(lambda: state.preflight(True, ip, "f"*64), "bootstrap_on_accepted_host")
`);
});

test("untrusted evidence, symlinks and malformed accepted records fail closed", () => {
  runAssertions(`
state.designate(ip, identity)
proof(root / "proof.json")
rejects(lambda: m.load_gate_proof(root / "proof.json", root, a), "inside_checkout")
proof(evidence)
payload = json.loads(evidence.read_text())
payload["gate"] = "failed"
evidence.write_text(json.dumps(payload))
rejects(lambda: m.load_gate_proof(evidence, root, a), "not_passed")
evidence.write_text('{"schemaVersion":1,"schemaVersion":1}')
rejects(lambda: m.load_gate_proof(evidence, root, a), "duplicate_key")
state.manifest_path.symlink_to(evidence)
rejects(state.manifest, "not_regular")
state.manifest_path.unlink()
for changed in ({"snapshotId":"../escape"},{"runAttempt":True},{"runId":""},{"foundationDigests":{}},{"schemaVersion":True}):
    bad = release() | changed
    rejects(lambda: m.validate_release(bad), "invalid")
rejects(lambda: m.AcceptedState(root, root / "state"), "inside_checkout")
`);
});
