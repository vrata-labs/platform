import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OWNERLESS_REFERENCE_PERSONAL_SQL, ROOM_RECORD_SCHEMA_SQL } from "./identity-rollback-guard.mjs";

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
rejects(lambda: m.assert_target_allowed(baseline, None, contract, current, 2), "identity_rollback_below_boundary")
boundary = dict(contract, identityProtocolFloorGuard=1)
reader = dict(boundary, roomRecordReader=2)
frame = dict(reader, frameTokenCodec=2, mediaIdentityCodec=2, mediaScreenReconciler=2)
m.assert_target_allowed(baseline, {"state":"active", "referenceRoomCount":3}, frame, current, 2)
rejects(lambda: m.assert_target_allowed(baseline, None, boundary, current, 2), "room_record_rollback_requires_reader2")
rejects(lambda: m.assert_target_allowed(baseline, None, contract, current, 1, True), "identity_rollback_below_boundary")
m.assert_target_allowed(baseline, None, dict(boundary, frameTokenCodec=2), current, 1, True)
for invalid in (None, True, "1", 0):
    rejects(lambda: m.assert_target_allowed(None, None, dict(contract, identityProtocolFloorGuard=invalid), current, 2), "identity_rollback_below_boundary")
for invalid in (0, True, None):
    rejects(lambda: m.assert_target_allowed(None, None, boundary, current, invalid), "invalid_protocol_floor")
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
    host.minimum_identity_protocol = lambda: 1
    host.media_codec = lambda: 2
    host.media_namespace_rotated = lambda: False
    host.identity_bound = lambda: False
    host.ownerless_reference_personal = lambda: False
    host.validate_identity_database = lambda: None
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

test("identity rollout reads the persistent floor while the API is down and rejects missing rows", () => {
  execFileSync("python3", ["-B", "-c", `
import importlib.util, tempfile
spec = importlib.util.spec_from_file_location("catalog", ${JSON.stringify(fileURLToPath(new URL("./staging-template-catalog.py", import.meta.url)))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as root:
    host = m.CatalogHost(root)
    answers = iter(["f"]); host.run = lambda args: next(answers)
    assert host.minimum_identity_protocol() == 1
    answers = iter(["t", "2"])
    assert host.minimum_identity_protocol() == 2
    for values in (["t", ""], ["t", "0"], ["t", "1\\n2"], ["unexpected"]):
        answers = iter(values)
        try: host.minimum_identity_protocol()
        except ValueError as error: assert "invalid_protocol_floor" in str(error)
        else: raise AssertionError("missing/corrupt floor must fail closed")
    answers = iter(["t", "t"])
    assert host.identity_bound() is True
    answers = iter(["f"])
    assert host.identity_bound() is False
    import json
    def model(api, state): return json.dumps({"services":{"api":{"environment":{"STATE_TOKEN_SECRET":api}},"room-state":{"environment":{"STATE_TOKEN_SECRET":state}}}})
    signing = "configured-state-signing-secret-of-32-bytes"
    for a, b in ((None,None),("dev-state-secret","dev-state-secret"),(signing,"different-secret")):
        host.run = lambda args: model(a,b)
        try: host.validate_identity_configuration()
        except ValueError as error:
            assert "identity_rollout_state_secret" in str(error)
            assert "configured-secret" not in str(error) and "different-secret" not in str(error) and signing not in str(error)
        else: raise AssertionError("bad, short or drifting signing secret accepted")
    host.run = lambda args: model("configured-secret","configured-secret")
    try: host.validate_identity_configuration()
    except ValueError as error: assert str(error) == "identity_rollout_state_secret_too_short"
    else: raise AssertionError("a signing secret shorter than the v2 codec minimum was accepted")
    host.run = lambda args: model(signing, signing)
    from pathlib import Path
    env_file = Path(root)/"infra/docker/.env.staging"
    env_file.parent.mkdir(parents=True)
    env_file.write_text("VRATA_INTERNAL_SERVICE_TOKEN="+"x"*48+"\\n")
    host.validate_identity_configuration()
    def database(url): return json.dumps({"services":{"api":{"environment":{"POSTGRES_URL":url}},"postgres":{"environment":{"POSTGRES_USER":"vrata","POSTGRES_DB":"vrata"}}}})
    host.run = lambda args: database("postgres://vrata:test-only@postgres:5432/vrata")
    host.validate_identity_database()
    for url in ("postgres://vrata:test-only@external/vrata", "postgres://vrata:test-only@postgres/other", "postgres://vrata:test-only@postgres/vrata?options=custom"):
        host.run = lambda args: database(url)
        try: host.validate_identity_database()
        except ValueError as error: assert str(error) == "identity_rollout_requires_matching_bundled_database"
        else: raise AssertionError("probed an unrelated database")
`], { encoding: "utf8" });
});

test("staging rejects missing, placeholder or development internal credentials before compatible rollout", () => {
  execFileSync("python3", ["-B", "-c", `
import importlib.util,json,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location("catalog",${JSON.stringify(fileURLToPath(new URL("./staging-template-catalog.py", import.meta.url)))})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as root:
    host=m.CatalogHost(root)
    host.run=lambda args:json.dumps({"services":{name:{"environment":{"STATE_TOKEN_SECRET":"configured-state-signing-secret-of-32-bytes"}} for name in ("api","room-state")}})
    path=Path(root)/"infra/docker/.env.staging";path.parent.mkdir(parents=True)
    for value in ("","dev-internal-service-token","REPLACE_WITH_"+"x"*48,"short-private-value","unconfigured-read-only-preflight"):
        path.write_text("VRATA_INTERNAL_SERVICE_TOKEN="+value+"\\n")
        try:host.validate_identity_configuration()
        except ValueError as error:assert str(error)=="identity_rollout_internal_service_token_required"
        else:raise AssertionError("unsafe internal credential accepted")
    path.write_text("VRATA_INTERNAL_SERVICE_TOKEN="+"x"*48+"\\n")
    host.validate_identity_configuration()
    path.write_text("VRATA_INTERNAL_SERVICE_TOKEN=REPLACE_WITH_"+"x"*48+"\\n")
    assert host.read_only_compose_environment()["VRATA_INTERNAL_SERVICE_TOKEN"]=="unconfigured-read-only-preflight"
`], { encoding: "utf8" });
});

test("room-record reader two is required at floor two or with ownerless personal references", () => {
  execFileSync("python3", ["-B", "-c", `
import importlib.util, tempfile
spec = importlib.util.spec_from_file_location("catalog", ${JSON.stringify(fileURLToPath(new URL("./staging-template-catalog.py", import.meta.url)))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
assert m.ROOM_RECORD_SCHEMA_SQL == ${JSON.stringify(ROOM_RECORD_SCHEMA_SQL)}, "stage and production schema probes drifted"
assert m.OWNERLESS_REFERENCE_PERSONAL_SQL == ${JSON.stringify(OWNERLESS_REFERENCE_PERSONAL_SQL)}, "stage and production predicates drifted"
def rejects(fn, code):
    try: fn()
    except (ValueError, RuntimeError) as e: assert str(e) == code, str(e)
    else: raise AssertionError("expected " + code)
current = "a"*40
boundary = {"schemaVersion":1, "templateSchema":2, "referenceTemplateVersions":["1.0.0", "2.0.0"], "identityProtocolFloorGuard":1}
reader = dict(boundary, roomRecordReader=2)
codec = dict(boundary, frameTokenCodec=2)
frame = dict(reader, frameTokenCodec=2, mediaIdentityCodec=2, mediaScreenReconciler=2)
rejects(lambda: m.assert_target_allowed(None, None, boundary, current, 2), "room_record_rollback_requires_reader2")
rejects(lambda: m.assert_target_allowed(None, None, boundary, current, 1, False, True), "room_record_rollback_requires_reader2")
rejects(lambda: m.assert_target_allowed(None, None, None, current, 1, False, True), "room_record_rollback_requires_reader2")
m.assert_target_allowed(None, None, None, current, 1, False, False)
m.assert_target_allowed(None, None, codec, current, 1, True, False)
m.assert_target_allowed(None, None, {"schemaVersion":1, "roomRecordReader":2}, current, 1, False, True)
m.assert_target_allowed(None, None, frame, current, 2, True, True)
m.assert_target_allowed(None, None, dict(frame, roomRecordReader=3), current, 2)
for invalid in (None, True, "2", 1, 0, -2, 2.0):
    rejects(lambda: m.assert_target_allowed(None, None, dict(reader, roomRecordReader=invalid), current, 2), "room_record_rollback_requires_reader2")
for invalid in (None, "t", 0, 1):
    rejects(lambda: m.assert_target_allowed(None, None, reader, current, 1, False, invalid), "room_record_rollout_invalid_reference_state")
with tempfile.TemporaryDirectory() as root:
    host = m.CatalogHost(root)
    seen = []
    def answering(*values):
        answers = iter(values)
        def run(args):
            seen.append(args)
            return next(answers)
        host.run = run
    answering("f", "f"); assert host.ownerless_reference_personal() is False
    answering("t", "t", "t"); assert host.ownerless_reference_personal() is True
    assert seen[-1][-1] == m.OWNERLESS_REFERENCE_PERSONAL_SQL
    answering("t", "t", "f"); assert host.ownerless_reference_personal() is False
    for values in (("f", "t"), ("f", ""), ("t", "f"), ("t", ""), ("t", "t", ""), ("t", "t", "private-room-id"), ("unexpected",)):
        answering(*values)
        rejects(host.ownerless_reference_personal, "room_record_rollout_invalid_reference_state")
    prefix = host.compose + ["exec", "-T", "postgres"]
    assert all(args[:len(prefix)] == prefix for args in seen), "probes only query the bundled database"
    def api_down(*args, **kwargs): raise AssertionError("prepare must not require a running API")
    host.cli = api_down
    host.run = lambda args: '{"state":"wave2","referenceRoomCount":0}'
    host.validate_identity_database = lambda: None
    host.validate_identity_configuration = lambda: None
    host.minimum_identity_protocol = lambda: 1
    host.media_codec = lambda: 2
    host.media_namespace_rotated = lambda: False
    host.identity_bound = lambda: False
    passed, original = [], m.assert_target_allowed
    def spy(*args, **kwargs):
        passed.append(kwargs.get("ownerless_reference_personal"))
        return original(*args, **kwargs)
    m.assert_target_allowed = spy
    host.contract = lambda target: boundary
    host.ownerless_reference_personal = lambda: True
    rejects(lambda: host.prepare(current), "room_record_rollback_requires_reader2")
    host.ownerless_reference_personal = lambda: False
    assert host.prepare(current)["ownerlessReferencePersonal"] is False
    host.contract = lambda target: reader
    host.ownerless_reference_personal = lambda: True
    assert host.prepare(current)["ownerlessReferencePersonal"] is True
    assert passed == [True, False, True]
`], { encoding: "utf8" });
});

test("frame-token codec two is required for activated or bound identity targets", () => {
  execFileSync("python3", ["-B", "-c", `
import importlib.util, tempfile
spec = importlib.util.spec_from_file_location("catalog", ${JSON.stringify(fileURLToPath(new URL("./staging-template-catalog.py", import.meta.url)))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def rejects(fn, code):
    try: fn()
    except (ValueError, RuntimeError) as e: assert str(e) == code, str(e)
    else: raise AssertionError("expected " + code)
current = "a"*40
codec = {"schemaVersion":1, "templateSchema":2, "referenceTemplateVersions":["1.0.0", "2.0.0"], "identityProtocolFloorGuard":1,
         "roomRecordReader":2, "frameTokenCodec":2, "mediaIdentityCodec":2, "mediaScreenReconciler":2}
legacy = {key: value for key, value in codec.items() if key != "frameTokenCodec"}
for floor, bound in ((2, False), (1, True), (2, True)):
    m.assert_target_allowed(None, None, codec, current, floor, bound)
    rejects(lambda: m.assert_target_allowed(None, None, legacy, current, floor, bound), "frame_rollback_requires_codec2")
    for invalid in (None, True, False, 0, 1, 3, -2, "2", 2.0, [2]):
        rejects(lambda: m.assert_target_allowed(None, None, dict(codec, frameTokenCodec=invalid), current, floor, bound), "frame_rollback_requires_codec2")
for invalid in (None, True, False, 0, 1, 3, "2", 2.0):
    rejects(lambda: m.assert_target_allowed(None, None, dict(codec, mediaIdentityCodec=invalid), current, 2), "media_rollback_requires_identity_codec2")
    m.assert_target_allowed(None, None, dict(codec, mediaIdentityCodec=invalid), current, 1, True)
for invalid in (None, True, False, 0, 1, 3, "2", 2.0):
    rejects(lambda: m.assert_target_allowed(None, None, dict(codec, mediaScreenReconciler=invalid), current, 2), "media_rollback_requires_screen_reconciler2")
    m.assert_target_allowed(None, None, dict(codec, mediaScreenReconciler=invalid), current, 1, True)
# The media codec boundary is never lowered: once raised, only images enforcing it are targets.
boundary = dict(codec, mediaCodecBoundary=3)
m.assert_target_allowed(None, None, codec, current, 2, True, media_codec=2)
m.assert_target_allowed(None, None, boundary, current, 2, True, media_codec=3)
rejects(lambda: m.assert_target_allowed(None, None, codec, current, 2, True, media_codec=3), "media_rollback_below_codec_boundary_forbidden")
for invalid in (None, True, 2, "3", 3.0, [3]):
    rejects(lambda: m.assert_target_allowed(None, None, dict(codec, mediaCodecBoundary=invalid), current, 2, True, media_codec=3), "media_rollback_below_codec_boundary_forbidden")
for invalid in (None, True, 1, 4, "3", 3.0):
    rejects(lambda: m.assert_target_allowed(None, None, boundary, current, 2, True, media_codec=invalid), "media_rollout_invalid_codec_boundary")
rejects(lambda: m.assert_target_allowed(None, None, boundary, current, 1, True, media_codec=3), "media_rollout_invalid_codec_boundary")
rotation = dict(boundary, mediaNamespaceRotation=1)
m.assert_target_allowed(None, None, rotation, current, 2, True, media_codec=3, namespace_rotated=True)
rejects(lambda: m.assert_target_allowed(None, None, boundary, current, 2, True, media_codec=3, namespace_rotated=True), "media_rollback_without_namespace_rotation_forbidden")
for invalid in (0, True, "1", None):
    rejects(lambda: m.assert_target_allowed(None, None, dict(boundary, mediaNamespaceRotation=invalid), current, 2, True, media_codec=3, namespace_rotated=True), "media_rollback_without_namespace_rotation_forbidden")
for invalid in (1, None, "t"):
    rejects(lambda: m.assert_target_allowed(None, None, rotation, current, 2, True, media_codec=3, namespace_rotated=invalid), "media_rollout_invalid_namespace_rotation")
rejects(lambda: m.assert_target_allowed(None, None, rotation, current, 1, False, namespace_rotated=True), "media_rollout_invalid_namespace_rotation")
# A preparatory image is a valid target before the raise, and still requires every floor-two capability.
rejects(lambda: m.assert_target_allowed(None, None, dict(boundary, mediaIdentityCodec=3), current, 2, True, media_codec=3), "media_rollback_requires_identity_codec2")
# Boundary and reader failures keep their own codes.
rejects(lambda: m.assert_target_allowed(None, None, dict(legacy, identityProtocolFloorGuard=None), current, 1, True), "identity_rollback_below_boundary_forbidden")
rejects(lambda: m.assert_target_allowed(None, None, dict(legacy, roomRecordReader=1), current, 2), "room_record_rollback_requires_reader2")
rejects(lambda: m.assert_target_allowed(None, None, dict(legacy, roomRecordReader=1), current, 1, True, True), "room_record_rollback_requires_reader2")
# Unbound floor one keeps ordinary paired-tag compatibility; that is not frame-token acceptance.
m.assert_target_allowed(None, None, None, current, 1, False, False)
m.assert_target_allowed(None, None, legacy, current, 1, False, True)
m.assert_target_allowed(None, None, dict(codec, frameTokenCodec=1), current, 1, False, True)
with tempfile.TemporaryDirectory() as root:
    host = m.CatalogHost(root)
    def api_down(*args, **kwargs): raise AssertionError("prepare must not require a running API")
    host.cli = api_down
    host.run = lambda args: '{"state":"wave2","referenceRoomCount":0}'
    host.validate_identity_database = lambda: None
    host.validate_identity_configuration = lambda: None
    host.minimum_identity_protocol = lambda: 1
    host.media_codec = lambda: 2
    host.media_namespace_rotated = lambda: False
    host.ownerless_reference_personal = lambda: False
    host.identity_bound = lambda: True
    host.contract = lambda target: legacy
    rejects(lambda: host.prepare(current), "frame_rollback_requires_codec2")
    host.contract = lambda target: codec
    assert host.prepare(current)["identityAuthorityBound"] is True
    host.identity_bound = lambda: False
    host.contract = lambda target: legacy
    assert host.prepare(current)["identityAuthorityBound"] is False
    host.minimum_identity_protocol = lambda: 2
    host.read_only_compose_environment = lambda: {}
    host.media_codec = lambda: 3
    host.media_namespace_rotated = lambda: False
    host.contract = lambda target: codec
    rejects(lambda: host.prepare(current), "media_rollback_below_codec_boundary_forbidden")
    host.contract = lambda target: dict(codec, mediaCodecBoundary=3)
    assert host.prepare(current)["mediaCodec"] == 3
    # After a namespace rotation only an image that issues in the rotated namespace and retires the old one may run.
    host.media_namespace_rotated = lambda: True
    rejects(lambda: host.prepare(current), "media_rollback_without_namespace_rotation_forbidden")
    host.contract = lambda target: dict(codec, mediaCodecBoundary=3, mediaNamespaceRotation=1)
    assert host.prepare(current)["mediaNamespaceRotated"] is True
    host.media_namespace_rotated = lambda: False
    # The probe: a database before the migration is codec 2, unreadable or foreign values fail closed.
    answers = []
    host.run = lambda args: answers.pop(0)
    del host.media_codec
    for replies, expected in ((["f"], 2), (["t", "2"], 2), (["t", "3"], 3)):
        answers[:] = replies
        assert host.media_codec() == expected, replies
    for replies in (["x"], ["t", ""], ["t", "1"], ["t", "4"], ["t", "3\\n3"]):
        answers[:] = replies
        rejects(host.media_codec, "media_rollout_invalid_codec_boundary")
    del host.media_namespace_rotated
    for replies, expected in ((["f"], False), (["t", "f"], False), (["t", "t"], True)):
        answers[:] = replies
        assert host.media_namespace_rotated() is expected, replies
    for replies in (["x"], ["t", ""], ["t", "1"], ["t", "t\\nt"]):
        answers[:] = replies
        rejects(host.media_namespace_rotated, "media_rollout_invalid_namespace_rotation")
`], { encoding: "utf8" });
});

test("read-only preflight survives a failed checkout's missing Caddy key without starting services", () => {
  execFileSync("python3", ["-B", "-c", `
import importlib.util, os, subprocess, tempfile
from pathlib import Path
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("catalog", ${JSON.stringify(fileURLToPath(new URL("./staging-template-catalog.py", import.meta.url)))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as root:
    env_file = Path(root)/"infra/docker/.env.staging"
    env_file.parent.mkdir(parents=True)
    env_file.write_text("STATE_TOKEN_SECRET=configured-state-signing-key\\n")
    host = m.CatalogHost(root)
    seen = []
    def run(args, **kwargs):
        seen.append((args, kwargs))
        return subprocess.CompletedProcess(args, 0, "read-only-ok", "")
    with patch.dict(os.environ, {"VRATA_INTERNAL_SERVICE_TOKEN": ""}), patch.object(m.subprocess, "run", side_effect=run):
        assert host.run(host.compose+["exec", "-T", "postgres", "true"]) == "read-only-ok"
        assert seen[-1][1]["env"]["VRATA_INTERNAL_SERVICE_TOKEN"] == "unconfigured-read-only-preflight"
        assert seen[-1][1]["env"]["VRATA_IDENTITY_PROXY_TOKEN"] == "unconfigured-read-only-preflight"
        assert host.run(host.compose+["config"]) == "read-only-ok"
        assert host.run(["git", "status"]) == "read-only-ok"
        assert seen[-1][1]["env"] is None
        env_file.write_text("VRATA_INTERNAL_SERVICE_TOKEN=configured-internal-key\\n")
        assert "VRATA_INTERNAL_SERVICE_TOKEN" not in host.read_only_compose_environment()
    env_file.write_text("STATE_TOKEN_SECRET=configured-state-signing-key\\n")
    host.contract = lambda target: {"schemaVersion":1,"templateSchema":2,"identityProtocolFloorGuard":1}
    host.validate_identity_database = lambda: None
    host.run = lambda args: '{"state":"wave2","referenceRoomCount":0}'
    host.minimum_identity_protocol = lambda: 2
    host.media_codec = lambda: 2
    host.media_namespace_rotated = lambda: False
    host.identity_bound = lambda: False
    with patch.dict(os.environ, {"VRATA_INTERNAL_SERVICE_TOKEN": ""}):
        try: host.prepare("a"*40)
        except ValueError as error: assert str(error) == "identity_rollout_internal_service_token_required"
        else: raise AssertionError("floor two accepted an unconfigured service credential")
`], { encoding: "utf8" });
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

test("catalog state for the gate comes from the database and a new host starts on Wave 2", () => {
  const output = execFileSync("python3", ["-B", "-c", `
import importlib.util, json, tempfile
spec = importlib.util.spec_from_file_location("catalog", ${JSON.stringify(fileURLToPath(new URL("./staging-template-catalog.py", import.meta.url)))})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as directory:
    host = m.CatalogHost(directory)
    schema, answer, queries = "absent", "active", []
    host.schema_state = lambda: {"schema": schema}
    def run(args):
        assert "api" not in args, "the candidate API must not decide the catalog state"
        queries.append(args[-1]); return answer
    host.run = run
    assert host.catalog_state() == {"state": "wave2", "schema": "absent"} and queries == []
    schema = "empty"
    assert host.catalog_state()["state"] == "wave2"
    schema = "initialized"
    assert host.catalog_state() == {"state": "active", "schema": "initialized"}
    assert queries[-1] == m.CATALOG_STATE_SQL
    answer = "wave2"
    assert host.catalog_state()["state"] == "wave2"
    answer = "broken"
    try: host.catalog_state()
    except ValueError as error: assert str(error) == "template_rollout_catalog_state_invalid"
    else: raise AssertionError("an unknown state was accepted")
print("catalog state assertions passed")
`], { encoding: "utf8" });
  assert.match(output, /assertions passed/);
  const workflow = readFileSync(new URL("../.github/workflows/staging-deploy.yml", import.meta.url), "utf8");
  assert(workflow.indexOf("- name: Read catalog state before rollout") < workflow.indexOf("- name: Roll out staging images"));
  assert.match(workflow, /staging-template-catalog\.py' catalog-state --root/);
  assert.match(workflow, /VRATA_REFERENCE_CATALOG_ACTIVE: \$\{\{ steps\.catalog\.outputs\.reference_active \}\}/);
});
