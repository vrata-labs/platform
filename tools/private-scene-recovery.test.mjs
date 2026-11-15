import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const tools = fileURLToPath(new URL("./", import.meta.url));

// Same real AcceptedState + scene fixtures as staging-scene-files.test.mjs.
// Only Docker/database export is substituted; no source Git, S3, or host proof
// is fabricated by production recovery code.
const fixture = `
import sys,importlib.util,tempfile,json,shutil,subprocess,os,fcntl
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,${JSON.stringify(tools)})
from staging_scene_files import prepare_snapshot,activate_snapshot,verify_snapshot,prune_snapshots,inventory
def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(${JSON.stringify(tools)})/(name+".py"))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
m=load("private-scene-recovery");backup=load("backup-staging")
def rejects(fn,code):
    try:fn()
    except (ValueError,RuntimeError,OSError) as error:assert code in str(error),(code,str(error))
    else:raise AssertionError("expected "+code)
def write(path,value):path.write_text(json.dumps(value,sort_keys=True)+"\\n")
def setup(base):
    root=base/"checkout";(root/"infra/docker").mkdir(parents=True)
    state=m.accepted.AcceptedState(root);state.designate("203.0.113.1")
    source=base/"source";scene=source/"scenes/sense-test";scene.mkdir(parents=True)
    write(source/"manifest.json",{"schemaVersion":1,"scenesRoot":"scenes","scenes":[{"sceneDir":"sense-test"}]})
    write(scene/"scene.json",{"sceneId":"sense-test","glbPath":"scene.glb"})
    catalog={"rooms":[{"sceneId":"sense-test","versioned":True}]}
    images=[char*40 for char in "abcd"];assets=[char*40 for char in "1234"]
    for index,(image,asset) in enumerate(zip(images,assets)):
        (scene/"scene.glb").write_bytes(("original "+image).encode())
        pointers=None if index!=3 else {"schemaVersion":1,"rooms":[{"sceneBundleUrl":
            "https://state.stage.invalid/assets/scenes/sense-test/"+images[1]+"/scene.json"}]}
        prepare_snapshot(state,source,image,asset,catalog,pointers);activate_snapshot(state,image,asset)
        proof=base/"fixture-gate.json"
        write(proof,{"schemaVersion":1,"imageSha":image,"runId":str(index+1),"runAttempt":1,"gate":"passed"})
        record={"schemaVersion":1,"imageSha":image,"assetSha":asset,"snapshotId":image+"-"+asset,
            "foundationDigests":{n:"registry.invalid/"+n+"@sha256:"+"f"*64 for n in m.accepted.FOUNDATIONS},
            "runId":str(index+1),"runAttempt":1}
        record["foundationDigests"].update({"minio":backup.minio.PINNED_MINIO,"minio-bootstrap":backup.minio.PINNED_MC})
        state.publish(record,proof,bootstrap=index==0,public_ip="203.0.113.1")
        if index==0:(root/"infra/docker/.template-wave2-rollback-sha").write_text(image)
    prune_snapshots(state)
    assert not (state.directory/"snapshots"/(images[1]+"-"+assets[1])).exists()
    output=base/"backup";(output/"minio").mkdir(parents=True)
    shutil.copyfile(state.manifest_path,output/"accepted-release.json")
    (output/"minio/objects.jsonl").write_text("")
    template=json.dumps({"roomConfig":{"sceneBundleUrl":"/assets/scenes/sense-test/"+images[2]+"/scene.json"}})
    (output/"postgres.sql").write_text(
        "COPY public.other_table (value) FROM stdin;\\nignored\\n\\\\.\\n"
        "COPY public.rooms (room_id, scene_bundle_url, template_snapshot) FROM stdin;\\n"
        "legacy\\thttps://state.stage.invalid/assets/scenes/sense-test/"+images[1]+"/scene.json\\t"+template+"\\n"
        "unversioned\\t/assets/scenes/sense-test/scene.json\\t\\\\N\\n"
        "public\\t/assets/scenes/public-personal-v1/scene.json\\t\\\\N\\n"
        "null\\t\\\\N\\t\\\\N\\n\\\\.\\n")
    command=["node","--input-type=module","-e",
        'import {createBackupManifest} from '+json.dumps(str(Path(${JSON.stringify(tools)})/"backup-restore.mjs"))+
        ';import{writeFileSync}from"node:fs";const dir=process.argv[1];writeFileSync(dir+"/manifest.json",JSON.stringify(await createBackupManifest({backupDir:dir,source:{imageTag:process.argv[2]}})));',
        str(output),images[-1]]
    subprocess.run(command,check=True,capture_output=True)
    (root/"infra/docker/.env.staging").write_text("IMAGE_TAG="+images[-1]+"\\nAPI_IMAGE_REPO=registry.invalid/api\\n")
    return root,state,source,output,images,assets
def attach(state,output):
    with backup.remote.ReleaseHost(state.root).operation_lock(),state.locked(create=False,shared=True):
        return m.attach(state,output,m.metadata(state))
def resign(output):
    path=output/m.NAMESPACE;record=json.loads((path/"recovery.json").read_text())
    record["files"]=[e for e in inventory(path) if e["path"]!="recovery.json"];write(path/"recovery.json",record)
    manifest=json.loads((output/"manifest.json").read_text())
    manifest["artifacts"]=[e for e in manifest["artifacts"] if e["kind"]!=m.KIND]
    manifest["artifacts"] += [dict(e,path=m.NAMESPACE+"/"+e["path"],kind=m.KIND) for e in inventory(path)]
    write(output/"manifest.json",manifest)
def protected(state):
    return state.manifest_path.read_bytes(),(state.directory/"active").readlink(),state.legacy_path.read_bytes()
def docker(command,root):
    if command[:2]==["docker","inspect"]:
        service=command[-1]
        return {"api-container":"registry.invalid/api:"+("d"*40),"minio-container":backup.minio.PINNED_MINIO,
                "minio-bootstrap-container":backup.minio.PINNED_MC}[service]
    service=command[-1];return service+"-container"
`;

function run(body) {
  return execFileSync("python3", ["-B", "-c", fixture + "\n" + body], { encoding: "utf8", timeout: 60000 });
}

test("included snapshots recover current/previous/Wave2 and pruned room versions without scene Git or host acceptance", () => {
  const result = run(`
with tempfile.TemporaryDirectory() as directory:
    base=Path(directory);root,state,source,output,images,assets=setup(base)
    before=protected(state)
    record=attach(state,output);assert m.validate(output)==record
    assert len(record["snapshots"])==3 and len(record["releases"])==4
    assert record["roomUrls"][0]["sceneBundleUrl"].endswith(images[1]+"/scene.json")
    assert record["roomUrls"][0]["templateSceneBundleUrl"].endswith(images[2]+"/scene.json")
    assert all(e["descriptorKey"]=="private-scenes/releases/"+e["assetSha"]+"/release.json" for e in record["releases"])
    assert protected(state)==before
    shutil.rmtree(source);shutil.rmtree(state.directory);shutil.rmtree(root)
    destination=base/"restored";destination.mkdir()
    command=[sys.executable,"-B",str(Path(${JSON.stringify(tools)})/"private-scene-recovery.py")]
    checked=subprocess.run(command+["validate","--backup-dir",str(output)],check=True,capture_output=True,text=True)
    assert json.loads(checked.stdout)=={"validated":True,"snapshots":3,"releases":4}
    restored=subprocess.run(command+["restore","--backup-dir",str(output),"--output",str(destination)],
        check=True,capture_output=True,text=True)
    assert json.loads(restored.stdout)=={"restored":True,"snapshots":3,"releases":4}
    assert inventory(destination)==inventory(output/m.NAMESPACE)
    for index in (0,2,3):
        tree=destination/"snapshots"/(images[index]+"-"+assets[index])
        verify_snapshot(tree,images[index],assets[index])
    current=destination/"snapshots"/record["acceptedRelease"]["snapshotId"]/"public/assets/scenes/sense-test"
    for index in range(4):assert (current/images[index]/"scene.glb").read_bytes()==("original "+images[index]).encode()
    for name in ("active","accepted-release.json","bootstrap-host.json","bindings",".git"):
        assert not (destination/name).exists()
    assert not list(base.glob(".private-scene-recovery-*"))
    assert all((p.stat().st_mode&0o777)==0o600 for p in destination.rglob("*") if p.is_file())
print("all scene versions restored without accepting a host")
`);
  assert.match(result, /all scene versions restored/);
});

test("byte corruption, missing files, links, extra files and old metadata-only backup fail without output", () => {
  run(`
with tempfile.TemporaryDirectory() as directory:
    base=Path(directory);root,state,source,original,images,assets=setup(base);attach(state,original)
    before=protected(state)
    for mode in ("tamper","missing","extra","symlink","metadata-only","sql"):
        output=base/mode;shutil.copytree(original,output)
        scene=output/m.NAMESPACE/"snapshots"/(images[-1]+"-"+assets[-1])/"public/assets/scenes/sense-test/scene.glb"
        if mode=="tamper":scene.write_bytes(b"changed")
        elif mode=="missing":scene.unlink()
        elif mode=="extra":(scene.parent/"unknown").write_bytes(b"unexpected")
        elif mode=="symlink":scene.unlink();scene.symlink_to(base/"not-scene")
        elif mode=="metadata-only":
            shutil.rmtree(output/m.NAMESPACE)
            manifest=json.loads((output/"manifest.json").read_text())
            manifest["artifacts"]=[e for e in manifest["artifacts"] if e["kind"]!=m.KIND];write(output/"manifest.json",manifest)
        else:(output/"postgres.sql").write_text("corrupt")
        destination=base/("restore-"+mode)
        rejects(lambda:m.restore(output,destination),"")
        assert not destination.exists() and not list(base.glob(".private-scene-recovery-*"))
        assert protected(state)==before
`);
});

test("self-consistent checksum edits cannot omit history or relabel a saved room version", () => {
  run(`
with tempfile.TemporaryDirectory() as directory:
    base=Path(directory);root,state,source,original,images,assets=setup(base);attach(state,original)
    for mode,code in (("unknown","historical_binding_missing"),("relabel","room_version_binding_mismatch"),
                      ("wave2","historical_binding_missing"),("previous","snapshot_set_mismatch"),
                      ("version","room_version_missing"),("urls","backup_metadata_mismatch"),
                      ("unsupported","unsupported_managed_url")):
        output=base/mode;shutil.copytree(original,output);path=output/m.NAMESPACE
        record=json.loads((path/"recovery.json").read_text())
        if mode=="unknown":record["releases"]=[e for e in record["releases"] if e["imageSha"]!=images[1]]
        elif mode=="relabel":
            entry=next(e for e in record["releases"] if e["imageSha"]==images[1])
            entry.update(assetSha="f"*40,descriptorKey="private-scenes/releases/"+("f"*40)+"/release.json")
        elif mode=="wave2":record["wave2ImageSha"]="f"*40
        elif mode=="previous":shutil.rmtree(path/"snapshots"/record["previousRelease"]["snapshotId"])
        elif mode=="version":
            tree=path/"snapshots"/record["acceptedRelease"]["snapshotId"]
            shutil.rmtree(tree/"public/assets/scenes/sense-test"/images[1])
            snapshot=json.loads((tree/"snapshot.json").read_text());snapshot["files"]=inventory(tree/"public")
            write(tree/"snapshot.json",snapshot)
        elif mode=="urls":record["roomUrls"]=[]
        else:
            record["roomUrls"][0]["sceneBundleUrl"]="https://state.stage.invalid/assets/scenes/sense-test/latest/scene.json"
            # The exact dump and its outer checksum agree, but a mutable managed URL is still forbidden.
            dump=output/"postgres.sql";dump.write_text(dump.read_text().replace(images[1],"latest"))
            manifest=json.loads((output/"manifest.json").read_text())
            entry=next(e for e in manifest["artifacts"] if e["path"]=="postgres.sql")
            import hashlib
            entry.update(bytes=dump.stat().st_size,sha256=hashlib.sha256(dump.read_bytes()).hexdigest());write(output/"manifest.json",manifest)
        write(path/"recovery.json",record);resign(output)
        rejects(lambda:m.restore(output,base/("restore-"+mode)),code)
        assert not (base/("restore-"+mode)).exists()
`);
});

test("restore never replaces live accepted state, rejects partial outer artifacts, and removes failed copy candidates", () => {
  run(`
with tempfile.TemporaryDirectory() as directory:
    base=Path(directory);root,state,source,output,images,assets=setup(base);attach(state,output)
    before=protected(state)
    rejects(lambda:m.restore(output,state.directory),"output_not_empty")
    assert protected(state)==before
    destination=base/"restored";destination.mkdir()
    copy=m.copy_private
    def interrupted(source,target):
        copy(source,target);raise OSError("injected_copy_failure")
    with patch.object(m,"copy_private",side_effect=interrupted):
        rejects(lambda:m.restore(output,destination),"injected_copy_failure")
    assert not list(destination.iterdir()) and not list(base.glob(".private-scene-recovery-*"))
    assert protected(state)==before
    # Even a change after the initial verification cannot publish stale copied bytes.
    original=(output/m.NAMESPACE/"recovery.json").read_bytes()
    def changed(source,target):
        copy(source,target);(output/m.NAMESPACE/"recovery.json").write_bytes(b"tampered after copy")
    with patch.object(m,"copy_private",side_effect=changed):
        rejects(lambda:m.restore(output,destination),"base_backup_invalid")
    (output/m.NAMESPACE/"recovery.json").write_bytes(original)
    assert not list(destination.iterdir()) and not list(base.glob(".private-scene-recovery-*"))
    assert protected(state)==before
    manifest=json.loads((output/"manifest.json").read_text())
    manifest["artifacts"]=[e for e in manifest["artifacts"] if e["path"]!=m.NAMESPACE+"/recovery.json"]
    write(output/"manifest.json",manifest)
    rejects(lambda:m.restore(output,destination),"artifact_set_mismatch")
    assert not list(destination.iterdir())
    resign(output)
    manifest=json.loads((output/"manifest.json").read_text())
    manifest["artifacts"]=[e for e in manifest["artifacts"] if e["kind"]!="accepted-release"]
    write(output/"manifest.json",manifest)
    rejects(lambda:m.restore(output,destination),"accepted_artifact_missing")
    assert not list(destination.iterdir())
`);
});

test("stage backup holds both protocol locks, attaches checksum artifacts, and verifies the real base backup", () => {
  run(`
with tempfile.TemporaryDirectory() as directory:
    base=Path(directory);root,state,source,exported,images,assets=setup(base)
    before=protected(state);calls=[];real_run=subprocess.run
    collision=base/"collision"/(".incomplete-vrata-fixed-"+images[-1]);collision.mkdir(parents=True)
    (collision/"manifest.json").write_text("not this operation's backup")
    with patch.object(backup,"datetime") as clock,patch.object(backup,"capture",side_effect=docker):
        clock.now.return_value.strftime.return_value="fixed"
        rejects(lambda:backup.backup(root,collision.parent),"destination_exists")
    assert (collision/"manifest.json").read_text()=="not this operation's backup"
    assert protected(state)==before
    def export(command,**kwargs):
        if len(command)>2 and command[2]=="backup":
            calls.append(command)
            for lock in (".deploy.lock",".state.lock"):
                child=real_run([sys.executable,"-c",
                    "import os,fcntl,sys;fd=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)",
                    str(state.directory/lock)],capture_output=True)
                assert child.returncode!=0 and b"BlockingIOError" in child.stderr
            destination=Path(command[command.index("--backup-dir")+1]);shutil.copytree(exported,destination)
            assert destination.name.startswith(".incomplete-vrata-")
            assert not list(destination.parent.glob("vrata-*")),"partial export must not enter retention"
            return type("Result",(),{"returncode":0})()
        return real_run(command,**kwargs)
    with patch.object(backup,"capture",side_effect=docker),patch.object(backup.subprocess,"run",side_effect=export):
        result=backup.backup(root,base/"backups")
    assert result["validated"] and protected(state)==before
    assert len(calls)==1 and calls[0].count("--compose-file")==2
    restored=base/"restored";m.restore(result["backupDir"],restored)
    m.validate(result["backupDir"])
`);
});

test("acceptance change during database export or final validation fails and invalidates the export", () => {
  run(`
for when in ("during-export","after-validation"):
  with tempfile.TemporaryDirectory() as directory:
    base=Path(directory);root,state,source,exported,images,assets=setup(base)
    before=protected(state);real_run=subprocess.run;real_validate=backup.recovery.validate
    old=(state.directory/"previous-release.json").read_bytes()
    def change():
        state.manifest_path.write_bytes(old);state.legacy_path.write_text(images[2]+"\\n")
    def export(command,**kwargs):
        if len(command)>2 and command[2]=="backup":
            destination=Path(command[command.index("--backup-dir")+1]);shutil.copytree(exported,destination)
            if when=="during-export":change()
            return type("Result",(),{"returncode":0})()
        return real_run(command,**kwargs)
    def validate(path):
        value=real_validate(path)
        if when=="after-validation":change()
        return value
    with patch.object(backup,"capture",side_effect=docker),patch.object(backup.subprocess,"run",side_effect=export),patch.object(backup.recovery,"validate",side_effect=validate):
        rejects(lambda:backup.backup(root,base/"backups"),"release_changed")
    copies=list((base/"backups").iterdir());assert len(copies)==1
    assert not (copies[0]/"manifest.json").exists() and (copies[0]/"manifest.incomplete.json").exists()
    assert not (copies[0]/m.NAMESPACE).exists()
    assert state.manifest_path.read_bytes()==old
    assert (state.directory/"active").readlink()==before[1],"backup must not roll back active bytes"
`);
});

test("missing historical binding or retained bytes refuses export without modifying acceptance", () => {
  run(`
for mode,code in (("binding","historical_binding_missing"),("bytes","bytes_mismatch"),("wave2","wave2_missing")):
  with tempfile.TemporaryDirectory() as directory:
    base=Path(directory);root,state,source,output,images,assets=setup(base);before=protected(state)
    if mode=="binding":(state.directory/"bindings"/(images[1]+".json")).unlink()
    elif mode=="bytes":
        (state.directory/"active/public/assets/scenes/sense-test"/images[1]/"scene.glb").unlink()
    else:(root/"infra/docker/.template-wave2-rollback-sha").unlink()
    rejects(lambda:attach(state,output),code)
    assert protected(state)==before
`);
});

test("room URL reader handles COPY escapes and refuses missing, duplicate, unsupported or truncated rooms", () => {
  run(String.raw`
with tempfile.TemporaryDirectory() as directory:
    path=Path(directory)/"dump"
    path.write_text("COPY public.rooms (room_id, scene_bundle_url) FROM stdin;\nroom\\tname\t/assets/scenes/sense-test/scene.json\n\\.\n")
    assert m.room_urls(path)[0]["roomId"]=="room\tname"
    for data in ("", "COPY public.rooms (room_id) FROM stdin;\n\\.\n",
                 "COPY public.rooms (room_id, scene_bundle_url) FROM stdin;\nid\t\\N\n",
                 "COPY public.rooms (room_id, scene_bundle_url) FROM stdin;\nid\t\\N\nid\t\\N\n\\.\n",
                 "COPY public.rooms (room_id, scene_bundle_url) FROM stdin;\n\\.\n"*2):
        path.write_text(data);rejects(lambda:m.room_urls(path),"private_scene_recovery_")
`);
});
