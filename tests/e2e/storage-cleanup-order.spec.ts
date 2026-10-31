import { expect, test } from "@playwright/test";
import { access, mkdtemp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { privateHttp, bearer, pluginPath, inviteTokenFromLink } from "./plugin-author-scenarios";
import { startRoomPluginFixture } from "./room-plugin-fixture";

test.use({ trace: "off", screenshot: "off", video: "off" });

test("failed End then a new Host package preserves PDF until the durable plugin sweep succeeds", async () => {
  test.setTimeout(120_000);
  const fixture = await startRoomPluginFixture(2);
  const demo = await import(pathToFileURL(resolve("tools/public-demo.mjs")).href);
  const { createRoomPluginArtifact } = await import(pathToFileURL(resolve("packages/room-plugin-sdk/dist/artifact.js")).href);
  const { roomPluginPrefix } = await import(pathToFileURL(resolve("apps/api/dist/plugins/storage.js")).href);
  const directory = await mkdtemp(join(tmpdir(), "vrata-t15-end-race-"));
  const stateFile = join(directory, "state.json");
  const core = { stateFile, adminToken: fixture.adminToken, baseUrl: fixture.origin, getRetries: 0 };
  const admin = { "x-vrata-admin-token": fixture.adminToken };
  let pluginFile: string | undefined;
  try {
    await demo.seedPublicDemo(core);
    const state = await demo.readPublicDemoState(stateFile);
    const roomPath = `/api/rooms/${state.roomId}`;
    const failedEnd = async (url: string, options: RequestInit) => new URL(url).pathname === `${roomPath}/session-control/end`
      ? Response.json({ error: "room_state_unavailable" }, { status: 503 }) : fetch(url, options);
    await expect(demo.cleanupPublicDemo({ ...core, fetcher: failedEnd })).rejects.toMatchObject({ step: "cleanup-end-session" });
    expect((await demo.readPublicDemoState(stateFile)).cleanup.pluginsCleaned).toBe(true);
    const invitation = await privateHttp(fixture.origin, `${roomPath}/invites`, "POST", admin, { role: "host", expiresInSeconds: 600 });
    expect(invitation.status).toBe(201);
    const host = await privateHttp(fixture.origin, "/api/tokens/state", "POST", {}, {
      identityProtocolVersion: 2, roomId: state.roomId, displayName: "Late cleanup Host",
      inviteToken: inviteTokenFromLink(invitation.json<any>().inviteLink)
    });
    expect(host.status).toBe(200);
    const artifact = createRoomPluginArtifact({ schemaVersion: 1, sdkApiVersion: 1, id: "cleanup.race", version: "1.0.0",
      displayName: "Cleanup race", requestedCapabilities: [], configSchema: {} }, "export function init(){}").bytes;
    const published = await privateHttp(fixture.origin, pluginPath(state.roomId, "packages"), "POST", bearer(host.json<any>().token), artifact);
    expect(published.status).toBe(201);
    const pkg = published.json<any>().package;
    pluginFile = join(fixture.pluginStorageRoot, roomPluginPrefix({ tenantId: state.tenantId, roomId: state.roomId }), pkg.packageId, `${pkg.artifactSha256}.vrata-plugin.json`);
    const pdfFile = join(fixture.documentStorageRoot, "documents", state.tenantId, state.roomId, state.resources.document.documentId, state.expected.document.filename);
    const before = await readFile(pdfFile);
    await rename(pluginFile, `${pluginFile}.held`); await mkdir(pluginFile);
    const retry = { ...core, stateFile: demo.publicDemoCleanupRecordPath(stateFile) };
    await expect(demo.cleanupPublicDemo(retry)).rejects.toMatchObject({ step: "cleanup-delete-room", status: 503 });
    expect((await readFile(pdfFile)).equals(before)).toBe(true);
    expect((await privateHttp(fixture.origin, roomPath, "GET", admin)).status).toBe(200);
    const fenced = await privateHttp(fixture.origin, pluginPath(state.roomId, "packages"), "POST", admin, artifact);
    // Ended rooms reject authors before exposing plugin state, including to admin.
    expect(fenced.status).toBe(403); expect(fenced.json<any>().error).toBe("plugin_author_forbidden");
    const { Pool } = createRequire(resolve("apps/api/package.json"))("pg");
    const pool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL, options: `-c search_path=${fixture.schema},public` });
    try {
      const intent = await pool.query("select deleting, deletion_id from room_plugin_state where tenant_id=$1 and room_id=$2", [state.tenantId, state.roomId]);
      expect(intent.rows).toHaveLength(1); expect(intent.rows[0].deleting).toBe(true); expect(intent.rows[0].deletion_id).toBeTruthy();
    } finally { await pool.end(); }
    await fixture.restartApi();
    await rm(pluginFile, { recursive: true }); await rename(`${pluginFile}.held`, pluginFile);
    await expect(demo.cleanupPublicDemo(retry)).resolves.toMatchObject({ cleaned: true });
    await expect(access(pdfFile)).rejects.toThrow(); await expect(access(pluginFile)).rejects.toThrow();
    expect((await privateHttp(fixture.origin, roomPath, "GET", admin)).status).toBe(404);
    expect(await readdir(directory)).toEqual(["state.json.cleanup.json"]);
  } finally {
    if (pluginFile && await access(`${pluginFile}.held`).then(() => true, () => false)) {
      await rm(pluginFile, { recursive: true, force: true }); await rename(`${pluginFile}.held`, pluginFile);
    }
    // The fixture owns its disposable schema and roots; close also cleans a failed
    // scenario without masking its original assertion with another CLI failure.
    await fixture.close(); await rm(directory, { recursive: true, force: true });
  }
});
