import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { captureSceneSnapshot, restoreSceneSnapshot } from "./staging-scene-snapshot.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const workflow = await readFile(new URL("../.github/workflows/staging-deploy.yml", import.meta.url), "utf8");
const A = "a".repeat(40);
const B = "b".repeat(40);
const roomIds = ["hall", "blue"];
const oldUrls = [`https://assets.example/${A}/scene.json`, "https://assets.example/custom/scene.json?signature=private"];

async function fixture(t, values = oldUrls) {
  const dir = await mkdtemp(join(tmpdir(), "vrata-scene-snapshot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = new Map(roomIds.map((id, i) => [id, values[i]]));
  const events = [];
  const behavior = {};
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method ?? "GET";
    const id = decodeURIComponent(parsed.pathname.split("/").at(-1));
    events.push({ method, path: parsed.pathname, headers: options.headers });
    if (parsed.pathname.startsWith("/api/rooms/")) {
      if (method === "PATCH") {
        if (behavior.patchFailure === id) return new Response("", { status: 503 });
        const value = JSON.parse(options.body).sceneBundleUrl;
        if (behavior.ignorePatch !== id) state.set(id, value);
        behavior.afterPatch?.(id, state);
        return Response.json({ roomId: id, sceneBundleUrl: value });
      }
      if (behavior.readFailure === id) return new Response("", { status: 503 });
      if (behavior.payload) return Response.json(behavior.payload(id));
      return Response.json({ roomId: id, sceneBundleUrl: state.get(id) });
    }
    assert.equal(options.headers?.["x-vrata-admin-token"], undefined, "never send the API token to assets");
    if (behavior.assetFailure) return new Response("", { status: 404 });
    if (parsed.pathname.endsWith("scene.json")) return Response.json({ glbPath: "scene.glb" });
    return new Response(null, { status: 200 });
  };
  const input = {
    baseUrl: "https://api.example/", reportPath: join(dir, "snapshot.json"),
    adminToken: "test-token", rooms: roomIds.map((roomId) => ({ roomId })),
    fetchImpl, preflightAttempts: 1, preflightDelayMs: 0
  };
  return { dir, input, state, events, behavior };
}

function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const end = workflow.indexOf("\n      - name:", start + 1);
  return workflow.slice(start, end < 0 ? undefined : end);
}

function stepScript(name) {
  const lines = step(name).split("\n");
  const index = lines.findIndex((line) => line.startsWith("        run: "));
  assert.notEqual(index, -1);
  if (lines[index] !== "        run: |") return lines[index].slice("        run: ".length);
  const script = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() && !line.startsWith("          ")) break;
    script.push(line.slice(10));
  }
  return script.join("\n");
}

function condition(name, { rollout = "success", gate = "success", rollback = "", failed = false, cancelled = false } = {}) {
  const expression = step(name).match(/        if: \$\{\{ (.+) \}\}/)?.[1];
  assert.ok(expression, `explicit status condition missing: ${name}`);
  // The tested expression uses only boolean status checks and string equality.
  return Function("steps", "failure", "cancelled", `return (${expression});`)(
    { rollout: { outcome: rollout }, gate: { outcome: gate }, rollback: { outcome: rollback } },
    () => failed, () => cancelled
  );
}

test("capture reads every original URL without mutation and writes a private snapshot", async (t) => {
  const f = await fixture(t);
  const snapshot = await captureSceneSnapshot(f.input);
  assert.deepEqual(snapshot, { schemaVersion: 1, baseUrl: "https://api.example", rooms: roomIds.map((roomId, i) => ({ roomId, sceneBundleUrl: oldUrls[i] })) });
  assert.equal(f.events.filter((event) => event.method === "PATCH").length, 0);
  assert.deepEqual(JSON.parse(await readFile(f.input.reportPath, "utf8")), snapshot);
  assert.equal((await stat(f.input.reportPath)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(f.input.reportPath, "utf8"), /test-token/);
});

test("a later capture cannot replace the original snapshot", async (t) => {
  const f = await fixture(t);
  await captureSceneSnapshot(f.input);
  const original = await readFile(f.input.reportPath, "utf8");
  f.state.set("hall", `https://assets.example/${B}/scene.json`);
  await assert.rejects(captureSceneSnapshot(f.input), { code: "EEXIST" });
  assert.equal(await readFile(f.input.reportPath, "utf8"), original);
});

test("partial capture failure writes no report and changes no room", async (t) => {
  const f = await fixture(t);
  f.behavior.readFailure = "blue";
  await assert.rejects(captureSceneSnapshot(f.input), /room_request_failed:GET:blue:503/);
  await assert.rejects(stat(f.input.reportPath), { code: "ENOENT" });
  assert.deepEqual([...f.state.values()], oldUrls);
});

test("wrong room responses cannot become a snapshot", async (t) => {
  const f = await fixture(t);
  f.behavior.payload = () => ({ roomId: "wrong", sceneBundleUrl: null });
  await assert.rejects(captureSceneSnapshot(f.input), /room_id_mismatch/);
});

test("explicit null takes priority over a stale manifest URL", async (t) => {
  const f = await fixture(t);
  f.behavior.payload = (roomId) => ({ roomId, sceneBundleUrl: null, manifest: { sceneBundle: { url: oldUrls[0] } } });
  assert.deepEqual((await captureSceneSnapshot(f.input)).rooms.map((room) => room.sceneBundleUrl), [null, null]);
});

test("missing top-level URL uses the existing manifest representation", async (t) => {
  const f = await fixture(t);
  f.behavior.payload = (roomId) => ({ roomId, manifest: { sceneBundle: { url: oldUrls[0] } } });
  assert.equal((await captureSceneSnapshot(f.input)).rooms[0].sceneBundleUrl, oldUrls[0]);
});

test("restore preserves custom URLs and verifies only after all writes", async (t) => {
  const f = await fixture(t);
  await captureSceneSnapshot(f.input);
  for (const id of roomIds) f.state.set(id, `https://assets.example/${B}/scene.json`);
  f.events.length = 0;
  await restoreSceneSnapshot(f.input);
  assert.deepEqual([...f.state.values()], oldUrls);
  assert.deepEqual(f.events.slice(0, 3).map((event) => event.method), ["PATCH", "PATCH", "GET"]);
  assert.equal(f.events.filter((event) => event.method === "HEAD").length, 2);
  assert.equal(f.events.at(-1).method, "HEAD");
});

test("a partially updated rollout restores both rooms", async (t) => {
  const f = await fixture(t);
  await captureSceneSnapshot(f.input);
  f.state.set("hall", `https://assets.example/${B}/scene.json`);
  await restoreSceneSnapshot(f.input);
  assert.deepEqual([...f.state.values()], oldUrls);
});

test("null URL is restored explicitly without trying to fetch a scene", async (t) => {
  const f = await fixture(t, [null, null]);
  await captureSceneSnapshot(f.input);
  f.state.set("hall", oldUrls[0]);
  f.events.length = 0;
  await restoreSceneSnapshot(f.input);
  assert.deepEqual([...f.state.values()], [null, null]);
  assert.equal(f.events.length, 4);
});

test("successful PATCH response is insufficient when fresh GET still has the new URL", async (t) => {
  const f = await fixture(t);
  await captureSceneSnapshot(f.input);
  f.state.set("hall", `https://assets.example/${B}/scene.json`);
  f.behavior.ignorePatch = "hall";
  await assert.rejects(restoreSceneSnapshot(f.input), /restore_failed:verify:hall/);
});

test("failed restoration of one room still attempts and verifies the next room", async (t) => {
  const f = await fixture(t);
  await captureSceneSnapshot(f.input);
  for (const id of roomIds) f.state.set(id, `https://assets.example/${B}/scene.json`);
  f.behavior.patchFailure = "hall";
  await assert.rejects(restoreSceneSnapshot(f.input), /restore_failed:patch:hall,verify:hall/);
  assert.equal(f.state.get("blue"), oldUrls[1]);
});

test("later writes cannot silently corrupt an earlier restored room", async (t) => {
  const f = await fixture(t);
  await captureSceneSnapshot(f.input);
  f.behavior.afterPatch = (id, state) => { if (id === "blue") state.set("hall", `https://assets.example/${B}/scene.json`); };
  await assert.rejects(restoreSceneSnapshot(f.input), /restore_failed:verify:hall/);
});

test("inaccessible restored assets fail verification without leaking signed URLs", async (t) => {
  const f = await fixture(t);
  await captureSceneSnapshot(f.input);
  f.behavior.assetFailure = true;
  await assert.rejects(restoreSceneSnapshot(f.input), (error) => {
    assert.match(error.message, /restore_failed:verify:hall,verify:blue/);
    assert.doesNotMatch(error.message, /signature|private|test-token/);
    return true;
  });
});

test("readback failure cannot be reported as a successful restore", async (t) => {
  const f = await fixture(t);
  await captureSceneSnapshot(f.input);
  f.behavior.readFailure = "blue";
  await assert.rejects(restoreSceneSnapshot(f.input), /restore_failed:verify:blue/);
});

test("malformed, cross-target and incomplete snapshots are rejected before PATCH", async (t) => {
  const f = await fixture(t);
  const valid = await captureSceneSnapshot(f.input);
  const variants = [
    "{", JSON.stringify({ ...valid, schemaVersion: 2 }),
    JSON.stringify({ ...valid, baseUrl: "https://other.example" }),
    JSON.stringify({ ...valid, rooms: [] }),
    JSON.stringify({ ...valid, rooms: [valid.rooms[0]] }),
    JSON.stringify({ ...valid, rooms: [valid.rooms[0], { roomId: "other", sceneBundleUrl: oldUrls[1] }] }),
    JSON.stringify({ ...valid, rooms: [valid.rooms[0], valid.rooms[0]] }),
    JSON.stringify({ ...valid, rooms: [valid.rooms[0], { roomId: "blue" }] }),
    JSON.stringify({ ...valid, rooms: [valid.rooms[0], { roomId: "blue", sceneBundleUrl: "file:///secret" }] })
  ];
  for (const content of variants) {
    await writeFile(f.input.reportPath, content);
    f.events.length = 0;
    await assert.rejects(restoreSceneSnapshot(f.input));
    assert.equal(f.events.length, 0);
  }
});

test("missing credentials or missing snapshot never initiates a restore", async (t) => {
  const f = await fixture(t);
  await assert.rejects(restoreSceneSnapshot({ ...f.input, adminToken: "" }), /missing_scene_snapshot_admin_token/);
  await assert.rejects(restoreSceneSnapshot(f.input), { code: "ENOENT" });
  assert.equal(f.events.length, 0);
});

test("workflow captures before rollout, preserves helper before checkout, and has one final restore", () => {
  assert.ok(workflow.indexOf("name: Prepare scene rollback helper") < workflow.indexOf("name: Sync workspace to deploy SHA"));
  assert.ok(workflow.indexOf("name: Capture pre-rollout scene URLs") < workflow.indexOf("name: Roll out staging images"));
  assert.doesNotMatch(workflow, /name: Restore scene bundle URLs after failed gate/);
  assert.doesNotMatch(workflow, /--restore-report/);
  assert.equal((workflow.match(/staging-scene-snapshot\.mjs" restore/g) ?? []).length, 1);
  const rollback = stepScript("Roll back failed deploy");
  assert.ok(rollback.indexOf('rollout-staging-images.sh "$ROLLBACK_SHA"') < rollback.indexOf('.mjs" restore'));
  assert.ok(rollback.indexOf('.mjs" restore') < rollback.indexOf('curl --fail --silent'));
  assert.ok(rollback.lastIndexOf('curl --fail --silent') < rollback.indexOf('SUCCESSFUL_SHA_FILE='));
  assert.match(step("Capture pre-rollout scene URLs"), /vrata-scene-bundle-snapshot\.json/);
  assert.match(step("Patch canonical staging scene bundles"), /vrata-scene-bundle-patch-report\.json/);
});

test("rollback runs after failed rollout, gate or post-rollout step but not before rollout or on cancellation", () => {
  for (const input of [
    { rollout: "failure", gate: "skipped" },
    { rollout: "success", gate: "failure" },
    { rollout: "success", gate: "skipped", failed: true },
    { rollout: "success", gate: "success", failed: true }
  ]) assert.equal(condition("Roll back failed deploy", input), true);
  for (const input of [{}, { rollout: "skipped", failed: true }, { rollout: "", failed: true }, { rollout: "failure", cancelled: true }]) {
    assert.equal(condition("Roll back failed deploy", input), false);
  }
  for (const rollback of ["success", "failure"]) assert.equal(condition("Fail after rollback", { rollback }), true);
  assert.equal(condition("Fail after rollback", { rollback: "skipped" }), false);
});

async function workflowFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "vrata-workflow-rollback-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const events = [];
  const state = new Map();
  const behavior = {};
  let baseUrl;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, baseUrl);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    events.push(`${request.method}:${url.pathname}`);
    response.setHeader("content-type", "application/json");
    const send = (payload, status = 200) => { response.statusCode = status; response.end(JSON.stringify(payload)); };
    if (url.pathname === "/__rollout") {
      for (const id of roomIds) state.set(id, `${baseUrl}/bundles/${id}/${body.sha}/scene.json`);
      return send({ ok: true });
    }
    if (url.pathname === "/__persist") return send({ ok: true });
    if (url.pathname.startsWith("/api/rooms/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1));
      if (request.method === "PATCH") {
        if (behavior.failRestore && body.sceneBundleUrl?.includes("custom")) return send({ error: "test" }, 503);
        state.set(id, body.sceneBundleUrl);
      }
      return send({ roomId: id, sceneBundleUrl: state.get(id) });
    }
    if (url.pathname.endsWith("scene.json")) return send({ glbPath: "scene.glb" });
    return send({ ok: true });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const originals = [`${baseUrl}/bundles/hall/${A}/scene.json`, `${baseUrl}/custom/scene.json?signature=private`];
  roomIds.forEach((id, i) => state.set(id, originals[i]));
  const bin = join(dir, "bin");
  const oldWorktree = join(dir, "old-worktree");
  await mkdir(bin);
  await mkdir(join(oldWorktree, "tools"), { recursive: true });
  await copyFile(join(root, "tools/patch-staging-scene-bundles.mjs"), join(oldWorktree, "tools/patch-staging-scene-bundles.mjs"));
  // SSH is the only mocked executable. The workflow Bash, Node CLIs and HTTP are real.
  await writeFile(join(bin, "ssh"), `#!/usr/bin/env node
(async () => {
let text = "";
const command = process.argv.at(-1);
if (command === "sudo bash -s") {
  for await (const chunk of process.stdin) text += chunk;
  const sha = text.match(/rollout-staging-images\\.sh "([a-f0-9]{40})"/)?.[1];
  if (!sha) process.exit(2);
  const response = await fetch(process.env.BASE_URL + "/__rollout", { method: "POST", body: JSON.stringify({ sha }) });
  if (!response.ok) process.exit(3);
} else {
  if (!command.includes(".staging-successful-image-tag")) process.exit(4);
  const response = await fetch(process.env.BASE_URL + "/__persist", { method: "POST" });
  if (!response.ok) process.exit(5);
}
})().catch(() => process.exit(6));
`, { mode: 0o755 });
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: dir,
    BASE_URL: baseUrl, STAGING_BASE_URL: baseUrl, STAGING_ADMIN_TOKEN: "test-only-token",
    STAGING_HALL_ROOM_ID: "hall", STAGING_BLUEOFFICE_ROOM_ID: "blue",
    STAGING_APP_DIR: dir, STAGING_SSH_HOST: "mock", STAGING_SSH_USER: "mock",
    YCR_PASSWORD: "test-only-password", YCR_USERNAME: "mock", PRIVATE_SCENE_ASSETS_HOST_DIR: dir,
    DEPLOY_SHA: B, ROLLBACK_SHA: A, GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
    STAGING_SCENE_BUNDLE_VERSION: B, STAGING_ASSET_BASE_URL: `${baseUrl}/bundles`,
    STAGING_SCENE_BUNDLE_PATCH_REPORT: join(dir, "post-rollout.json")
  };
  const run = (name, cwd = oldWorktree) => exec("bash", ["-e", "-c", stepScript(name)], { cwd, env, timeout: 15000 });
  await run("Prepare scene rollback helper", root);
  await run("Capture pre-rollout scene URLs");
  await run("Roll out staging images");
  await run("Patch canonical staging scene bundles");
  return { dir, run, env, originals, state, events, behavior };
}

test("actual workflow commands restore the pre-rollout URLs after A -> B -> failed gate -> A, including older checkouts", async (t) => {
  const f = await workflowFixture(t);
  const lateReport = JSON.parse(await readFile(f.env.STAGING_SCENE_BUNDLE_PATCH_REPORT, "utf8"));
  assert.ok(lateReport.rooms.every((room) => room.previousSceneBundleUrl.includes(B)));
  const before = await readFile(join(f.dir, "vrata-scene-bundle-snapshot.json"), "utf8");
  f.events.length = 0;
  const result = await f.run("Roll back failed deploy");
  assert.match(result.stdout, /scene_snapshot_restore_verified:2/);
  assert.deepEqual([...f.state.values()], f.originals);
  assert.equal(await readFile(join(f.dir, "vrata-scene-bundle-snapshot.json"), "utf8"), before);
  assert.equal(f.events[0], "POST:/__rollout");
  assert.deepEqual(f.events.slice(-4), ["GET:/health", "GET:/rooms/demo-room", "GET:/control-plane", "POST:/__persist"]);
  assert.ok(f.events.findIndex((event) => event === "GET:/health") > f.events.findLastIndex((event) => event.startsWith("PATCH:")));
  await assert.rejects(f.run("Fail after rollback"), { code: 1 });
});

test("actual rollback stops before success marker and HTTP smoke when URL restoration fails", async (t) => {
  const f = await workflowFixture(t);
  f.behavior.failRestore = true;
  f.events.length = 0;
  await assert.rejects(f.run("Roll back failed deploy"), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /scene_snapshot_restore_failed/);
    assert.doesNotMatch(error.stderr, /signature|private|test-only-token/);
    return true;
  });
  assert.equal(f.events.includes("POST:/__persist"), false);
  assert.equal(f.events.includes("GET:/health"), false);
});

test("CLI rejects missing target and malformed arguments without contacting a default stage", async () => {
  const path = join(root, "tools/staging-scene-snapshot.mjs");
  await assert.rejects(exec(process.execPath, [path, "capture", "unused"], { env: { ...process.env, BASE_URL: "" } }), (error) => {
    assert.match(error.stderr, /missing_scene_snapshot_base_url/);
    return true;
  });
  await assert.rejects(exec(process.execPath, [path, "unknown", "unused"]), (error) => {
    assert.match(error.stderr, /usage:/);
    return true;
  });
});
