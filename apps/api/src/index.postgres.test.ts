import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

const postgresUrl = process.env.VRATA_TEST_POSTGRES_URL;
const postgresSkipReason = "VRATA_TEST_POSTGRES_URL is not set; skipping PostgreSQL API integration test";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForApi(baseUrl: string, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`postgres_api_exited:${child.exitCode}\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Startup includes schema migration, so connection failures are expected briefly.
    }
    await delay(250);
  }
  throw new Error(`postgres_api_start_timeout\n${output()}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    delay(5_000).then(() => false)
  ]);
  if (!stopped && child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

test("API serves server-owned template metadata through PostgreSQL storage", {
  skip: postgresUrl ? false : postgresSkipReason,
  timeout: 120_000
}, async () => {
  assert.ok(postgresUrl);
  const schema = `vrata_template_api_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: postgresUrl });
  const connectionUrl = new URL(postgresUrl);
  connectionUrl.searchParams.set("options", `-c search_path=${schema},public`);
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let logs = "";
  let child: ChildProcess | null = null;

  try {
    await adminPool.query(`create schema "${schema}"`);
    child = spawn(process.execPath, [fileURLToPath(new URL("./index.js", import.meta.url))], {
      env: {
        ...process.env,
        NODE_ENV: "development",
        API_PORT: String(port),
        POSTGRES_URL: connectionUrl.toString(),
        CONTROL_PLANE_ADMIN_TOKEN: "postgres-api-test-admin",
        FEATURE_REMOTE_BROWSER: "false",
        VRATA_DISABLE_AUTOSTART: "0",
        NOAH_DISABLE_AUTOSTART: "0"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
    await waitForApi(baseUrl, child, () => logs);

    const templatesResponse = await fetch(`${baseUrl}/api/templates`);
    assert.equal(templatesResponse.status, 200);
    const templates = await templatesResponse.json() as {
      items: Array<{ templateId: string; currentVersion: string; status: string }>;
    };
    assert.equal(templates.items.length, 4);
    assert.deepEqual(templates.items.map(({ templateId, currentVersion, status }) => ({ templateId, currentVersion, status })), [
      { templateId: "meeting-room-basic", currentVersion: "0.1.0", status: "active" },
      { templateId: "showroom-basic", currentVersion: "0.1.0", status: "active" },
      { templateId: "event-demo-basic", currentVersion: "0.1.0", status: "active" },
      { templateId: "personal-workspace-basic", currentVersion: "0.1.0", status: "active" }
    ]);

    const createResponse = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "postgres-api-test-admin"
      },
      body: JSON.stringify({
        roomId: "postgres-template-room",
        tenantId: "demo-tenant",
        templateId: "meeting-room-basic",
        templateVersion: "9.9.9",
        templateSnapshot: { templateId: "spoofed", version: "9.9.9" },
        name: "PostgreSQL Template Room",
        visibility: "unlisted"
      })
    });
    assert.equal(createResponse.status, 201, logs);
    const created = await createResponse.json() as {
      templateId: string;
      templateVersion: string;
      templateSnapshot: { templateId: string; version: string; roomConfig: { visibility: string } };
      manifest: { templateVersion: string; templateSnapshot: { version: string } };
    };
    assert.equal(created.templateId, "meeting-room-basic");
    assert.equal(created.templateVersion, "0.1.0");
    assert.equal(created.templateSnapshot.templateId, "meeting-room-basic");
    assert.equal(created.templateSnapshot.version, "0.1.0");
    assert.equal(created.templateSnapshot.roomConfig.visibility, "unlisted");
    assert.equal(created.manifest.templateVersion, "0.1.0");
    assert.equal(created.manifest.templateSnapshot.version, "0.1.0");
    const persisted = await adminPool.query(
      `select template_id, template_version, template_snapshot->>'templateId' as snapshot_template_id
       from "${schema}".rooms
       where room_id = 'postgres-template-room'`
    );
    assert.deepEqual(persisted.rows[0], {
      template_id: "meeting-room-basic",
      template_version: "0.1.0",
      snapshot_template_id: "meeting-room-basic"
    });

    await adminPool.query(
      `update "${schema}".templates set status = 'deprecated' where template_id = 'meeting-room-basic'`
    );
    const activeTemplatesResponse = await fetch(`${baseUrl}/api/templates`);
    assert.equal(activeTemplatesResponse.status, 200);
    const activeTemplates = await activeTemplatesResponse.json() as { items: Array<{ templateId: string }> };
    assert.equal(activeTemplates.items.some(({ templateId }) => templateId === "meeting-room-basic"), false);

    const deprecatedCreateResponse = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "postgres-api-test-admin"
      },
      body: JSON.stringify({
        roomId: "postgres-deprecated-template-room",
        tenantId: "demo-tenant",
        templateId: "meeting-room-basic",
        name: "Rejected Deprecated Template Room"
      })
    });
    assert.equal(deprecatedCreateResponse.status, 400);
    assert.deepEqual(await deprecatedCreateResponse.json(), { error: "invalid_template" });

    const existingDeprecatedUpdateResponse = await fetch(`${baseUrl}/api/rooms/postgres-template-room`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "postgres-api-test-admin"
      },
      body: JSON.stringify({ name: "Existing Deprecated Room Updated", templateId: "meeting-room-basic" })
    });
    assert.equal(existingDeprecatedUpdateResponse.status, 200, logs);
    const existingDeprecatedUpdated = await existingDeprecatedUpdateResponse.json() as { name: string; templateId: string; templateVersion: string };
    assert.equal(existingDeprecatedUpdated.name, "Existing Deprecated Room Updated");
    assert.equal(existingDeprecatedUpdated.templateId, "meeting-room-basic");
    assert.equal(existingDeprecatedUpdated.templateVersion, "0.1.0");

    const rebindResponse = await fetch(`${baseUrl}/api/rooms/postgres-template-room`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "postgres-api-test-admin"
      },
      body: JSON.stringify({ templateId: "event-demo-basic" })
    });
    assert.equal(rebindResponse.status, 409);
    assert.deepEqual(await rebindResponse.json(), { error: "room_template_binding_changed" });
    const bindingAfterRejectedRebind = await adminPool.query(
      `select template_id, template_version from "${schema}".rooms where room_id = 'postgres-template-room'`
    );
    assert.deepEqual(bindingAfterRejectedRebind.rows[0], {
      template_id: "meeting-room-basic",
      template_version: "0.1.0"
    });

    await adminPool.query(
      `update "${schema}".templates set status = 'deprecated' where template_id = 'personal-workspace-basic'`
    );
    const unavailablePersonalTemplateResponse = await fetch(`${baseUrl}/api/personal-room`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participantId: "postgres-personal-template-unavailable" })
    });
    assert.equal(unavailablePersonalTemplateResponse.status, 503);
    assert.deepEqual(await unavailablePersonalTemplateResponse.json(), { error: "personal_room_template_unavailable" });
    const unavailablePersonalRoomCount = await adminPool.query(
      `select count(*)::integer as count from "${schema}".rooms where owner_participant_id = 'postgres-personal-template-unavailable'`
    );
    assert.equal(unavailablePersonalRoomCount.rows[0]?.count, 0);
  } finally {
    if (child) await stopChild(child);
    await adminPool.query(`drop schema if exists "${schema}" cascade`);
    await adminPool.end();
  }
});
