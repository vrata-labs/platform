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

test("media codec activation requires floor two and a candidate and rollback target that enforce the raised boundary", () => {
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
full={"schemaVersion":1,"identityProtocolFloorGuard":1,"roomRecordReader":2,"frameTokenCodec":2,"mediaIdentityCodec":2,"mediaScreenReconciler":2,"mediaCodecBoundary":3}
record={"schemaVersion":1,"imageSha":a,"assetSha":x,"snapshotId":a+"-"+x,
        "foundationDigests":{n:"example/"+n+"@sha256:"+"d"*64 for n in m.accepted.FOUNDATIONS},"runId":"1","runAttempt":1}
with tempfile.TemporaryDirectory() as directory:
    root=Path(directory)/"checkout";(root/"infra/docker").mkdir(parents=True)
    (root/"infra/docker/.env.staging").write_text("API_IMAGE_REPO=reg/api\\nROOM_STATE_IMAGE_REPO=reg/rs\\nREMOTE_BROWSER_IMAGE_REPO=reg/rb\\n")
    host=m.ReleaseHost(root); calls=[]; contracts={a:dict(full),b:dict(full)}
    state={"image":b,"cli":{"ok":True,"before":2,"after":3,"raised":True},"floor":2,"codec":3}
    def run(args,quiet=False):
        calls.append(args)
        if args[-2:]==["-q","api"] or args[-2:]==["-q","room-state"] or args[-2:]==["-q","remote-browser"]: return args[-1]+"-container"
        if args[:2]==["docker","inspect"]:
            repo={"api-container":"reg/api","room-state-container":"reg/rs","remote-browser-container":"reg/rb"}[args[-1]]
            return repo+":"+state["image"]
        if "activate-media-codec.js" in " ".join(args): return json.dumps(state["cli"])
        raise AssertionError(args)
    host.run=run
    host.catalog.contract=lambda sha:contracts[sha]
    host.catalog.validate_identity_database=lambda:calls.append(["db"])
    host.catalog.validate_identity_configuration=lambda:calls.append(["secrets"])
    host.catalog.minimum_identity_protocol=lambda:state["floor"]
    host.catalog.media_codec=lambda:state["codec"]
    host.state.directory.mkdir(parents=True,exist_ok=True); (host.state.directory/".state.lock").write_text("")
    (host.state.directory/"accepted-release.json").write_text(json.dumps(record))
    result=host.activate_media_codec3(b)
    assert result=={"mediaCodec":{"before":2,"after":3,"raised":True},"rollbackTarget":a},result
    cli=[args for args in calls if "activate-media-codec.js" in " ".join(args)]
    assert len(cli)==1 and cli[0][-1]=="--confirm-irreversible" and ["db"] in calls and ["secrets"] in calls
    def never_raised(code):
        calls.clear(); rejects(lambda:host.activate_media_codec3(b),code)
        assert not any("activate-media-codec.js" in " ".join(args) for args in calls),code
    state["image"]=a; never_raised("runtime_image_mismatch"); state["image"]=b
    state["floor"]=1; never_raised("staging_media_activation_requires_identity_v2"); state["floor"]=2
    contracts[b]={k:v for k,v in full.items() if k!="mediaCodecBoundary"}
    never_raised("candidate_incompatible:media_rollback_below_codec_boundary_forbidden")
    contracts[b]=dict(full); contracts[a]=dict(full,mediaCodecBoundary=2)
    never_raised("rollback_target_incompatible:media_rollback_below_codec_boundary_forbidden")
    contracts[a]=dict(full)
    state["cli"]={"ok":False,"error":"media_codec_requires_identity_v2"}
    rejects(lambda:host.activate_media_codec3(b),"staging_media_activation_unconfirmed")
    state["cli"]={"ok":True,"before":2,"after":3,"raised":True}; state["codec"]=2
    rejects(lambda:host.activate_media_codec3(b),"staging_media_activation_unconfirmed")
print("media activation assertions passed")
`], { encoding: "utf8" });
  assert.match(output, /media activation assertions passed/);
});

test("media namespace rotation retires the previous namespace only with a candidate and rollback target that issue in the rotated one", () => {
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
full={"schemaVersion":1,"identityProtocolFloorGuard":1,"roomRecordReader":2,"frameTokenCodec":2,"mediaIdentityCodec":2,"mediaScreenReconciler":2,
      "mediaCodecBoundary":3,"mediaNamespaceRotation":1}
record={"schemaVersion":1,"imageSha":a,"assetSha":x,"snapshotId":a+"-"+x,
        "foundationDigests":{n:"example/"+n+"@sha256:"+"d"*64 for n in m.accepted.FOUNDATIONS},"runId":"1","runAttempt":1}
done={"ok":True,"previous":"retire","before":"1"*12,"after":"2"*12,"retired":1,"rotated":True,"dryRun":False}
with tempfile.TemporaryDirectory() as directory:
    root=Path(directory)/"checkout";(root/"infra/docker").mkdir(parents=True)
    (root/"infra/docker/.env.staging").write_text("API_IMAGE_REPO=reg/api\\nROOM_STATE_IMAGE_REPO=reg/rs\\nREMOTE_BROWSER_IMAGE_REPO=reg/rb\\n")
    host=m.ReleaseHost(root); calls=[]; contracts={a:dict(full),b:dict(full)}
    state={"image":b,"cli":dict(done),"floor":2,"codec":3,"rotated":True}
    def run(args,quiet=False):
        calls.append(args)
        if args[-2:]==["-q","api"] or args[-2:]==["-q","room-state"] or args[-2:]==["-q","remote-browser"]: return args[-1]+"-container"
        if args[:2]==["docker","inspect"]:
            repo={"api-container":"reg/api","room-state-container":"reg/rs","remote-browser-container":"reg/rb"}[args[-1]]
            return repo+":"+state["image"]
        if "rotate-media-namespace.js" in " ".join(args): return json.dumps(state["cli"])
        raise AssertionError(args)
    host.run=run
    host.catalog.contract=lambda sha:contracts[sha]
    host.catalog.validate_identity_database=lambda:calls.append(["db"])
    host.catalog.validate_identity_configuration=lambda:calls.append(["secrets"])
    host.catalog.minimum_identity_protocol=lambda:state["floor"]
    host.catalog.media_codec=lambda:state["codec"]
    host.catalog.media_namespace_rotated=lambda:state["rotated"]
    host.state.directory.mkdir(parents=True,exist_ok=True); (host.state.directory/".state.lock").write_text("")
    (host.state.directory/"accepted-release.json").write_text(json.dumps(record))
    result=host.rotate_media_namespace(b)
    assert result=={"mediaNamespace":{"before":"1"*12,"after":"2"*12,"retired":1},"rollbackTarget":a},result
    cli=[args for args in calls if "rotate-media-namespace.js" in " ".join(args)]
    assert len(cli)==1 and cli[0][-2:]==["--previous=retire","--confirm-irreversible"] and ["db"] in calls and ["secrets"] in calls
    def never_rotated(code):
        calls.clear(); rejects(lambda:host.rotate_media_namespace(b),code)
        assert not any("rotate-media-namespace.js" in " ".join(args) for args in calls),code
    state["image"]=a; never_rotated("runtime_image_mismatch"); state["image"]=b
    state["floor"]=1; never_rotated("staging_media_rotation_requires_identity_v2"); state["floor"]=2
    contracts[b]={k:v for k,v in full.items() if k!="mediaNamespaceRotation"}
    never_rotated("candidate_incompatible:media_rollback_without_namespace_rotation_forbidden")
    contracts[b]=dict(full); contracts[a]={k:v for k,v in full.items() if k!="mediaNamespaceRotation"}
    never_rotated("rollback_target_incompatible:media_rollback_without_namespace_rotation_forbidden")
    contracts[a]=dict(full,mediaCodecBoundary=2)
    never_rotated("rollback_target_incompatible:media_rollback_below_codec_boundary_forbidden")
    contracts[a]=dict(full)
    for reply in ({"ok":False,"error":"media_namespace_requires_identity_v2"},dict(done,rotated=False),dict(done,retired=0),
                  dict(done,after=done["before"]),dict(done,previous="disown")):
        state["cli"]=reply; rejects(lambda:host.rotate_media_namespace(b),"staging_media_rotation_unconfirmed")
    state["cli"]=dict(done); state["rotated"]=False
    rejects(lambda:host.rotate_media_namespace(b),"staging_media_rotation_unconfirmed")
print("media rotation assertions passed")
`], { encoding: "utf8" });
  assert.match(output, /media rotation assertions passed/);
});

test("identity activation requires the running candidate and its rollback target to carry every floor-2 capability", () => {
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
full={"schemaVersion":1,"identityProtocolFloorGuard":1,"roomRecordReader":2,"frameTokenCodec":2,"mediaIdentityCodec":2,"mediaScreenReconciler":2}
record={"schemaVersion":1,"imageSha":a,"assetSha":x,"snapshotId":a+"-"+x,
        "foundationDigests":{n:"example/"+n+"@sha256:"+"d"*64 for n in m.accepted.FOUNDATIONS},"runId":"1","runAttempt":1}
with tempfile.TemporaryDirectory() as directory:
    root=Path(directory)/"checkout";(root/"infra/docker").mkdir(parents=True)
    (root/"infra/docker/.env.staging").write_text("API_IMAGE_REPO=reg/api\\nROOM_STATE_IMAGE_REPO=reg/rs\\nREMOTE_BROWSER_IMAGE_REPO=reg/rb\\n")
    host=m.ReleaseHost(root); calls=[]; contracts={a:dict(full),b:dict(full)}; state={"image":b,"cli":{"ok":True,"before":1,"after":2,"raised":True,"audit":{"rooms":3}},"floor":2}
    def run(args,quiet=False):
        calls.append(args)
        if args[-2:]==["-q","api"] or args[-2:]==["-q","room-state"] or args[-2:]==["-q","remote-browser"]: return args[-1]+"-container"
        if args[:2]==["docker","inspect"]:
            repo={"api-container":"reg/api","room-state-container":"reg/rs","remote-browser-container":"reg/rb"}[args[-1]]
            return repo+":"+state["image"]
        if "activate-v2.js" in " ".join(args): return json.dumps(state["cli"])
        raise AssertionError(args)
    host.run=run
    host.catalog.contract=lambda sha:contracts[sha]
    host.catalog.validate_identity_database=lambda:calls.append(["db"])
    host.catalog.validate_identity_configuration=lambda:calls.append(["secrets"])
    host.catalog.minimum_identity_protocol=lambda:state["floor"]
    host.state.directory.mkdir(parents=True,exist_ok=True); (host.state.directory/".state.lock").write_text("")
    (host.state.directory/"accepted-release.json").write_text(json.dumps(record))
    result=host.activate_identity_v2(b)
    assert result=={"identityProtocol":{"before":1,"after":2,"raised":True,"audit":{"rooms":3}},"rollbackTarget":a},result
    cli=[args for args in calls if "activate-v2.js" in " ".join(args)]
    assert len(cli)==1 and cli[0][-1]=="--confirm-irreversible" and ["db"] in calls and ["secrets"] in calls
    state["image"]=a; calls.clear()
    rejects(lambda:host.activate_identity_v2(b),"runtime_image_mismatch")
    assert not any("activate-v2.js" in " ".join(args) for args in calls),"never raise for a different running image"
    state["image"]=b
    contracts[b]=dict(full,mediaScreenReconciler=1)
    rejects(lambda:host.activate_identity_v2(b),"candidate_incompatible:media_rollback_requires_screen_reconciler2")
    contracts[b]=dict(full); contracts[a]={k:v for k,v in full.items() if k!="mediaIdentityCodec"}
    rejects(lambda:host.activate_identity_v2(b),"rollback_target_incompatible:media_rollback_requires_identity_codec2")
    contracts[a]=dict(full); calls.clear()
    state["cli"]={"ok":False,"error":"identity_protocol_policy_missing"}
    rejects(lambda:host.activate_identity_v2(b),"identity_activation_unconfirmed")
    state["cli"]={"ok":True,"before":1,"after":2,"raised":True,"audit":{}}; state["floor"]=1
    rejects(lambda:host.activate_identity_v2(b),"identity_activation_unconfirmed")
print("identity activation assertions passed")
`], { encoding: "utf8" });
  assert.match(output, /identity activation assertions passed/);
});
