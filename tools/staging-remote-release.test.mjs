import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("remote failure distinguishes bootstrap, accepted rollback and post-commit metadata repair", () => {
  const file = fileURLToPath(new URL("./staging-remote-release.py", import.meta.url));
  const output = execFileSync("python3", ["-B", "-c", `
import importlib.util,tempfile,json
from pathlib import Path
spec=importlib.util.spec_from_file_location("remote",${JSON.stringify(file)})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def rejects(fn,code):
    try:fn()
    except (ValueError,RuntimeError,OSError) as e:assert code in str(e),str(e)
    else:raise AssertionError("expected "+code)
a,b,x="a"*40,"b"*40,"c"*40
record={"schemaVersion":1,"imageSha":a,"assetSha":x,"snapshotId":a+"-"+x,
        "foundationDigests":{n:"example/"+n+"@sha256:"+"d"*64 for n in m.accepted.FOUNDATIONS},
        "runId":"1","runAttempt":1}
with tempfile.TemporaryDirectory() as directory:
    root=Path(directory)/"checkout";(root/"infra/docker").mkdir(parents=True)
    host=m.ReleaseHost(root); calls=[]
    host.run=lambda args,quiet=False:calls.append(args) or ""
    host.raw_rollout=lambda image:calls.append(["rollout",image])
    host.catalog.prepare=lambda image:calls.append(["prepare",image])
    m.activate_snapshot=lambda state,image,asset:calls.append(["assets",image,asset])
    assert host.rollback(b,"2",1)=={"rollback":"not_started"}
    assert calls==[]
    attempt=host.attempt_path("2",1);attempt.mkdir(parents=True)
    (attempt/"previous.json").write_text("null")
    assert host.rollback(b,"2",1)=={"rollback":"no_previous_release","bootstrap":True}
    assert calls==[]
    (host.state.directory/"accepted-release.json").write_text(json.dumps(record))
    (attempt/"previous.json").write_text(json.dumps(record))
    result=host.rollback(b,"2",1)
    assert result["imageSha"]==a and result["assetSha"]==x
    assert ["prepare",a] in calls and ["assets",a,x] in calls and ["rollout",a] in calls
    assert not any("down" in args for args in calls),"rollback must not remove volumes"
    assert host.state.manifest()==record
    calls.clear()
    committed=dict(record,imageSha=b,snapshotId=b+"-"+x,runId="2")
    host.state.manifest_path.write_text(json.dumps(committed))
    rejects(lambda:host.rollback(b,"2",1),"committed_metadata_repair_required")
    assert calls==[]
    assert host.rollback(b,"2",2)=={"rollback":"not_started"}
    second=host.attempt_path("2",2);second.mkdir(parents=True)
    (second/"previous.json").write_text(json.dumps(record))
    rejects(lambda:host.rollback(b,"2",2),"previous_state_changed")
    assert calls==[]
    with __import__("unittest.mock").mock.patch.object(host.state,"manifest",side_effect=PermissionError("unreadable")):
        rejects(lambda:host.rollback(b,"2",1),"unreadable")
    assert calls==[]
print("remote rollback assertions passed")
`], { encoding: "utf8" });
  assert.match(output, /remote rollback assertions passed/);
});

test("rollout fetches an exact older or non-main SHA from a shallow bootstrap checkout", () => {
  const file = fileURLToPath(new URL("./staging-remote-release.py", import.meta.url));
  execFileSync("python3", ["-B", "-c", `
import importlib.util,tempfile,json,subprocess
from pathlib import Path
spec=importlib.util.spec_from_file_location("remote",${JSON.stringify(file)})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def git(root,*args):return subprocess.check_output(["git","-C",str(root),*args],stderr=subprocess.DEVNULL,text=True).strip()
with tempfile.TemporaryDirectory() as directory:
    base=Path(directory);origin=base/"origin";origin.mkdir()
    git(origin,"init","--initial-branch=main")
    (origin/"infra/docker").mkdir(parents=True)
    (origin/"infra/docker/compose.staging.yml").write_text("# VRATA_STAGING_SCENE_ROOT\\nservices: {}\\n")
    (origin/"infra/docker/staging-scene-catalog.json").write_text(json.dumps({"rooms":[]}))
    git(origin,"add",".")
    def commit(message):
        git(origin,"-c","user.name=fixture","-c","user.email=fixture@example.invalid","commit","-m",message)
        return git(origin,"rev-parse","HEAD")
    first=commit("initial fixture")
    (origin/"change.txt").write_text("new main");git(origin,"add",".");commit("main update")
    git(origin,"checkout","-b","fixture-feature")
    (origin/"change.txt").write_text("feature");git(origin,"add",".");feature=commit("feature update")
    git(origin,"checkout","main")
    root=base/"checkout"
    subprocess.run(["git","clone","--quiet","--depth=1","--branch","main",origin.as_uri(),str(root)],check=True)
    host=m.ReleaseHost(root);calls=[]
    host.preflight=lambda image,bootstrap=False:{"release":None,"mode":"bootstrap"}
    host.catalog.schema_state=lambda:{"schema":"empty"}
    host.raw_rollout=lambda image:calls.append(image)
    m.prepare_snapshot=lambda *args:None;m.activate_snapshot=lambda *args:None
    for index,image in enumerate([first,feature]):
        host.rollout(image,"e"*40,base/"unused-source",str(index+1),1,bootstrap=True)
        assert git(root,"rev-parse","HEAD")==image
    assert calls==[first,feature]
`], { encoding: "utf8" });
});

test("read-only host preflight refuses an accepted rollback target incompatible with the live identity boundary", () => {
  const file = fileURLToPath(new URL("./staging-remote-release.py", import.meta.url));
  execFileSync("python3", ["-B", "-c", `
import importlib.util,tempfile
from contextlib import nullcontext
spec=importlib.util.spec_from_file_location("remote",${JSON.stringify(file)})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as root:
    host=m.ReleaseHost(root);calls=[]
    host.env=lambda:{"LIVEKIT_NODE_IP":"203.0.113.10","VRATA_STAGING_PUBLIC_IP":"203.0.113.10"}
    host.state.locked=lambda **kwargs:nullcontext()
    host.state.preflight=lambda *args:{"release":{"imageSha":"a"*40}}
    host.state.binding=lambda image:None
    host.catalog.guard_accepted=lambda image:calls.append(("accepted",image))
    def refused(image):
        calls.append(("rollback-preflight",image))
        raise ValueError("room_record_rollback_requires_reader2")
    host.catalog.prepare=refused
    try:host.preflight("b"*40)
    except ValueError as error:assert str(error)=="room_record_rollback_requires_reader2"
    else:raise AssertionError("unsafe recovery target accepted")
    assert calls==[("accepted","a"*40),("rollback-preflight","a"*40)]
`], { encoding: "utf8" });
});
