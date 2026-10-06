import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const bootstrap = fileURLToPath(new URL("../../../../infra/docker/minio-bootstrap.sh", import.meta.url));
const execute = promisify(execFile);
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "vrata-private-bootstrap-")); t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "state.json");
  await writeFile(state, JSON.stringify({ calls: [], policies: { "vrata/public-assets": "download" } }));
  const mc = join(root, "mc");
  await writeFile(mc, `#!${process.execPath}\nconst fs=require('node:fs'); const p=process.env.TEST_MC_STATE; const s=JSON.parse(fs.readFileSync(p,'utf8'));
const a=process.argv.slice(2);s.calls.push(a); if(a[0]==='anonymous'&&a[1]==='set'){
if(process.env.TEST_DENY_PRIVATE_POLICY==='1'&&a[2]==='none'){fs.writeFileSync(p,JSON.stringify(s));process.exit(1)}
s.policies[a[3]]=a[2]};fs.writeFileSync(p,JSON.stringify(s));\n`);
  await chmod(mc, 0o755);
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, TEST_MC_STATE: state,
    MINIO_ROOT_USER: "test-key", MINIO_ROOT_PASSWORD: "test-secret", MINIO_BUCKET: "public-assets", ROOM_PLUGIN_BUCKET: "private-plugins", MINIO_SCENE_PREFIX: "scenes/" };
  return { env, async state() { return JSON.parse(await readFile(state, "utf8")) as { calls: string[][]; policies: Record<string, string> }; } };
}
test("MinIO bootstrap idempotently disables private anonymity before preserving public downloads and scene seed", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 2; i++) await execute("sh", [bootstrap], { env: f.env });
  const state = await f.state();
  assert.equal(state.policies["vrata/private-plugins"], "none"); assert.equal(state.policies["vrata/public-assets"], "download");
  const privatePolicy = state.calls.findIndex(args => args.join(" ") === "anonymous set none vrata/private-plugins");
  const publicPolicy = state.calls.findIndex(args => args.join(" ") === "anonymous set download vrata/public-assets");
  assert.ok(privatePolicy >= 0 && publicPolicy > privatePolicy);
  assert.equal(state.calls.filter(args => args.join(" ") === "mb --ignore-existing vrata/private-plugins").length, 2);
  assert.equal(state.calls.filter(args => args[0] === "cp" && args.at(-1) === "vrata/public-assets/scenes/compose-smoke/scene.json").length, 2);
});
test("bootstrap refuses public/private collision or missing private namespace before any policy mutation", async t => {
  for (const bucket of ["public-assets", "public-assets/", "", "private/path"]) {
    const f = await fixture(t);
    await assert.rejects(execute("sh", [bootstrap], { env: { ...f.env, ROOM_PLUGIN_BUCKET: bucket } }));
    assert.equal((await f.state()).calls.length, 0);
  }
});
test("failed private-policy provisioning cannot continue to public policy or seed operations", async t => {
  const f = await fixture(t);
  await assert.rejects(execute("sh", [bootstrap], { env: { ...f.env, TEST_DENY_PRIVATE_POLICY: "1" } }));
  const state = await f.state();
  assert.equal(state.calls.some(args => args.join(" ").includes("anonymous set download")), false);
  assert.equal(state.calls.some(args => args[0] === "cp"), false);
});
