import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";
import { createRoomPluginArtifact } from "@vrata/room-plugin-sdk/artifact";
import { PostgresStorage } from "../storage.js";
import { assertLocalPluginRollbackObject, pluginRollbackModuleSetting, PLUGIN_ROLLBACK_SHA } from "./rollback-fixture.test-helper.js";

// The actual committed API preceding T04, not a hand-written SQL approximation of a rollback.
const rollbackSha = PLUGIN_ROLLBACK_SHA;
const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
const execute = promisify(execFile);
let legacyBuild: Promise<string> | undefined;
let ownedLegacyRoot: string | undefined;
after(async () => { if (ownedLegacyRoot) await rm(ownedLegacyRoot, { recursive: true, force: true }); });

function buildLegacyApi(): Promise<string> { return legacyBuild ??= prepareLegacyApi(); }
async function prepareLegacyApi(): Promise<string> {
  const provided = pluginRollbackModuleSetting(process.env);
  if (provided) {
    const module = resolve(provided);
    assert.equal(basename(module), "storage.js", "rollback env must point to the compiled API storage module");
    const root = resolve(dirname(module), "../../..");
    assert.equal((await execute("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(), rollbackSha, "rollback checkout must be the exact pre-T04 revision");
    assert.equal((await execute("git", ["diff", "--name-status", "HEAD"], { cwd: root })).stdout, "", "rollback checkout's tracked source must match the pinned revision");
    for (const file of [module, join(root, "apps/api/dist/index.js"), join(root, "apps/runtime-web/dist/index.html")]) {
      assert.ok((await stat(file)).isFile(), "build the pinned API, SDK dependencies and runtime before verification");
    }
    return root;
  }
  // No silent CI fallback: pluginRollbackModuleSetting rejects a missing CI fixture above.
  await assertLocalPluginRollbackObject(workspace);
  ownedLegacyRoot = await mkdtemp(join(tmpdir(), "vrata-plugin-rollback-"));
  const legacyRoot = ownedLegacyRoot;
  const { stdout } = await execute("git", ["archive", rollbackSha, "apps/api/src", "apps/api/package.json", "apps/api/tsconfig.json", "tsconfig.base.json"],
    { cwd: workspace, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
  const archive = join(legacyRoot, "baseline.tar");
  await writeFile(archive, stdout);
  await execute("tar", ["-xf", archive, "-C", legacyRoot]);
  await symlink(resolve(workspace, "node_modules"), join(legacyRoot, "node_modules"), "dir");
  await symlink(resolve(workspace, "apps/api/node_modules"), join(legacyRoot, "apps/api/node_modules"), "dir");
  await symlink(resolve(workspace, "apps/runtime-web"), join(legacyRoot, "apps/runtime-web"), "dir");
  await execute(process.execPath, [resolve(workspace, "node_modules/typescript/lib/tsc.js"), "-p", join(legacyRoot, "apps/api/tsconfig.json")],
    { cwd: legacyRoot, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  return legacyRoot;
}

test("exact pre-T04 API rollback fixture is built and pinned independently", { timeout: 90_000 }, async () => {
  assert.ok(await buildLegacyApi());
});

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  if (!(await Promise.race([exited.then(() => true), delay(5000).then(() => false)])) && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL"); await exited;
  }
}

test("exact pre-T04 API serves and mutates ordinary legacy rooms on new plugin schema without losing plugin state", {
  skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 120_000
}, async t => {
  assert.ok(process.env.VRATA_TEST_POSTGRES_URL);
  const baseline = await buildLegacyApi();
  const schema = `plugin_rollback_${randomUUID().replaceAll("-", "")}`;
  const root = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL });
  await root.query(`create schema "${schema}"`);
  const connection = new URL(process.env.VRATA_TEST_POSTGRES_URL);
  connection.searchParams.set("options", `-c search_path=${schema},public`);
  const pool = new Pool({ connectionString: connection.href });
  let runningChild: ChildProcess | undefined;
  t.after(async () => { if (runningChild) await stop(runningChild); await pool.end(); await root.query(`drop schema "${schema}" cascade`); await root.end(); });
  const current = new PostgresStorage(pool);
  await current.init();
  const room = await current.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Plugin state survives rollback" });
  const scope = { tenantId: room.tenantId, roomId: room.roomId };
  const bytes = createRoomPluginArtifact({ schemaVersion: 1, sdkApiVersion: 1, id: "rollback-status", version: "1.0.0",
    displayName: "Rollback status", requestedCapabilities: ["status.set"], configSchema: {} }, "export function init() {}").bytes;
  const reserved = (await current.roomPlugins.reservePackage(scope, bytes, "b".repeat(64))).package;
  await current.roomPlugins.confirmPackageUpload(scope, reserved.packageId);
  await current.roomPlugins.publishPackage(scope, reserved.packageId);
  const expected = await current.roomPlugins.putBinding(scope, reserved.pluginId, { packageId: reserved.packageId,
    artifactSha256: reserved.artifactSha256, version: reserved.version, enabled: true, config: {}, approvedCapabilities: ["status.set"] }, 0);
  const portServer = createServer(); portServer.listen(0, "127.0.0.1"); await once(portServer, "listening");
  const port = (portServer.address() as { port: number }).port;
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  let logs = "";
  const child = spawn(process.execPath, [join(baseline, "apps/api/dist/index.js")], { cwd: baseline,
    env: { ...process.env, NODE_ENV: "development", POSTGRES_URL: connection.href, API_PORT: String(port),
      CONTROL_PLANE_ADMIN_TOKEN: "plugin-rollback-admin", FEATURE_REMOTE_BROWSER: "false", VRATA_DISABLE_AUTOSTART: "0", NOAH_DISABLE_AUTOSTART: "0" },
    stdio: ["ignore", "pipe", "pipe"] });
  runningChild = child;
  child.stdout?.on("data", value => { logs = (logs + String(value)).slice(-12000); });
  child.stderr?.on("data", value => { logs = (logs + String(value)).slice(-12000); });
  const base = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) assert.fail(`rollback API exited ${child.exitCode}: ${logs}`);
    try { if ((await fetch(`${base}/health`)).ok) { healthy = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(healthy, logs);
  assert.equal((await fetch(`${base}/rooms/demo-room`)).status, 200);
  assert.equal((await fetch(`${base}/api/rooms/demo-room/manifest`)).status, 200);
  const headers = { "content-type": "application/json", "x-vrata-admin-token": "plugin-rollback-admin" };
  const created = await fetch(`${base}/api/rooms`, { method: "POST", headers,
    body: JSON.stringify({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Ordinary rollback room" }) });
  assert.equal(created.status, 201);
  const ordinary = await created.json() as { roomId: string };
  const patched = await fetch(`${base}/api/rooms/${ordinary.roomId}`, { method: "PATCH", headers, body: JSON.stringify({ name: "Edited by old API" }) });
  assert.equal(patched.status, 200);
  const deleted = await fetch(`${base}/api/rooms/${ordinary.roomId}`, { method: "DELETE", headers });
  assert.equal(deleted.status, 200);
  await stop(child);
  const restarted = new PostgresStorage(pool); await restarted.init();
  assert.deepEqual(await restarted.roomPlugins.readBindings(scope), expected);
  assert.equal((await restarted.roomPlugins.getPackage(scope, reserved.packageId))?.artifactSha256, reserved.artifactSha256);
});
