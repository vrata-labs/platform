import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("catalog rollout rejects incompatible images and preserves the verified baseline", () => {
  const output = execFileSync("python3", ["-B", "-c", `
import importlib.util, json, sys, tempfile
from pathlib import Path
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
m.assert_target_allowed(baseline, {"state":"active", "referenceRoomCount":3}, boundary, current, 2)
rejects(lambda: m.assert_target_allowed(baseline, None, contract, current, 1, True), "identity_rollback_below_boundary")
m.assert_target_allowed(baseline, None, boundary, current, 1, True)
for invalid in (None, True, "1", 0):
    rejects(lambda: m.assert_target_allowed(None, None, dict(contract, identityProtocolFloorGuard=invalid), current, 2), "identity_rollback_below_boundary")
for invalid in (0, True, None):
    rejects(lambda: m.assert_target_allowed(None, None, boundary, current, invalid), "invalid_protocol_floor")
with tempfile.TemporaryDirectory() as directory:
    host = m.CatalogHost(directory)
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
    host.identity_bound = lambda: False
    host.validate_identity_database = lambda: None
    rejects(lambda: host.mutate("activate", baseline), "verified_wave2")
    rejects(lambda: host.record_wave2(baseline), "successful_gate")
    host.success_path.write_text(baseline)
    host.record_wave2(baseline)
    assert host.marker() == baseline
    assert host.mutate("activate", baseline)["state"] == "active"
    assert calls[-1] == ["activate", "--expected-image-sha", baseline, "--rollback-sha", baseline]
    calls.clear()
    host.prepare(baseline)
    assert calls == [], "routine redeploy must not mutate catalog or require healthy API"
    status["imageSha"] = current
    host.success_path.write_text(current)
    host.record_wave2(current)
    assert host.marker() == baseline, "later deploy must not overwrite baseline"
    rejects(lambda: host.mutate("rollback", baseline), "image_mismatch")
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
    for a, b in ((None,None),("dev-state-secret","dev-state-secret"),("configured-secret","different-secret")):
        host.run = lambda args: model(a,b)
        try: host.validate_identity_configuration()
        except ValueError as error:
            assert "identity_rollout_state_secret" in str(error)
            assert "configured-secret" not in str(error) and "different-secret" not in str(error)
        else: raise AssertionError("bad or drifting signing secret accepted")
    host.run = lambda args: model("configured-secret","configured-secret")
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
    host.identity_bound = lambda: False
    with patch.dict(os.environ, {"VRATA_INTERNAL_SERVICE_TOKEN": ""}):
        try: host.prepare("a"*40)
        except ValueError as error: assert str(error) == "identity_rollout_internal_service_token_required"
        else: raise AssertionError("floor two accepted an unconfigured service credential")
`], { encoding: "utf8" });
});
