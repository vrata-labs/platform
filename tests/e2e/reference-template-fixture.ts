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

type ReferenceTemplateFixtureOptions = {
  devRoleQuery?: boolean;
  stateTokenSecret?: string;
  livekitUrl?: string;
  documentUploadMaxBytes?: number;
  /** Raised after seeding, as on an activated deployment. VRATA_E2E_IDENTITY_FLOOR=2 reruns unpinned
   * scenarios on floor 2 before a shared activation; callers that depend on a floor pass it explicitly. */
  identityProtocol?: 1 | 2;
  /** More API and room-state environment, built from the API origin (for example a portal-managed deployment). */
  extraEnv?: (origin: string) => Record<string, string>;
};

export async function startReferenceTemplateFixture(postgresUrl: string, options: ReferenceTemplateFixtureOptions = {}) {
  const { loadReferenceTemplateFixtures } = await import(pathToFileURL(resolve("tools/fetch-reference-template-fixtures.mjs")).href);
  const schema = `template_e2e_${randomUUID().replaceAll("-", "")}`;
  const adminToken = "test-admin-token";
  const documentStorageRoot = resolve("test-results/reference-documents", schema);
  const pluginStorageRoot = resolve("test-results/reference-plugins", schema);
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
  const floor = options.identityProtocol ?? (process.env.VRATA_E2E_IDENTITY_FLOOR === "2" ? 2 : 1);
  // v2 credentials need a signing secret of at least 32 bytes; the 16-byte development default fails closed.
  const stateTokenSecret = options.stateTokenSecret ?? (floor === 2 ? `reference-fixture-state-secret-${schema}` : undefined);
  let storage: InstanceType<typeof PostgresStorage>;
  let apiChild: ChildProcess | undefined;
  let roomStateChild: ChildProcess | undefined;
  let apiOperation = Promise.resolve();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let log = "";
  const identityBoundaryDenials: Array<Record<string, unknown>> = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env, NODE_ENV: "development", VRATA_DISABLE_AUTOSTART: "0", POSTGRES_URL: connection.href,
    API_PORT: String(apiPort), ROOM_STATE_PORT: String(statePort), CONTROL_PLANE_ADMIN_TOKEN: adminToken,
    ROOM_STATE_INTERNAL_URL: stateOrigin, ROOM_STATE_PUBLIC_URL: `ws://127.0.0.1:${statePort}`, API_INTERNAL_URL: origin,
    VRATA_INTERNAL_SERVICE_TOKEN: "test-internal-token", ROOM_TEMPLATE_ASSET_BASE_URL: assetsOrigin,
    FEATURE_AVATAR_POSE_BINARY: "true", VRATA_DEV_ROLE_QUERY: String(options.devRoleQuery ?? true),
    ...(stateTokenSecret ? { STATE_TOKEN_SECRET: stateTokenSecret } : {}),
    LIVEKIT_URL: options.livekitUrl ?? "ws://127.0.0.1:7880", LIVEKIT_API_KEY: "devkey", LIVEKIT_API_SECRET: "secret",
    ...(options.livekitUrl ? { LIVEKIT_ROOM_PREFIX: "vrata-", MEDIA_TOKEN_TTL_SECONDS: "120" } : {}),
    DOCUMENT_LOCAL_UPLOAD_ROOT: documentStorageRoot, MINIO_DOCUMENT_PREFIX: "documents",
    ROOM_PLUGIN_LOCAL_UPLOAD_ROOT: pluginStorageRoot,
    ...(options.documentUploadMaxBytes !== undefined ? { DOCUMENT_UPLOAD_MAX_BYTES: String(options.documentUploadMaxBytes) } : {}),
    ...options.extraEnv?.(origin)
  };
  for (const key of [
    "DOCUMENT_PROVIDER", "SCENE_BUNDLE_PROVIDER", "ROOM_PLUGIN_BUCKET",
    "MINIO_ENDPOINT", "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD", "MINIO_BUCKET", "MINIO_PUBLIC_BASE_URL",
    "SCENE_BUNDLE_S3_ENDPOINT", "SCENE_BUNDLE_S3_REGION", "SCENE_BUNDLE_S3_BUCKET",
    "SCENE_BUNDLE_S3_PUBLIC_BASE_URL", "SCENE_BUNDLE_S3_ACCESS_KEY_ID", "SCENE_BUNDLE_S3_SECRET_ACCESS_KEY",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"
  ]) delete env[key];
  const start = (path: string) => {
    const child = spawn(process.execPath, [path], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      stream?.on("data", bytes => {
        const text = String(bytes);
        log = (log+text).slice(-16000); pending += text;
        const lines = pending.split("\n"); pending = lines.pop()!.slice(-16000);
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (event.event === "identity_boundary_denied") {
              identityBoundaryDenials.push({ at: Date.now(), code: event.code, reason: event.reason, errorKind: event.errorKind,
                queuedMessages: event.queuedMessages, queuedBytes: event.queuedBytes });
              if (identityBoundaryDenials.length > 128) identityBoundaryDenials.shift();
            }
          } catch { /* Only structured boundary events enter diagnostics. */ }
        }
      });
    }
    return child;
  };
  const ready = async (url: string, child: ChildProcess) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`reference_fixture_exited:${log}`);
      if (await fetch(url).then(response => response.ok, () => false)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`reference_fixture_not_ready:${log}`);
  };
  const restartApi = () => {
    const operation = apiOperation.then(async () => {
      if (closing) throw new Error("reference_fixture_closing");
      const previous = apiChild;
      apiChild = undefined;
      if (previous) await stop(previous);
      if (closing) throw new Error("reference_fixture_closing");
      const next = start("apps/api/dist/index.js");
      apiChild = next;
      try {
        await ready(`${origin}/health`, next);
      } catch (error) {
        if (apiChild === next) apiChild = undefined;
        await stop(next);
        throw error;
      }
    });
    apiOperation = operation.catch(() => undefined);
    return operation;
  };
  try {
    await admin.query(`create schema "${schema}"`);
    storage = new PostgresStorage(pool); await storage.init();
    roomStateChild = start("apps/room-state/dist/index.js");
    apiChild = start("apps/api/dist/index.js");
    await ready(`${origin}/health`, apiChild); await ready(`${stateOrigin}/health`, roomStateChild);
    const { seedStagingTemplateFixtures } = await import(pathToFileURL(resolve("tools/seed-staging-template-fixtures.mjs")).href);
    await seedStagingTemplateFixtures(origin, adminToken);
    await storage.transitionReferenceTemplateCatalog("active");
    if (floor === 2) {
      assert.match(schema, /^template_e2e_[0-9a-f]{32}$/);
      await storage.identityProtocol.raise(2);
    }
  } catch (error) {
    closing = true;
    await Promise.all([apiChild, roomStateChild].filter((child): child is ChildProcess => Boolean(child)).map(stop)); await pool.end();
    await admin.query(`drop schema if exists "${schema}" cascade`); await admin.end();
    await new Promise<void>(resolve => assetServer.close(() => resolve())); throw error;
  }
  return {
    origin, stateOrigin, assetsOrigin, schema, adminToken, documentStorageRoot, pluginStorageRoot, restartApi,
    identityBoundaryDenials: () => structuredClone(identityBoundaryDenials),
    async close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        await apiOperation;
        try {
          await storage.transitionReferenceTemplateCatalog("wave2");
          const response = await fetch(`${origin}/api/templates`); const catalog = await response.json();
          assert.equal(catalog.items.length, 4);
        } finally {
          await Promise.all([apiChild, roomStateChild].filter((child): child is ChildProcess => Boolean(child)).map(stop));
          await pool.end(); await admin.query(`drop schema "${schema}" cascade`); await admin.end();
          await new Promise<void>(resolve => assetServer.close(() => resolve()));
          await rm(documentStorageRoot, { recursive: true, force: true });
          await rm(pluginStorageRoot, { recursive: true, force: true });
        }
      })();
      return closePromise;
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
