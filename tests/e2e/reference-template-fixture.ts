import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { createServer as netServer } from "node:net";
import { createRequire } from "node:module";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const requireApi = createRequire(resolve("apps/api/package.json"));
const { Pool } = requireApi("pg");

async function freePort(): Promise<number> {
  const server = netServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

export async function startReferenceTemplateFixture(postgresUrl: string) {
  const { loadReferenceTemplateFixtures } = await import(pathToFileURL(resolve("tools/fetch-reference-template-fixtures.mjs")).href);
  const schema = `template_e2e_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: postgresUrl });
  const pool = new Pool({ connectionString: postgresUrl, options: `-c search_path=${schema},public` });
  const { PostgresStorage } = await import(pathToFileURL(resolve("apps/api/dist/storage.js")).href);
  const files = await loadReferenceTemplateFixtures();
  const assetServer = httpServer((request, response) => {
    const item = files.get(request.url ?? "");
    response.writeHead(item ? 200 : 404, { "content-type": item?.type ?? "text/plain", "access-control-allow-origin": "*" });
    response.end(item?.bytes ?? "missing");
  });
  await new Promise<void>(resolve => assetServer.listen(0, "127.0.0.1", resolve));
  const assetsOrigin = `http://127.0.0.1:${(assetServer.address() as { port: number }).port}`;
  const apiPort = await freePort(), statePort = await freePort();
  const origin = `http://127.0.0.1:${apiPort}`;
  const stateOrigin = `http://127.0.0.1:${statePort}`;
  const connection = new URL(postgresUrl); connection.searchParams.set("options", `-c search_path=${schema},public`);
  const children: ChildProcess[] = [];
  let storage: InstanceType<typeof PostgresStorage>;
  let log = "";
  const env = {
    ...process.env, NODE_ENV: "development", VRATA_DISABLE_AUTOSTART: "0", POSTGRES_URL: connection.href,
    API_PORT: String(apiPort), ROOM_STATE_PORT: String(statePort), CONTROL_PLANE_ADMIN_TOKEN: "test-admin-token",
    ROOM_STATE_INTERNAL_URL: stateOrigin, ROOM_STATE_PUBLIC_URL: `ws://127.0.0.1:${statePort}`, API_INTERNAL_URL: origin,
    VRATA_INTERNAL_SERVICE_TOKEN: "test-internal-token", ROOM_TEMPLATE_ASSET_BASE_URL: assetsOrigin,
    FEATURE_AVATAR_POSE_BINARY: "true",
    DOCUMENT_LOCAL_UPLOAD_ROOT: resolve("test-results/reference-documents", schema)
  };
  const start = (path: string) => {
    const child = spawn(process.execPath, [path], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", bytes => { log = (log+String(bytes)).slice(-16000); });
    children.push(child); return child;
  };
  try {
    await admin.query(`create schema "${schema}"`);
    storage = new PostgresStorage(pool); await storage.init();
    await storage.transitionReferenceTemplateCatalog("active");
    start("apps/room-state/dist/index.js"); start("apps/api/dist/index.js");
    const ready = async (url: string) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (children.some(child => child.exitCode !== null)) throw new Error(`reference_fixture_exited:${log}`);
        if (await fetch(url).then(response => response.ok, () => false)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`reference_fixture_not_ready:${log}`);
    };
    await ready(`${origin}/health`); await ready(`${stateOrigin}/health`);
  } catch (error) {
    await Promise.all(children.map(stop)); await pool.end();
    await admin.query(`drop schema if exists "${schema}" cascade`); await admin.end();
    await new Promise<void>(resolve => assetServer.close(() => resolve())); throw error;
  }
  return {
    origin, assetsOrigin,
    async close() {
      try {
        await storage.transitionReferenceTemplateCatalog("wave2");
        const response = await fetch(`${origin}/api/templates`); const catalog = await response.json();
        assert.equal(catalog.items.length, 4);
      } finally {
        await Promise.all(children.map(stop));
        await pool.end(); await admin.query(`drop schema "${schema}" cascade`); await admin.end();
        await new Promise<void>(resolve => assetServer.close(() => resolve()));
        await rm(env.DOCUMENT_LOCAL_UPLOAD_ROOT, { recursive: true, force: true });
      }
    },
    corruptAsset(path: string) {
      const file = files.get(path); assert(file);
      const original = file.bytes;
      file.bytes = Buffer.from(original); file.bytes[file.bytes.length-1] ^= 1;
      return () => { file.bytes = original; };
    },
    fixtureFingerprint: createHash("sha256").update([...files.keys()].sort().join("\n")).digest("hex")
  };
}
