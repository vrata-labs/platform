import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("development key replacement is atomic, secret-safe, idempotent and preserves other settings", () => {
  const result = execFileSync("python3", ["-B", "-c", `
import importlib.util, json, stat, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("state_key", ${JSON.stringify(fileURLToPath(new URL("./staging-state-key.py", import.meta.url)))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
generated = "test-only-generated-" + "x"*48
with tempfile.TemporaryDirectory() as root:
    path = Path(root)/"staging.env"
    for initial in (b'STATE_TOKEN_SECRET=dev-state-secret\\nOTHER=value\\n', b'OTHER=value', b'STATE_TOKEN_SECRET="dev-state-secret" # old\\r\\nOTHER=value\\r\\n', b'STATE_TOKEN_SECRET=REPLACE_WITH_STATE_TOKEN_SECRET\\n'):
        path.write_bytes(initial)
        result = m.replace_development_key(path, lambda: generated)
        assert result["stateSigningKey"] == "replaced_development_key"
        assert generated not in json.dumps(result)
        assert path.read_text().count(generated) == 1
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        if b'OTHER=value' in initial: assert b'OTHER=value' in path.read_bytes()
        before = path.read_bytes()
        assert m.replace_development_key(path, lambda: (_ for _ in ()).throw(AssertionError("must not rotate twice")))["stateSigningKey"] == "already_configured"
        assert path.read_bytes() == before
    path.write_text("STATE_TOKEN_SECRET=dev-state-secret\\nSTATE_TOKEN_SECRET=another\\n")
    before = path.read_bytes()
    try: m.replace_development_key(path)
    except ValueError as error: assert str(error) == "identity_state_key_duplicate"
    else: raise AssertionError("duplicate key accepted")
    assert path.read_bytes() == before
    path.write_text("STATE_TOKEN_SECRET=dev-state-secret\\n")
    def changed():
        path.write_text("OTHER=concurrent-update\\n")
        return generated
    try: m.replace_development_key(path, changed)
    except ValueError as error: assert str(error) == "identity_state_key_env_changed"
    else: raise AssertionError("overwrote concurrent update")
    assert path.read_text() == "OTHER=concurrent-update\\n"
    assert list(Path(root).iterdir()) == [path]
print("state_key_checks_passed")
`], { encoding: "utf8" });
  assert.equal(result.trim(), "state_key_checks_passed");
});

test("signing key replacement is explicit and uses the preserved helper before rollout", () => {
  const workflow = readFileSync(new URL("../.github/workflows/staging-deploy.yml", import.meta.url), "utf8");
  assert.match(workflow, /rotate_dev_state_secret:[\s\S]*?default: false/);
  assert.match(workflow, /if:.*workflow_dispatch.*inputs\.rotate_dev_state_secret/);
  assert(workflow.indexOf("Replace development state signing key") < workflow.indexOf("- name: Roll out staging images"));
  assert.match(workflow, /cp tools\/staging-state-key\.py "\$RUNNER_TEMP\/vrata-scene-rollback\/"/);
});

test("proxy proof is provisioned atomically, independently and only once on the host", () => {
  const result = execFileSync("python3", ["-B", "-c", `
import importlib.util, json, stat, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("state_key", ${JSON.stringify(fileURLToPath(new URL("./staging-state-key.py", import.meta.url)))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
generated = "test-only-proxy-" + "x"*48
with tempfile.TemporaryDirectory() as root:
    path = Path(root)/"staging.env"
    for initial in (b'STATE_TOKEN_SECRET=unchanged\\n', b'VRATA_IDENTITY_PROXY_TOKEN=REPLACE_WITH_PROXY_TOKEN\\nOTHER=value\\n'):
        path.write_bytes(initial)
        status = m.ensure_proxy_key(path, lambda: generated)
        assert status == {"identityProxyKey": "provisioned"}
        assert generated not in json.dumps(status)
        assert path.read_text().count(generated) == 1
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert b'OTHER=value' not in initial or b'OTHER=value' in path.read_bytes()
        assert b'STATE_TOKEN_SECRET=' not in initial or b'STATE_TOKEN_SECRET=unchanged' in path.read_bytes()
        before = path.read_bytes()
        assert m.ensure_proxy_key(path, lambda: (_ for _ in ()).throw(AssertionError("must not rotate"))) == {"identityProxyKey": "already_configured"}
        assert path.read_bytes() == before
    path.write_text('VRATA_IDENTITY_PROXY_TOKEN=a\\n')
    try: m.ensure_proxy_key(path)
    except ValueError as error: assert str(error) == 'identity_proxy_key_invalid'
    else: raise AssertionError('weak key accepted')
    path.write_text('VRATA_IDENTITY_PROXY_TOKEN=a\\nVRATA_IDENTITY_PROXY_TOKEN=b\\n')
    try: m.ensure_proxy_key(path)
    except ValueError as error: assert str(error) == 'identity_proxy_key_duplicate'
    else: raise AssertionError('duplicate key accepted')
    path.write_text('OTHER=before\\n')
    def changed():
        path.write_text('OTHER=concurrent-update\\n')
        return generated
    try: m.ensure_proxy_key(path, changed)
    except ValueError as error: assert str(error) == 'identity_proxy_key_env_changed'
    else: raise AssertionError('overwrote concurrent update')
    assert path.read_text() == 'OTHER=concurrent-update\\n'
    assert list(Path(root).iterdir()) == [path]
print('proxy_key_checks_passed')
`], { encoding: "utf8" });
  assert.equal(result.trim(), "proxy_key_checks_passed");
});

test("staging provisions its proxy proof before rollout without rotating the state key", () => {
  const workflow = readFileSync(new URL("../.github/workflows/staging-deploy.yml", import.meta.url), "utf8");
  assert(workflow.indexOf("- name: Provision identity proxy key") < workflow.indexOf("- name: Roll out staging images"));
  assert.match(workflow, /--ensure-proxy-key/);
  assert.match(workflow, /cp tools\/staging-state-key\.py "\$RUNNER_TEMP\/vrata-scene-rollback\/"/);
});

test("staging rollout generates an independent frame key and preserves an existing one", () => {
  const source = readFileSync(new URL("../infra/docker/rollout-staging-images.sh", import.meta.url), "utf8");
  const code = /python3 - "\$ENV_FILE" "\$IMAGE_TAG" <<'PY'\n([\s\S]*?)\nPY/.exec(source)?.[1];
  assert.ok(code);
  const directory = mkdtempSync(join(tmpdir(), "vrata-state-key-test-"));
  const path = join(directory, "staging.env");
  const rootKey = "test-only-state-key-for-api-and-room-state";
  const run = () => execFileSync("python3", ["-", path, "a".repeat(40)], { input: code, encoding: "utf8", env: { ...process.env, VRATA_STAGING_PUBLIC_IP: "127.0.0.1" } });
  const value = name => readFileSync(path, "utf8").split("\n").find(line => line.startsWith(`${name}=`))?.slice(name.length + 1);
  try {
    writeFileSync(path, `STATE_TOKEN_SECRET=${rootKey}\n`);
    run();
    const frameKey = value("REMOTE_BROWSER_TOKEN_SECRET");
    assert.equal(value("STATE_TOKEN_SECRET"), rootKey);
    assert.notEqual(frameKey, rootKey);
    assert.match(frameKey, /^[A-Za-z0-9_-]{64}$/);
    run();
    assert.equal(value("REMOTE_BROWSER_TOKEN_SECRET"), frameKey);
    writeFileSync(path, `STATE_TOKEN_SECRET=${rootKey}\nREMOTE_BROWSER_TOKEN_SECRET=test-only-existing-frame-key\n`);
    run();
    assert.equal(value("REMOTE_BROWSER_TOKEN_SECRET"), "test-only-existing-frame-key");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
