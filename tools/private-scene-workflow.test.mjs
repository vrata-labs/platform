import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const workflow = await readFile(join(root, ".github/workflows/staging-deploy.yml"), "utf8");
const catalog = JSON.parse(await readFile(join(root, "infra/docker/staging-scene-catalog.json"), "utf8"));

function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `missing workflow step ${name}`);
  const end = workflow.indexOf("\n      - ", start + 1);
  return workflow.slice(start, end < 0 ? undefined : end);
}

function script(name) {
  const lines = step(name).split("\n");
  const index = lines.findIndex(line => line.startsWith("        run: "));
  assert.notEqual(index, -1);
  if (lines[index] !== "        run: |") return lines[index].slice(13);
  return lines.slice(index + 1).map(line => line.slice(10)).join("\n");
}

// The real host protocol, with only external Docker/database boundaries replaced.
// Git is the platform fixture repository; no Git scene checkout exists at rollout.
const hostFixture = `
import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location("remote",sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class FixtureHost(m.ReleaseHost):
    def __init__(self,root):
        super().__init__(root)
        self.catalog.prepare=lambda image:None
        self.catalog.guard_accepted=lambda image:None
        self.catalog.schema_state=lambda:{"schema":"empty"}
        self.catalog.verify_wave2=lambda image,proof:None
        self.catalog.record_wave2=lambda image,proof:None
    def raw_rollout(self,image):
        (self.state.directory/"running-image").write_text(image)
    def running_images(self,image):
        assert (self.state.directory/"running-image").read_text()==image
    def foundation_digests(self):
        return {n:"registry.invalid/"+n+"@sha256:"+"d"*64 for n in m.accepted.FOUNDATIONS}
m.ReleaseHost=FixtureHost
sys.argv=sys.argv[1:]
m.main()
`;

const sshFixture = `#!/usr/bin/env python3
import json,os,shlex,subprocess,sys
from pathlib import Path
assert not any(os.environ.get(k) for k in ("AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_SESSION_TOKEN"))
command=sys.argv[-1]
with open(os.environ["SSH_EVENTS"],"a") as log:log.write(json.dumps({"command":command})+"\\n")
if "docker login" in command:
    sys.stdin.read()
    sys.exit(0)
parts=shlex.split(command)
protocol=next((i for i,p in enumerate(parts) if p.endswith("/staging-remote-release.py")),None)
if protocol is not None:
    result=subprocess.run([sys.executable,"-B",os.environ["FIXTURE_HOST"],*parts[protocol:]])
else:
    result=subprocess.run(["bash","-e","-o","pipefail","-c",command.replace("sudo ","")])
sys.exit(result.returncode)
`;

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "private-scene-workflow-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AWS_")));
  const git = async (cwd, ...args) => (await exec("git", ["-C", cwd, ...args], { env })).stdout.trim();
  const commit = async (cwd, message) => {
    await git(cwd, "add", ".");
    await git(cwd, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  const source = join(dir, "scene-source");
  await mkdir(source);
  await git(source, "init", "-q");
  const assets = join(source, "assets");
  for (const { sceneId } of catalog.rooms) {
    const scene = join(assets, "scenes", sceneId);
    await mkdir(scene, { recursive: true });
    await writeFile(join(scene, "scene.json"), JSON.stringify({ sceneId, glbPath: "scene.glb" }));
    await writeFile(join(scene, "scene.glb"), `A fixture ${sceneId}`);
  }
  await writeFile(join(assets, "manifest.json"), JSON.stringify({
    schemaVersion: 1, scenesRoot: "scenes", scenes: catalog.rooms.map(({ sceneId }) => ({ sceneId, sceneDir: sceneId }))
  }));
  const packageRelease = async (name) => {
    const assetSha = await commit(source, name);
    const output = join(dir, name);
    await exec("python3", ["-B", join(root, "tools/private-scene-release.py"), "pack", "--source", source,
      "--asset-sha", assetSha, "--output", output], { env });
    const descriptor = JSON.parse(await readFile(join(output, "release.json"), "utf8"));
    const { createHash } = await import("node:crypto");
    const bytes = await readFile(join(output, "release.json"));
    const lock = { schemaVersion: 1, assetSha,
      descriptor: { key: `private-scenes/releases/${assetSha}/release.json`, bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") },
      archive: descriptor.archive, inventory: descriptor.inventory };
    for (const [key, file] of [[lock.descriptor.key, "release.json"], [lock.archive.key, "bundle.tar.gz"]]) {
      const target = join(dir, "s3/objects", key);
      await mkdir(join(target, ".."), { recursive: true });
      await copyFile(join(output, file), target);
    }
    return lock;
  };
  const assetA = await packageRelease("package-a");
  await writeFile(join(assets, "scenes", catalog.rooms[0].sceneId, "scene.glb"), "B candidate bytes");
  const assetB = await packageRelease("package-b");
  await rm(source, { recursive: true }); // Neither .git nor a scene source remains.

  const bin = join(dir, "bin");
  await mkdir(bin);
  await exec("python3", ["-B", "-c", `
import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location("fixtures",sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
Path(sys.argv[2]).write_text(m.FAKE_AWS)
Path(sys.argv[2]).chmod(0o700)
`, join(root, "tools/private-scene-release.test.py"), join(bin, "aws")], { env });
  await writeFile(join(bin, "ssh"), sshFixture, { mode: 0o700 });
  await writeFile(join(dir, "host-fixture.py"), hostFixture);

  const origin = join(dir, "platform-origin");
  await mkdir(join(origin, "infra/docker"), { recursive: true });
  await git(origin, "init", "-q");
  await writeFile(join(origin, "infra/docker/compose.staging.yml"), "# VRATA_STAGING_SCENE_ROOT\nservices: {}\n");
  await writeFile(join(origin, "infra/docker/staging-scene-catalog.json"), JSON.stringify(catalog));
  await writeFile(join(origin, ".gitignore"), "infra/docker/.env.staging\n");
  await mkdir(join(origin, "tools"));
  await copyFile(join(root, "tools/patch-staging-scene-bundles.mjs"), join(origin, "tools/patch-staging-scene-bundles.mjs"));
  const old = await commit(origin, "old target without release helper or lock");
  const lockPath = join(origin, "infra/docker/private-scene-release.lock.json");
  await writeFile(lockPath, JSON.stringify(assetA));
  const a = await commit(origin, "candidate A");
  await writeFile(lockPath, JSON.stringify(assetB));
  // A target's helper must not replace the protocol retained from the workflow.
  await writeFile(join(origin, "tools/private-scene-release.py"), "raise AssertionError('wrong protocol')\n");
  const b = await commit(origin, "candidate B");
  const runner = join(dir, "runner");
  const host = join(dir, "host");
  for (const destination of [runner, host]) await exec("git", ["clone", "-q", origin, destination], { env });
  const stateDir = `${host}-stage-state`;
  await writeFile(join(host, "infra/docker/.env.staging"), "LIVEKIT_NODE_IP=203.0.113.10\nVRATA_STAGING_PUBLIC_IP=203.0.113.10\n");
  const accepted = (...args) => exec("python3", ["-B", join(root, "tools/staging-accepted-release.py"),
    ...args, "--root", host], { env });
  await accepted("designate", "--public-ip", "203.0.113.10");

  const rooms = new Map();
  const httpEvents = [];
  let baseUrl;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, baseUrl).pathname;
    httpEvents.push(`${request.method}:${path}`);
    response.setHeader("content-type", "application/json");
    const send = (value, status = 200) => { response.statusCode = status; response.end(JSON.stringify(value)); };
    if (path.startsWith("/api/rooms/")) {
      if (request.headers["x-vrata-admin-token"] !== "fixture-admin") return send({}, 403);
      const id = path.split("/").at(-1);
      if (request.method === "PATCH") {
        let body = "";
        for await (const chunk of request) body += chunk;
        rooms.set(id, JSON.parse(body).sceneBundleUrl);
      }
      return send({ roomId: id, sceneBundleUrl: rooms.get(id) });
    }
    if (path.endsWith("scene.json")) return send({ glbPath: "scene.glb" });
    return send({ ok: true });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  for (const { roomId, sceneId } of catalog.rooms) rooms.set(roomId, `${baseUrl}/assets/scenes/${sceneId}/${a}/scene.json`);
  Object.assign(env, {
    PATH: `${bin}:${env.PATH}`, RUNNER_TEMP: dir, GITHUB_ENV: join(dir, "github-env"),
    GITHUB_OUTPUT: join(dir, "github-output"), GITHUB_SHA: "e".repeat(40), GITHUB_RUN_ID: "101", GITHUB_RUN_ATTEMPT: "1",
    STAGING_APP_DIR: host, STAGING_SSH_HOST: "fixture", STAGING_SSH_USER: "fixture",
    BASE_URL: baseUrl, STAGING_ADMIN_TOKEN: "fixture-admin", STAGING_ASSET_BASE_URL: baseUrl,
    YCR_USERNAME: "fixture", YCR_PASSWORD: "fixture-password", BOOTSTRAP: "true",
    FIXTURE_HOST: join(dir, "host-fixture.py"), SSH_EVENTS: join(dir, "ssh-events.jsonl"),
    VRATA_SCENES_S3_ENDPOINT: "https://s3.example.invalid", VRATA_SCENES_S3_REGION: "region-1",
    VRATA_SCENES_S3_BUCKET: "private-bucket", FAKE_S3: join(dir, "s3"),
    BOUND_ASSET_SHA: "", FORCE_FAIL: "false", STAGING_SCENE_BUNDLE_PATCH_REPORT: join(dir, "patch.json")
  });
  const run = async (name, { cwd = runner, reader = false } = {}) => {
    const result = await exec("bash", ["-e", "-o", "pipefail", "-c", script(name)
      .replaceAll("${{ steps.previous.outputs.previous_sha }}", env.PREVIOUS_SHA ?? "")],
    { cwd, env: reader ? { ...env, AWS_ACCESS_KEY_ID: "fixture-reader", AWS_SECRET_ACCESS_KEY: "fixture-secret" } : env, timeout: 20000 });
    try {
      for (const line of (await readFile(env.GITHUB_ENV, "utf8")).trim().split("\n")) {
        const index = line.indexOf("=");
        if (index > 0) env[line.slice(0, index)] = line.slice(index + 1);
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    return result;
  };
  await run("Prepare scene rollback helper", { cwd: root });
  // A designated host has these helpers already, independently of candidate checkout.
  await exec("cp", ["-a", join(dir, "vrata-scene-rollback"), join(stateDir, "bootstrap-tools")], { env });
  const select = async (image, runId) => {
    env.SHA = image; env.GITHUB_RUN_ID = runId; env.STAGING_SCENE_BUNDLE_VERSION = image;
    await writeFile(env.GITHUB_OUTPUT, "");
    await run("Prepare host protocol and read accepted state");
    const output = Object.fromEntries((await readFile(env.GITHUB_OUTPUT, "utf8")).trim().split("\n").map(line => line.split("=")));
    env.BOUND_ASSET_SHA = output.asset_sha ?? ""; env.PREVIOUS_SHA = output.previous_sha ?? "";
    await run("Sync workspace to deploy SHA");
  };
  const fetch = () => run("Fetch pinned private scene release", { reader: true });
  const readState = async () => ({
    accepted: await readFile(join(stateDir, "accepted-release.json"), "utf8"),
    active: await readlink(join(stateDir, "active")),
    running: await readFile(join(stateDir, "running-image"), "utf8"),
    urls: [...rooms.entries()]
  });
  const bootstrap = async () => {
    await select(a, "101"); await fetch(); await run("Upload candidate source without replacing accepted files");
    await run("Roll out staging images"); await run("Verification gate");
    await run("Publish accepted release and finalize catalog");
    env.BOOTSTRAP = "false";
    await writeFile(join(host, "infra/docker/.template-wave2-rollback-sha"), a);
  };
  return { dir, runner, host, stateDir, env, a, b, old, assetA, assetB, run, select, fetch, bootstrap, readState,
    rooms, httpEvents, accepted, git };
}

test("workflow isolates reader credentials, pins CLI, retains helper/catalog and leaves public/catalog delivery independent", async () => {
  assert.doesNotMatch(workflow, /PRIVATE_SCENE_ASSETS_|GitVerse|git -C private-scene/);
  const fetchStep = step("Fetch pinned private scene release");
  const withoutFetch = workflow.replace(fetchStep, "");
  assert.doesNotMatch(withoutFetch, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|PRIVATE_SCENES_S3_READER/);
  assert.match(fetchStep, /secrets\.PRIVATE_SCENES_S3_READER_ACCESS_KEY_ID/);
  assert.match(fetchStep, /secrets\.PRIVATE_SCENES_S3_READER_SECRET_ACCESS_KEY/);
  assert.match(step("Install pinned scene S3 client"), /awscli==1\.46\.0/);
  assert.doesNotMatch(workflow, /aws configure|--profile/);
  const prepare = script("Prepare scene rollback helper");
  assert.match(prepare, /cp tools\/private-scene-release\.py infra\/docker\/staging-scene-catalog\.json/);
  assert(workflow.indexOf("Prepare scene rollback helper") < workflow.indexOf("Sync workspace to deploy SHA"));
  assert(workflow.indexOf("Fetch pinned private scene release") < workflow.indexOf("Upload candidate source"));
  assert.match(script("Upload candidate source without replacing accepted files"), /RUNNER_TEMP\/private-scene-source\/assets/);
  assert.match(script("Roll out staging images"), /--source '\$REMOTE_SOURCE'/);
  assert.doesNotMatch(await readFile(join(root, ".github/workflows/template-catalog.yml"), "utf8"),
    /PRIVATE_SCENE_ASSETS_|PRIVATE_SCENES_S3_|GitVerse/);
  assert.match(await readFile(join(root, "tools/scene-repositories.mjs"), "utf8"), /scene-repositories\.lock\.json/);
  const lock = JSON.parse(await readFile(join(root, "infra/docker/private-scene-release.lock.json"), "utf8"));
  assert.equal(lock.assetSha, "ed0c972cf05f512c35861ef76cff8f87080f3133");
  assert.equal(lock.archive.sha256, "bd24b8141d94720cd280b29a1f02b21fef5a3ecd4b8ca22768c244a57a674526");
});

test("isolated S3 client pins current CA roots without disabling certificate verification", () => {
  const install = script("Install pinned scene S3 client");
  assert.match(install, /awscli==1\.46\.0 certifi==2026\.10\.23/);
  assert.doesNotMatch(workflow, /--no-verify-ssl|PYTHONHTTPSVERIFY|CURL_CA_BUNDLE|AWS_CA_BUNDLE/);
});

test("actual bootstrap/new lock, repeat binding and old target without helper/lock use saved fetch protocol", async t => {
  const f = await fixture(t);
  await f.bootstrap();
  const before = await f.readState();
  assert.equal(JSON.parse(before.accepted).assetSha, f.assetA.assetSha);
  assert.equal(before.active, `snapshots/${f.a}-${f.assetA.assetSha}`);
  assert.equal((await stat(join(f.dir, "private-scene-source"))).mode & 0o777, 0o700);
  assert.equal(await f.git(f.runner, "rev-parse", "HEAD"), f.a);
  await assert.rejects(stat(join(f.env.REMOTE_HELPERS, "private-scene-release.py")), { code: "ENOENT" });
  await assert.rejects(stat(join(f.env.REMOTE_HELPERS, "staging-scene-catalog.json")), { code: "ENOENT" });
  await f.select(f.a, "102");
  // Even a different lock must not change the immutable image binding.
  await writeFile(join(f.runner, "infra/docker/private-scene-release.lock.json"), JSON.stringify(f.assetB));
  await f.fetch();
  assert.equal(f.env.ASSET_SHA, f.assetA.assetSha);
  await f.run("Upload candidate source without replacing accepted files");
  await f.run("Roll out staging images");
  assert.deepEqual(await f.readState(), before);
  await writeFile(join(f.runner, "infra/docker/private-scene-release.lock.json"), JSON.stringify(f.assetA));

  await f.accepted("bind-assets", "--image-sha", f.old, "--asset-sha", f.assetA.assetSha);
  await f.select(f.old, "103");
  for (const path of ["tools/private-scene-release.py", "infra/docker/private-scene-release.lock.json", "private-scene-assets/.git"]) {
    await assert.rejects(stat(join(f.runner, path)), { code: "ENOENT" });
  }
  await writeFile(join(f.runner, "infra/docker/staging-scene-catalog.json"), "{}");
  await f.fetch();
  assert.equal(f.env.ASSET_SHA, f.assetA.assetSha);
  const events = (await readFile(join(f.dir, "s3/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert(events.every(event => event.operation === "head-object" || event.operation === "get-object"));
  assert(events.every(event => event.key.includes(f.assetA.assetSha)));
  assert.deepEqual(await f.readState(), before, "fetch alone must not change host acceptance, runtime, active or URLs");
});

test("S3 refusal or absent historical descriptor fails before upload/rollout without newer-lock fallback", async t => {
  const f = await fixture(t);
  await f.bootstrap();
  const before = await f.readState();
  await rm(join(f.dir, "private-scene-source"), { recursive: true });
  await f.select(f.b, "201");
  f.env.FAKE_MODE = "denied";
  const eventsBefore = await readFile(f.env.SSH_EVENTS, "utf8");
  await assert.rejects(f.fetch(), error => {
    assert.doesNotMatch(error.stderr, /fixture-secret|fixture-reader/);
    return error.code === 1;
  });
  assert.equal(await readFile(f.env.SSH_EVENTS, "utf8"), eventsBefore, "no SSH/source upload after failed fetch");
  await assert.rejects(stat(join(f.dir, "private-scene-source")), { code: "ENOENT" });
  assert.deepEqual(await f.readState(), before);

  delete f.env.FAKE_MODE;
  await f.accepted("bind-assets", "--image-sha", f.b, "--asset-sha", "f".repeat(40));
  await f.select(f.b, "202"); // B has a valid, available new lock, but a historical binding wins.
  await assert.rejects(f.fetch(), { code: 1 });
  const events = (await readFile(join(f.dir, "s3/events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.at(-1).key, `private-scenes/releases/${"f".repeat(40)}/release.json`);
  assert(!events.some(event => event.key === f.assetB.archive.key));
  assert.deepEqual(await f.readState(), before);
});

test("new candidate without binding requires a strict lock before any source is published", async t => {
  const f = await fixture(t);
  await f.select(f.old, "301");
  await assert.rejects(f.fetch(), { code: 1 });
  await assert.rejects(stat(join(f.dir, "private-scene-source")), { code: "ENOENT" });
  await f.select(f.a, "302");
  const lock = { ...f.assetA, descriptor: { ...f.assetA.descriptor, sha256: "0".repeat(64) } };
  await writeFile(join(f.runner, "infra/docker/private-scene-release.lock.json"), JSON.stringify(lock));
  await assert.rejects(f.fetch(), { code: 1 });
  await assert.rejects(stat(join(f.dir, "private-scene-source")), { code: "ENOENT" });
  await assert.rejects(stat(join(f.stateDir, "active")), { code: "ENOENT" });
  await assert.rejects(stat(join(f.stateDir, "accepted-release.json")), { code: "ENOENT" });
});

test("actual S3 source/SSH/host snapshot pipeline restores A bytes and URLs after B fails its gate", async t => {
  const f = await fixture(t);
  await f.bootstrap();
  const before = await f.readState();
  await rm(join(f.dir, "private-scene-source"), { recursive: true });
  await f.select(f.b, "401");
  await f.fetch();
  assert.equal(f.env.ASSET_SHA, f.assetB.assetSha);
  await f.run("Upload candidate source without replacing accepted files");
  await f.run("Capture pre-rollout scene URLs");
  const pointers = await readFile(join(f.dir, "vrata-scene-bundle-snapshot.json"), "utf8");
  assert.equal(await readFile(join(f.stateDir, "attempts/401-1/scene-urls.json"), "utf8"), pointers);
  await f.run("Roll out staging images");
  await f.run("Patch canonical staging scene bundles");
  const glb = join(f.stateDir, "active/public/assets/scenes", catalog.rooms[0].sceneId, "scene.glb");
  assert.equal(await readFile(glb, "utf8"), "B candidate bytes");
  const candidate = await f.readState();
  assert.equal(candidate.accepted, before.accepted);
  assert.equal(candidate.running, f.b);
  assert.notDeepEqual(candidate.urls, before.urls);
  f.env.FORCE_FAIL = "true";
  await assert.rejects(f.run("Verification gate"), { code: 1 });
  await f.run("Roll back failed deploy");
  assert.deepEqual(await f.readState(), before);
  assert.match(await readFile(glb, "utf8"), /^A fixture/);
  const binding = JSON.parse((await f.accepted("asset-binding", "--image-sha", f.b)).stdout);
  assert.equal(binding.binding.assetSha, f.assetB.assetSha, "failed gate must retain candidate binding");
  await assert.rejects(f.run("Fail after rollback"), { code: 1 });
  assert(f.httpEvents.filter(event => event.startsWith("PATCH:")).length >= 4);
});
