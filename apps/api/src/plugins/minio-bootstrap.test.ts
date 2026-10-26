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
// The fake models SeaweedFS: removing an absent policy fails, get-json prints {} without one and fails for a
// missing bucket. TEST_DENY_PRIVATE_POLICY makes every private-policy call fail.
async function fixture(t: TestContext, policies: Record<string, string> = { "vrata/public-assets": "download" }) {
  const root = await mkdtemp(join(tmpdir(), "vrata-private-bootstrap-")); t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "state.json");
  await writeFile(state, JSON.stringify({ calls: [], buckets: Object.keys(policies), policies }));
  const mc = join(root, "mc");
  await writeFile(mc, `#!${process.execPath}\nconst fs=require('node:fs'); const p=process.env.TEST_MC_STATE; const s=JSON.parse(fs.readFileSync(p,'utf8'));
const a=process.argv.slice(2);s.calls.push(a); const save=()=>fs.writeFileSync(p,JSON.stringify(s)); const fail=()=>{save();process.exit(1)};
if(a[0]==='mb'){if(!s.buckets.includes(a.at(-1)))s.buckets.push(a.at(-1))}
if(a[0]==='anonymous'){const bucket=a.at(-1);
if(process.env.TEST_DENY_PRIVATE_POLICY==='1'&&bucket==='vrata/private-plugins')fail();
if(!s.buckets.includes(bucket))fail();
if(a[1]==='get-json')process.stdout.write(s.policies[bucket]?JSON.stringify({Statement:[s.policies[bucket]]})+'\\n':'{}\\n');
if(a[1]==='set'&&a[2]==='none'){if(!s.policies[bucket])fail();delete s.policies[bucket]}
else if(a[1]==='set')s.policies[bucket]=a[2]}
save();\n`);
  await chmod(mc, 0o755);
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, TEST_MC_STATE: state,
    MINIO_ROOT_USER: "test-key", MINIO_ROOT_PASSWORD: "test-secret", MINIO_BUCKET: "public-assets", ROOM_PLUGIN_BUCKET: "private-plugins", MINIO_SCENE_PREFIX: "scenes/" };
  return { env, async state() { return JSON.parse(await readFile(state, "utf8")) as { calls: string[][]; policies: Record<string, string> }; } };
}
const joined = (calls: string[][], command: string) => calls.findIndex(args => args.join(" ") === command);
test("bootstrap idempotently keeps the private bucket policy-free before public downloads and scene seed", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 2; i++) await execute("sh", [bootstrap], { env: f.env });
  const state = await f.state();
  assert.equal(state.policies["vrata/private-plugins"], undefined); assert.equal(state.policies["vrata/public-assets"], "download");
  assert.equal(joined(state.calls, "anonymous set none vrata/private-plugins"), -1, "an absent policy is not removed");
  const privateCheck = joined(state.calls, "anonymous get-json vrata/private-plugins");
  const publicPolicy = joined(state.calls, "anonymous set download vrata/public-assets");
  assert.ok(privateCheck >= 0 && publicPolicy > privateCheck);
  assert.equal(state.calls.filter(args => args.join(" ") === "mb --ignore-existing vrata/private-plugins").length, 2);
  assert.equal(state.calls.filter(args => args[0] === "cp" && args.at(-1) === "vrata/public-assets/scenes/compose-smoke/scene.json").length, 2);
});
test("bootstrap removes an anonymous policy found on the private bucket", async t => {
  const f = await fixture(t, { "vrata/public-assets": "download", "vrata/private-plugins": "download" });
  await execute("sh", [bootstrap], { env: f.env });
  const state = await f.state();
  assert.equal(state.policies["vrata/private-plugins"], undefined);
  assert.ok(joined(state.calls, "anonymous set none vrata/private-plugins") < joined(state.calls, "anonymous set download vrata/public-assets"));
});
test("bootstrap refuses public/private collision or missing private namespace before any policy mutation", async t => {
  for (const bucket of ["public-assets", "public-assets/", "", "private/path"]) {
    const f = await fixture(t);
    await assert.rejects(execute("sh", [bootstrap], { env: { ...f.env, ROOM_PLUGIN_BUCKET: bucket } }));
    assert.equal((await f.state()).calls.length, 0);
  }
});
test("failed private-policy provisioning cannot continue to public policy or seed operations", async t => {
  for (const policies of [undefined, { "vrata/public-assets": "download", "vrata/private-plugins": "download" }]) {
  const f = await fixture(t, policies);
  await assert.rejects(execute("sh", [bootstrap], { env: { ...f.env, TEST_DENY_PRIVATE_POLICY: "1" } }));
  const state = await f.state();
  assert.equal(state.calls.some(args => args.join(" ").includes("anonymous set download")), false);
  assert.equal(state.calls.some(args => args[0] === "cp"), false);
  }
});
