import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("catalog rollout rejects incompatible images and preserves the verified baseline", () => {
  const output = execFileSync("python3", ["-B", "-c", `
import importlib.util, json, sys, tempfile
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("catalog", ${JSON.stringify(fileURLToPath(new URL("./staging-template-catalog.py", import.meta.url)))})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
current, baseline = "a"*40, "b"*40
contract = {"schemaVersion": 1, "templateSchema": 2, "referenceTemplateVersions": ["1.0.0", "2.0.0"]}
def rejects(fn, code):
    try: fn()
    except (ValueError, RuntimeError) as e:
        assert code in str(e), str(e)
    else: raise AssertionError("expected " + code)
m.assert_target_allowed(None, None, None, baseline)
m.assert_target_allowed(None, {"state":"wave2", "referenceRoomCount":0}, None, baseline)
rejects(lambda: m.assert_target_allowed(None, {"state":"active", "referenceRoomCount":0}, None, baseline), "reference_capable")
rejects(lambda: m.assert_target_allowed(None, {"state":"wave2", "referenceRoomCount":1}, None, baseline), "reference_capable")
rejects(lambda: m.assert_target_allowed(baseline, None, None, current), "below_wave2")
m.assert_target_allowed(baseline, {"state":"active", "referenceRoomCount":3}, contract, current)
with tempfile.TemporaryDirectory() as directory:
    host = m.CatalogHost(Path(directory) / "checkout")
    host.root.mkdir()
    assert host.run([sys.executable, "-c", "import sys; print(sys.stdin.read() or 'closed')"]) == "closed"
    assert sys.stdin.read() == "remaining deployment commands", "child must not consume the SSH script stream"
    host.marker_path.parent.mkdir(parents=True)
    calls = []
    status = {"state":"wave2", "imageSha":baseline, "referenceRoomCount":0}
    def cli(args, required=True):
        calls.append(args)
        if args[0] in ("activate", "rollback"):
            status["state"] = "active" if args[0] == "activate" else "wave2"
        return dict(status)
    host.cli = cli
    host.run = lambda args: json.dumps(status)
    host.contract = lambda target: contract
    rejects(lambda: host.mutate("activate", baseline), "verified_wave2")
    rejects(lambda: host.verify_wave2(baseline, None), "successful_gate")
    proof = Path(directory) / "gate.json"
    def write_proof(image):
        proof.write_text(json.dumps({"schemaVersion":1,"imageSha":image,"runId":"123","runAttempt":1,"gate":"passed"}))
    def publish(image, bootstrap=False):
        from staging_scene_files import inventory
        state = m.AcceptedState(host.root)
        if bootstrap: state.designate("203.0.113.10", "d"*64)
        state.bind(image, "c"*40)
        snapshot = image+"-"+"c"*40
        target = state.directory / "snapshots" / snapshot
        scene = target / "public/assets/scenes/test-scene"
        scene.mkdir(parents=True)
        (scene / "scene.json").write_text(json.dumps({"sceneId":"test-scene","glbPath":"scene.glb"}))
        (scene / "scene.glb").write_bytes(b"accepted scene bytes")
        (target / "snapshot.json").write_text(json.dumps({"schemaVersion":1,"imageSha":image,"assetSha":"c"*40,"scenes":["test-scene"],"files":inventory(target / "public")}))
        record = {"schemaVersion":1,"imageSha":image,"assetSha":"c"*40,"snapshotId":snapshot,
                  "foundationDigests":{name:"registry.example/"+name+"@sha256:"+"e"*64 for name in m._state_module.FOUNDATIONS},
                  "runId":"123","runAttempt":1}
        state.publish(record, proof, bootstrap, "203.0.113.10", "d"*64)
        return state
    calls.clear()
    write_proof(current)
    rejects(lambda: host.verify_wave2(baseline, proof), "staging_gate_proof_image_mismatch")
    assert calls == [], "invalid proof must fail before querying Docker"
    assert host.marker() is None
    write_proof(baseline)
    host.verify_wave2(baseline, proof)
    assert host.marker() is None, "pre-publication verification must be read-only"
    calls.clear()
    rejects(lambda: host.record_wave2(baseline, proof), "successful_gate_required")
    assert calls == [], "a candidate must not become the rollback baseline"
    state = publish(baseline, True)
    rejects(lambda: host.guard_accepted(baseline), "finalization_pending")
    with patch.object(m.os, "fsync", side_effect=OSError("simulated marker failure")):
        try: host.record_wave2(baseline, proof)
        except OSError: pass
        else: raise AssertionError("marker fsync must fail")
    assert host.marker() is None, "failed marker write must not expose truncated state"
    host.record_wave2(baseline, proof)
    assert host.marker() == baseline
    assert host.guard_accepted(baseline)["wave2Marker"] == baseline
    assert host.mutate("activate", baseline)["state"] == "active"
    assert calls[-1] == ["activate", "--expected-image-sha", baseline, "--rollback-sha", baseline]
    calls.clear()
    host.prepare(baseline)
    assert calls == [], "routine redeploy must not mutate catalog or require healthy API"
    status["imageSha"] = current
    write_proof(current)
    rejects(lambda: host.record_wave2(current, proof), "accepted_image_mismatch")
    publish(current)
    host.record_wave2(current, proof)
    assert host.marker() == baseline, "later deploy must not overwrite baseline"
    rejects(lambda: host.mutate("rollback", baseline), "accepted_image_mismatch")
    assert host.mutate("rollback", current)["state"] == "wave2"
    host.marker_path.write_text("invalid")
    rejects(host.marker, "invalid_sha")
print("catalog rollout assertions passed")
`], { encoding: "utf8", input: "remaining deployment commands" });
  assert.match(output, /assertions passed/);
});

test("bootstrap schema probe distinguishes absent, empty, initialized and broken state", () => {
  const output = execFileSync("python3", ["-B", "-c", `
import importlib.util, json, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("catalog", ${JSON.stringify(fileURLToPath(new URL("./staging-template-catalog.py", import.meta.url)))})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
def rejects(fn, code):
    try: fn()
    except (ValueError, RuntimeError) as error: assert code in str(error), str(error)
    else: raise AssertionError("expected " + code)
with tempfile.TemporaryDirectory() as directory:
    host = m.CatalogHost(directory)
    volume, containers, running = "", "", ""
    configuration = {"volumes":{"postgres-data":{"name":"test_postgres-data"}}}
    status = {"relations":0,"templates":False,"rooms":False}
    def run(args):
        if args[-3:] == ["config","--format","json"]:
            return json.dumps(configuration)
        if args[:3] == ["docker","volume","ls"]: return volume
        if args[-4:] == ["ps","-a","-q","postgres"]: return containers
        if args[-3:] == ["ps","-q","postgres"]: return running
        if "exec" in args: return status if isinstance(status, str) else json.dumps(status)
        raise AssertionError("unexpected command")
    host.run = run
    assert host.schema_state() == {"schema":"absent"}
    containers = "container-id"
    rejects(host.schema_state, "volume_missing")
    volume = "test_postgres-data-foreign"
    rejects(host.schema_state, "volume_missing")
    volume = "test_postgres-data"
    rejects(host.schema_state, "not_running")
    running = "container-id"
    assert host.schema_state() == {"schema":"empty"}
    status = {"relations":12,"templates":True,"rooms":True}
    assert host.schema_state() == {"schema":"initialized"}
    status = {"relations":1,"templates":False,"rooms":False}
    rejects(host.schema_state, "schema_partial")
    status = {"relations":1,"templates":False,"rooms":True}
    rejects(host.schema_state, "schema_partial")
    status = {"relations":0,"templates":True,"rooms":True}
    rejects(host.schema_state, "schema_partial")
    status = {"relations":False,"templates":False,"rooms":False}
    rejects(host.schema_state, "schema_invalid")
    status = "not JSON"
    rejects(host.schema_state, "schema_invalid")
    running = "one\\ntwo"
    rejects(host.schema_state, "not_running")
    running = "container-id"
    configuration = {"volumes":{}}
    rejects(host.schema_state, "volume_unknown")
    configuration = {"volumes":{"postgres-data":{"name":"test_postgres-data"}}}
    original = host.run
    def unavailable(args):
        if "exec" in args: raise RuntimeError("database_unavailable")
        return original(args)
    host.run = unavailable
    rejects(host.schema_state, "database_unavailable")
    for failure in ("volume", "container"):
        def failed_probe(args):
            if failure == "volume" and args[:3] == ["docker","volume","ls"]:
                raise RuntimeError("volume_list_failed")
            if failure == "container" and args[-4:] == ["ps","-a","-q","postgres"]:
                raise RuntimeError("container_list_failed")
            return original(args)
        host.run = failed_probe
        rejects(host.schema_state, failure+"_list_failed")
print("schema probe assertions passed")
`], { encoding: "utf8" });
  assert.match(output, /assertions passed/);
});
