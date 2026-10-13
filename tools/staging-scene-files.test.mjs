import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("scene snapshot preserves accepted bytes and atomically restores all managed scenes", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const result = execFileSync("python3", ["-B", "-c", `
import sys,importlib.util,tempfile,json
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(`${root}tools`)})
from staging_scene_files import prepare_snapshot,verify_snapshot,activate_snapshot
spec=importlib.util.spec_from_file_location("state",${JSON.stringify(`${root}tools/staging-accepted-release.py`)})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def rejects(fn,code):
    try:fn()
    except (ValueError,OSError) as error: assert code in str(error),str(error)
    else:raise AssertionError("expected "+code)
a,b,x,y="a"*40,"b"*40,"c"*40,"d"*40
with tempfile.TemporaryDirectory() as directory:
    base=Path(directory); checkout=base/"checkout";checkout.mkdir()
    state=m.AcceptedState(checkout)
    source=base/"source"; scene=source/"scenes/sense-test";scene.mkdir(parents=True)
    (source/"manifest.json").write_text(json.dumps({"schemaVersion":1,"scenesRoot":"scenes","scenes":[{"sceneId":"sense-test","sceneDir":"sense-test"}]}))
    (scene/"scene.json").write_text(json.dumps({"sceneId":"sense-test","glbPath":"scene.glb"}))
    (scene/"scene.glb").write_bytes(b"accepted bytes")
    catalog={"rooms":[{"sceneId":"sense-test","versioned":True}]}
    first=prepare_snapshot(state,source,a,x,catalog)
    assert len(verify_snapshot(state.directory/"snapshots"/first["snapshotId"],a,x)["files"]) == 5
    activate_snapshot(state,a,x)
    public=state.directory/"active/public/assets/scenes/sense-test"
    assert (public/"scene.glb").read_bytes()==b"accepted bytes"
    assert (public/a/".vrata-scene-snapshot").read_text().find("asset_sha="+x)>=0
    (scene/"scene.glb").write_bytes(b"candidate bytes")
    (scene/"candidate-only.txt").write_text("temporary")
    next_snapshot=prepare_snapshot(state,source,b,y,catalog)
    activate_snapshot(state,b,y)
    assert (public/"candidate-only.txt").exists()
    activate_snapshot(state,a,x)
    assert (public/"scene.glb").read_bytes()==b"accepted bytes"
    assert not (public/"candidate-only.txt").exists()
    assert not (checkout/"apps").exists(),"snapshot must not modify checkout or tracked manifests"
    rejects(lambda:prepare_snapshot(state,source,a,y,catalog),"asset_binding_mismatch")
    accepted=state.directory/"snapshots"/first["snapshotId"]
    (accepted/"public/assets/scenes/sense-test/scene.glb").write_bytes(b"corrupted")
    rejects(lambda:activate_snapshot(state,a,x),"bytes_mismatch")
    assert state.directory.joinpath("active").readlink().as_posix()=="snapshots/"+first["snapshotId"]
    (scene/"escape").symlink_to(base)
    rejects(lambda:prepare_snapshot(state,source,"e"*40,"f"*40,catalog),"symlink")
    rejects(lambda:prepare_snapshot(state,source,"1"*40,"2"*40,{"rooms":[{"sceneId":"missing-scene"}]}),"catalog_incomplete")
print("snapshot transition assertions passed")
`], { encoding: "utf8" });
  assert.match(result, /snapshot transition assertions passed/);
});

test("accepted cleanup retains previous, baseline and referenced immutable URLs without unpinning candidates", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  execFileSync("python3", ["-B", "-c", `
import sys,importlib.util,tempfile,json
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(`${root}tools`)})
from staging_scene_files import prepare_snapshot,activate_snapshot,prune_snapshots
spec=importlib.util.spec_from_file_location("state",${JSON.stringify(`${root}tools/staging-accepted-release.py`)})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as directory:
    base=Path(directory);checkout=base/"checkout";(checkout/"infra/docker").mkdir(parents=True)
    state=m.AcceptedState(checkout);state.designate("203.0.113.1")
    source=base/"source";scene=source/"scenes/sense-test";scene.mkdir(parents=True)
    (source/"manifest.json").write_text(json.dumps({"schemaVersion":1,"scenesRoot":"scenes","scenes":[{"sceneDir":"sense-test"}]}))
    (scene/"scene.json").write_text(json.dumps({"sceneId":"sense-test","glbPath":"scene.glb"}))
    catalog={"rooms":[{"sceneId":"sense-test","versioned":True}]};assets="e"*40
    versions=[char*40 for char in "abcd"]
    for index,image in enumerate(versions):
        (scene/"scene.glb").write_bytes(image.encode())
        pointers=None if index!=3 else {"schemaVersion":1,"rooms":[{"sceneBundleUrl":"https://stage.invalid/assets/scenes/sense-test/"+versions[1]+"/scene.json"}]}
        prepare_snapshot(state,source,image,assets,catalog,pointers)
        activate_snapshot(state,image,assets)
        proof=base/"proof.json";proof.write_text(json.dumps({"schemaVersion":1,"imageSha":image,"runId":str(index+1),"runAttempt":1,"gate":"passed"}))
        record={"schemaVersion":1,"imageSha":image,"assetSha":assets,"snapshotId":image+"-"+assets,
                "foundationDigests":{name:"registry.example/"+name+"@sha256:"+"f"*64 for name in m.FOUNDATIONS},"runId":str(index+1),"runAttempt":1}
        state.publish(record,proof,bootstrap=index==0,public_ip="203.0.113.1")
        if index==0:(checkout/"infra/docker/.template-wave2-rollback-sha").write_text(image)
    activate_snapshot(state,versions[0],assets)
    try:prune_snapshots(state)
    except ValueError as error:assert "active_identity_mismatch" in str(error)
    else:raise AssertionError("cleanup must require accepted active bytes")
    assert all((state.directory/"snapshots"/(image+"-"+assets)).exists() for image in versions)
    activate_snapshot(state,versions[3],assets)
    result=prune_snapshots(state)
    assert result["removedSnapshots"]==1
    assert not (state.directory/"snapshots"/(versions[1]+"-"+assets)).exists()
    assert state.binding(versions[1])["assetSha"]==assets
    assert (state.directory/"active/public/assets/scenes/sense-test"/versions[1]/"scene.glb").read_bytes()==versions[1].encode()
    assert (state.directory/"active/public/assets/scenes/sense-test"/versions[0]/"scene.glb").exists()
    assert json.loads((state.directory/"previous-release.json").read_text())["imageSha"]==versions[2]
`], { encoding: "utf8" });
});
