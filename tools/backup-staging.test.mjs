import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("staging backup rejects candidates and excludes an export spanning a release change", () => {
  const file = fileURLToPath(new URL("./backup-staging.py", import.meta.url));
  execFileSync("python3", ["-B", "-c", `
import importlib.util,tempfile,json,subprocess,shutil
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location("backup",${JSON.stringify(file)})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def rejects(fn,code):
    try:fn()
    except ValueError as error:assert code in str(error),str(error)
    else:raise AssertionError("expected "+code)
with tempfile.TemporaryDirectory() as directory:
    base=Path(directory);root=base/"checkout";(root/"infra/docker").mkdir(parents=True)
    state=m.accepted.AcceptedState(root);state.designate("203.0.113.1")
    a,b,asset="a"*40,"b"*40,"e"*40
    record={"schemaVersion":1,"imageSha":a,"assetSha":asset,"snapshotId":a+"-"+asset,
            "foundationDigests":{name:"registry.example/"+name+"@sha256:"+"f"*64 for name in m.accepted.FOUNDATIONS},"runId":"1","runAttempt":1}
    record["foundationDigests"].update({"minio":m.minio.PINNED_MINIO,"minio-bootstrap":m.minio.PINNED_MC})
    source=base/"source";scene=source/"scenes/sense-test";scene.mkdir(parents=True)
    (source/"manifest.json").write_text(json.dumps({"schemaVersion":1,"scenesRoot":"scenes","scenes":[{"sceneDir":"sense-test"}]}))
    (scene/"scene.json").write_text(json.dumps({"sceneId":"sense-test","glbPath":"scene.glb"}));(scene/"scene.glb").write_bytes(b"scene")
    from staging_scene_files import prepare_snapshot,activate_snapshot
    prepare_snapshot(state,source,a,asset,{"rooms":[{"sceneId":"sense-test","versioned":True}]});activate_snapshot(state,a,asset)
    proof=base/"proof.json";proof.write_text(json.dumps({"schemaVersion":1,"imageSha":a,"runId":"1","runAttempt":1,"gate":"passed"}))
    state.publish(record,proof,bootstrap=True,public_ip="203.0.113.1")
    (root/"infra/docker/.template-wave2-rollback-sha").write_text(a)
    env=root/"infra/docker/.env.staging";env.write_text("IMAGE_TAG="+b+"\\nAPI_IMAGE_REPO=registry.example/api\\n")
    calls=[]
    with patch.object(m,"capture",side_effect=lambda *args:calls.append(args) or ""):
        rejects(lambda:m.backup(root,base/"backups"),"candidate_env")
    assert calls==[]
    env.write_text("IMAGE_TAG="+a+"\\nAPI_IMAGE_REPO=registry.example/api\\n")
    with patch.object(m,"capture",side_effect=["container","registry.example/api:"+b]):
        rejects(lambda:m.backup(root,base/"backups"),"working_image_mismatch")
    def interrupted_export(command,**kwargs):
        assert command[2]=="backup"
        output=Path(command[command.index("--backup-dir")+1]);output.mkdir()
        (output/"manifest.json").write_text("{}")
        replacement=dict(record,imageSha=b,snapshotId=b+"-"+asset,runId="2")
        state.manifest_path.write_text(json.dumps(replacement));state.legacy_path.write_text(b)
        return type("Result",(),{"returncode":0})()
    legacy_running=["minio-container",m.minio.PINNED_MINIO,"mc-container",m.minio.PINNED_MC]
    with patch.object(m,"capture",side_effect=["container","registry.example/api:"+a,*legacy_running]),patch.object(m.subprocess,"run",side_effect=interrupted_export):
        rejects(lambda:m.backup(root,base/"backups"),"release_changed")
    copies=list((base/"backups").iterdir());assert len(copies)==1
    assert not (copies[0]/"manifest.json").exists()
    assert (copies[0]/"manifest.incomplete.json").exists()
    current=dict(record,foundationDigests=dict(record["foundationDigests"],minio="docker.io/storage@sha256:"+"1"*64))
    state.manifest_path.write_text(json.dumps(current));state.legacy_path.write_text(a)
    def config(server):
        return json.dumps({"services":{"minio":{"image":server},"minio-bootstrap":{"image":m.minio.PINNED_MC}}})
    with patch.object(m,"capture",side_effect=["container","registry.example/api:"+a,config("docker.io/storage@sha256:"+"2"*64)]):
        rejects(lambda:m.backup(root,base/"mismatch"),"foundation_mismatch")
    commands=[];real_run=subprocess.run
    def export(command,**kwargs):
        commands.append(command)
        if command[2]=="backup":
            output=Path(command[command.index("--backup-dir")+1]);(output/"minio").mkdir(parents=True)
            shutil.copyfile(state.manifest_path,output/"accepted-release.json")
            (output/"postgres.sql").write_text("COPY public.rooms (room_id, scene_bundle_url) FROM stdin;\\n\\\\.\\n")
            (output/"minio/objects.jsonl").write_text("")
            real_run(["node","--input-type=module","-e",
                'import{createBackupManifest}from '+json.dumps(str(Path(${JSON.stringify(file)}).with_name("backup-restore.mjs")))+
                ';import{writeFileSync}from"node:fs";const dir=process.argv[1];writeFileSync(dir+"/manifest.json",JSON.stringify(await createBackupManifest({backupDir:dir,source:{imageTag:process.argv[2]}})));',
                str(output),a],check=True,capture_output=True)
            return type("Result",(),{"returncode":0})()
        return real_run(command,**kwargs)
    storage="docker.io/storage@sha256:"+"1"*64
    with patch.object(m,"capture",side_effect=["container","registry.example/api:"+a,config(storage),"minio-container","docker.io/storage@sha256:"+"3"*64]):
        rejects(lambda:m.backup(root,base/"running"),"foundation_mismatch")
    with patch.object(m,"capture",side_effect=["container","registry.example/api:"+a,config(storage),"minio-container",storage,"mc-container",m.minio.PINNED_MC,"registry.example/api:"+a]),patch.object(m.subprocess,"run",side_effect=export):
        assert m.backup(root,base/"current")["validated"]
    assert commands[0][2]=="backup" and commands[0].count("--compose-file")==1,commands[0]
`], { encoding: "utf8" });
});
