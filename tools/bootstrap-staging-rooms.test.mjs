import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { bootstrapStagingRooms, loadStagingCatalog } from "./bootstrap-staging-rooms.mjs";
import { seedStagingTemplateFixtures } from "./seed-staging-template-fixtures.mjs";

const sha = "a".repeat(40);
const catalog = { schemaVersion: 1, tenantId: "demo-tenant", templateId: "meeting-room-basic", templateVersion: "0.1.0",
  rooms: [{ name: "Hall", roomId: "hall-room", sceneId: "sense-hall2-v1", versioned: true }] };

function fixture(options = {}) {
  const rooms = new Map();
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    requests.push({ path, method });
    if (path.includes("/assets/scenes/")) {
      if (options.missingAsset) return new Response("", { status: 404 });
      return path.endsWith("scene.json") ? Response.json({ sceneId: "sense-hall2-v1", glbPath: "scene.glb" }) : new Response("glb");
    }
    assert.equal(init.headers["x-vrata-admin-token"], "test-admin");
    if (path === "/api/control-plane/session") return options.unauthorized ? new Response("", { status: 401 }) : Response.json({ permissions: ["room.create"] });
    if (path === "/api/templates") return Response.json({ items: [{ templateId: catalog.templateId, currentVersion: options.version ?? "0.1.0" }] });
    if (path === "/api/rooms" && method === "POST") {
      const row = JSON.parse(init.body);
      rooms.set(row.roomId, row);
      return options.conflict ? new Response("", { status: 409 }) : Response.json(row, { status: 201 });
    }
    const row = rooms.get(path.split("/").at(-1));
    return row ? Response.json(row) : new Response("", { status: 404 });
  };
  return { rooms, requests, input: { catalog, baseUrl: "https://app.example.test", assetBaseUrl: "https://state.example.test",
    adminToken: "test-admin", version: sha, fetchImpl } };
}

test("bootstrap creates canonical rooms once and preserves later user edits", async () => {
  const f = fixture();
  const first = await bootstrapStagingRooms(f.input);
  assert.deepEqual(first.rooms, [{ roomId: "hall-room", created: true }]);
  const row = f.rooms.get("hall-room");
  row.name = "Renamed Hall";
  row.features.voice = false;
  row.sceneBundleUrl = "https://accepted.example.test/old/scene.json";
  f.rooms.set("personal-room", { name: "User room" });
  const second = await bootstrapStagingRooms(f.input);
  assert.deepEqual(second.rooms, [{ roomId: "hall-room", created: false }]);
  assert.equal(f.requests.filter(row => row.method === "POST").length, 1);
  assert.equal(f.rooms.get("hall-room").name, "Renamed Hall");
  assert.equal(f.rooms.get("hall-room").features.voice, false);
  assert.equal(f.rooms.get("hall-room").sceneBundleUrl, "https://accepted.example.test/old/scene.json");
  assert.ok(f.rooms.has("personal-room"));
});

test("fresh API accepts all canonical rooms and Wave 2 QA fixtures idempotently", { timeout: 30000 }, async t => {
  const assetServer = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(request.url.endsWith("scene.json") ? JSON.stringify({ glbPath: "scene.glb" }) : "glb");
  });
  assetServer.listen(0, "127.0.0.1"); await once(assetServer, "listening");
  t.after(() => new Promise(resolve => assetServer.close(resolve)));
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const baseUrl = `http://127.0.0.1:${port}`;
  let postgresUrl = "";
  let database;
  const schema = `staging_seed_${randomUUID().replaceAll("-", "")}`;
  if (process.env.VRATA_TEST_POSTGRES_URL) {
    const { Pool } = createRequire(new URL("../apps/api/package.json", import.meta.url))("pg");
    database = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL });
    await database.query(`create schema "${schema}"`);
    const isolated = new URL(process.env.VRATA_TEST_POSTGRES_URL);
    isolated.searchParams.set("options", `-c search_path=${schema},public`);
    postgresUrl = isolated.toString();
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL("../apps/api/dist/index.js", import.meta.url))], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, API_PORT: String(port), POSTGRES_URL: postgresUrl, VRATA_DISABLE_AUTOSTART: "0",
      CONTROL_PLANE_ADMIN_TOKEN: "fixture-admin-token", REMOTE_BROWSER_ENABLED: "false",
      API_PUBLIC_URL: baseUrl, RUNTIME_BASE_URL: baseUrl, NODE_ENV: "development", NOAH_DISABLE_AUTOSTART: "0" }
  });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  t.after(async () => { if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); } });
  t.after(async () => { if (database) { try { await database.query(`drop schema "${schema}" cascade`); } finally { await database.end(); } } });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) assert.fail(output);
    try { ready = (await fetch(`${baseUrl}/health`)).ok; } catch { /* Startup polling. */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, output);
  const input = { baseUrl, assetBaseUrl: `http://127.0.0.1:${assetServer.address().port}`,
    adminToken: "fixture-admin-token", version: sha };
  const first = await bootstrapStagingRooms(input);
  assert.equal(first.rooms.length, 13);
  assert(first.rooms.every(room => room.created));
  assert((await bootstrapStagingRooms(input)).rooms.every(room => !room.created));
  const fixtures = JSON.parse(await readFile(new URL("../tests/e2e/staging-legacy-fixtures.json", import.meta.url), "utf8"));
  assert.equal((await seedStagingTemplateFixtures(baseUrl, input.adminToken)).rooms.length, 2 * Object.keys(fixtures).length);
  assert.equal((await seedStagingTemplateFixtures(baseUrl, input.adminToken)).rooms.length, 2 * Object.keys(fixtures).length);
  const hall = (await loadStagingCatalog()).rooms.find(room => room.name === "Hall");
  const response = await fetch(`${baseUrl}/api/rooms/${hall.roomId}`);
  const room = await response.json();
  assert.equal(room.templateVersion, "0.1.0");
  assert.equal(room.features.voice, true);
  const manifest = await (await fetch(`${baseUrl}/api/rooms/${hall.roomId}/manifest`)).json();
  assert.equal(manifest.sceneBundle.url, `${input.assetBaseUrl}/assets/scenes/${hall.sceneId}/${sha}/scene.json`);
  for (const expected of (await loadStagingCatalog()).rooms) {
    const stored = await (await fetch(`${baseUrl}/api/rooms/${expected.roomId}`)).json();
    assert.equal(stored.sceneBundleUrl, expected.versioned
      ? `${input.assetBaseUrl}/assets/scenes/${expected.sceneId}/${sha}/scene.json`
      : `/assets/scenes/${expected.sceneId}/scene.json`);
    assert.equal(stored.avatarConfig.avatarsEnabled, true);
    assert.equal(stored.avatarConfig.avatarSeatsEnabled, true);
  }
});

test("a concurrent creator is validated after conflict rather than overwritten", async () => {
  const f = fixture({ conflict: true });
  assert.equal((await bootstrapStagingRooms(f.input)).rooms[0].created, false);
  f.rooms.get("hall-room").tenantId = "another-tenant";
  await assert.rejects(bootstrapStagingRooms(f.input), /identity_mismatch/);
});

test("authorization, unavailable template and missing assets fail before room mutation", async () => {
  for (const [options, error] of [[{ unauthorized: true }, /unauthorized/], [{ version: "2.0.0" }, /template_unavailable/], [{ missingAsset: true }, /preflight_manifest_failed/]]) {
    const f = fixture(options);
    await assert.rejects(bootstrapStagingRooms(f.input), error);
    assert.equal(f.requests.some(row => row.method === "POST"), false);
  }
});

test("catalog covers the restored thirteen scene rooms with stable unique IDs", async () => {
  const source = await loadStagingCatalog();
  assert.equal(source.rooms.length, 13);
  assert.equal(new Set(source.rooms.map(room => room.roomId)).size, 13);
  assert.equal(source.rooms.find(room => room.name === "Hall").roomId, "42db8225-f671-4e46-9c28-9381d66a948c");
  assert.equal(source.rooms.find(room => room.name === "ArtGallery").sceneId, "sense-artgallery-glb-v2");
});
