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
