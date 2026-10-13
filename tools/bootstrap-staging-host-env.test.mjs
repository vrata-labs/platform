import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getMediaTokenConfigError } from "../apps/api/dist/livekit-config.js";

test("first host configuration has unique secrets and a safe repeat preserves them", () => {
  const source = fileURLToPath(new URL("./bootstrap-staging-host-env.py", import.meta.url));
  const example = fileURLToPath(new URL("../infra/docker/.env.staging.example", import.meta.url));
  const output = execFileSync("python3", ["-B", "-c", `
import importlib.util,tempfile,shutil,json
from pathlib import Path
spec=importlib.util.spec_from_file_location("env",${JSON.stringify(source)})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as directory:
    root=Path(directory)/"checkout";(root/"infra/docker").mkdir(parents=True)
    shutil.copyfile(${JSON.stringify(example)},root/"infra/docker/.env.staging.example")
    assert m.bootstrap_env(root,"203.0.113.10","a"*40)=={"created":True}
    path=root/"infra/docker/.env.staging";content=path.read_bytes();env=m.parse_env(path)
    assert path.stat().st_mode & 0o777==0o600
    assert env["VRATA_APP_BASE_URL"]=="https://203.0.113.10.sslip.io"
    assert env["LIVEKIT_NODE_IP"]=="203.0.113.10"
    assert env["LIVEKIT_TURN_TLS_PORT"]=="" and env["LIVEKIT_TURN_EXTERNAL_TLS"]=="false"
    assert env["CADDY_CONFIG_FILE"]=="./Caddyfile.staging"
    assert env["VRATA_STAGING_SCENE_ROOT"]=="/srv/staging-state/active/public"
    assert env["REMOTE_BROWSER_ALLOWED_ORIGINS"].find("localhost")==-1
    assert env["REMOTE_BROWSER_ALLOW_PRIVATE_ALLOWED_ORIGINS"]=="false"
    values=[env[k] for k in ["CONTROL_PLANE_ADMIN_TOKEN","STATE_TOKEN_SECRET","REMOTE_BROWSER_TOKEN_SECRET","VRATA_INTERNAL_SERVICE_TOKEN","REMOTE_BROWSER_INTERNAL_TOKEN","POSTGRES_PASSWORD","MINIO_ROOT_PASSWORD","LIVEKIT_API_SECRET"]]
    assert len(set(values))==len(values) and all(len(v)>=40 for v in values)
    assert "postgres:"+env["POSTGRES_PASSWORD"]+"@postgres" in env["POSTGRES_URL"]
    assert m.bootstrap_env(root,"203.0.113.10","b"*40)=={"created":False}
    assert path.read_bytes()==content,"repeat must not rotate secrets or candidate SHA"
    try:m.bootstrap_env(root,"203.0.113.11","a"*40)
    except ValueError as e:assert str(e)=="staging_bootstrap_existing_host_mismatch"
    else:raise AssertionError("different host must fail")
print(json.dumps(env))
`], { encoding: "utf8" });
  const generated = JSON.parse(output);
  assert.equal(getMediaTokenConfigError({ ...generated, NODE_ENV: "production" }), null,
    "the generated endpoint must pass the real production API startup gate");
});
