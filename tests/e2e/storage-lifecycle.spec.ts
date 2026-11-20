import { expect, test } from "@playwright/test";
import { access, mkdtemp, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createExternalAuthorProject, privateHttp, bearer, pluginPath, inviteTokenFromLink } from "./plugin-author-scenarios";
import { startRoomPluginFixture, createOwnedPluginRoom, enterPluginRoom, expectPluginStatus, installPluginArtifact, bindPluginArtifact } from "./room-plugin-fixture";

test.use({ trace: "off", screenshot: "off", video: "off" });

test("demo lifecycle retains exact plugin versions, notes, PDF and access after restart; CLI cleanup preserves neighbours and SDK", async ({ browser }) => {
  test.setTimeout(240_000);
  const demo = await import(pathToFileURL(resolve("tools/public-demo.mjs")).href);
  const fixture = await startRoomPluginFixture(2);
  const directory = await mkdtemp(join(tmpdir(), "vrata-t15-demo-"));
  const stateFile = join(directory, "state.json");
  const core = { stateFile, adminToken: fixture.adminToken, baseUrl: fixture.origin };
  let actor: Awaited<ReturnType<typeof enterPluginRoom>> | undefined;
  let author: Awaited<ReturnType<typeof createExternalAuthorProject>> | undefined;
  let other: string | undefined;
  try {
    await demo.seedPublicDemo(core);
    const state = await demo.readPublicDemoState(stateFile);
    const sdkManifest = await (await fetch(`${fixture.origin}/assets/plugin-sdk/releases.json`)).json();
    const sdkUrl = sdkManifest.releases.find((release: any) => release.version === "0.1.0").url;
    const sdk = Buffer.from(await (await fetch(new URL(sdkUrl, fixture.origin))).arrayBuffer());
    author = await createExternalAuthorProject(sdk);
    const first = await author.build("external.lifecycle", "1.0.0");
    const second = await author.build("external.lifecycle", "1.1.0");
    actor = await enterPluginRoom(browser, fixture, state.roomId);
    const p1 = await installPluginArtifact(fixture, actor, first);
    const p2 = await installPluginArtifact(fixture, actor, second);
    await bindPluginArtifact(fixture, actor, p2, 0, "Lifecycle survives restart");
    await expectPluginStatus(actor.page, "initial", "Lifecycle survives restart");
    other = await createOwnedPluginRoom(fixture);
    const preserved = await privateHttp(fixture.origin, pluginPath(other, "packages"), "POST", { "x-vrata-admin-token": fixture.adminToken }, first.bytes);
    expect(preserved.status).toBe(201);
    const before = await privateHttp(fixture.origin, pluginPath(state.roomId, "packages"), "GET", bearer(actor.session.token));
    expect(before.status).toBe(200);
    await fixture.restartApi();
    await expect(demo.checkPublicDemo(core)).resolves.toMatchObject({ prepared: true });
    const after = await privateHttp(fixture.origin, pluginPath(state.roomId, "packages"), "GET", bearer(actor.session.token));
    expect(after.status).toBe(200);
    expect(after.json()).toEqual(before.json());
    for (const pkg of [p1, p2]) expect(pkg.version).toMatch(/^1\./);
    const content = await privateHttp(fixture.origin, pluginPath(state.roomId, `packages/${p2.packageId}/content`), "GET", bearer(actor.session.token));
    expect(content.status).toBe(200); expect(content.bytes.equals(second.bytes)).toBe(true);
    const guestInvite = state.resources.invites.find((invite: any) => invite.role === "guest");
    const guest = await privateHttp(fixture.origin, "/api/tokens/state", "POST", {}, {
      identityProtocolVersion: 2, roomId: state.roomId, displayName: "Lifecycle guest", inviteToken: inviteTokenFromLink(guestInvite.inviteLink)
    });
    expect(guest.status).toBe(200);
    expect((await privateHttp(fixture.origin, pluginPath(state.roomId, "packages"), "GET", bearer(guest.json<any>().token))).status).toBe(403);
    await actor.context.close(); actor = undefined;
    await demo.cleanupPublicDemo(core);
    await expect(access(stateFile)).rejects.toThrow();
    const record = await readFile(demo.publicDemoCleanupRecordPath(stateFile), "utf8");
    expect(record.includes("inviteLink") || record.includes("Lifecycle survives restart") || record.includes("identityCredential")).toBe(false);
    expect((await privateHttp(fixture.origin, pluginPath(other, "packages"), "GET", { "x-vrata-admin-token": fixture.adminToken })).json<any>().packages).toHaveLength(1);
    const sdkAfter = await fetch(new URL(sdkUrl, fixture.origin));
    expect(sdkAfter.status).toBe(200); expect(Buffer.from(await sdkAfter.arrayBuffer()).equals(sdk)).toBe(true);
    await expect(demo.cleanupPublicDemo({ ...core, stateFile: demo.publicDemoCleanupRecordPath(stateFile) })).resolves.toMatchObject({ cleaned: true });
    // A prior CLI version or an explicit End can leave a retry record without pluginsCleaned.
    // Never reactivate the room merely to regain author access for cleanup.
    const endedFile = join(directory, "ended.json");
    await demo.seedPublicDemo({ ...core, stateFile: endedFile });
    const ended = await demo.readPublicDemoState(endedFile);
    const endedPackage = await privateHttp(fixture.origin, pluginPath(ended.roomId, "packages"), "POST", { "x-vrata-admin-token": fixture.adminToken }, first.bytes);
    expect(endedPackage.status).toBe(201);
    expect((await privateHttp(fixture.origin, `/api/rooms/${ended.roomId}/session-control/end`, "POST", { "x-vrata-admin-token": fixture.adminToken })).status).toBe(200);
    await expect(demo.cleanupPublicDemo({ ...core, stateFile: endedFile })).resolves.toMatchObject({ cleaned: true });
  } finally {
    await actor?.context.close();
    const cleanup = await access(stateFile).then(() => stateFile, () => demo.publicDemoCleanupRecordPath(stateFile));
    if (await access(cleanup).then(() => true, () => false)) await demo.cleanupPublicDemo({ ...core, stateFile: cleanup });
    if (other) await privateHttp(fixture.origin, `/api/rooms/${other}`, "DELETE", { "x-vrata-admin-token": fixture.adminToken });
    await author?.close(); await fixture.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("CLI resumes a failed direct room DELETE after API restart and leaves only a redacted record", async () => {
  test.setTimeout(120_000);
  const fixture = await startRoomPluginFixture(2);
  const demo = await import(pathToFileURL(resolve("tools/public-demo.mjs")).href);
  const directory = await mkdtemp(join(tmpdir(), "vrata-t15-delete-retry-"));
  const stateFile = join(directory, "state.json");
  const core = { stateFile, adminToken: fixture.adminToken, baseUrl: fixture.origin };
  const admin = { "x-vrata-admin-token": fixture.adminToken };
  let author: Awaited<ReturnType<typeof createExternalAuthorProject>> | undefined;
  let other: string | undefined;
  let path: string | undefined;
  try {
    await demo.seedPublicDemo(core);
    const state = await demo.readPublicDemoState(stateFile);
    const room = state.roomId;
    const sdkManifest = await (await fetch(`${fixture.origin}/assets/plugin-sdk/releases.json`)).json();
    const sdkUrl = sdkManifest.releases.find((release: any) => release.version === "0.1.0").url;
    const sdk = Buffer.from(await (await fetch(new URL(sdkUrl, fixture.origin))).arrayBuffer());
    author = await createExternalAuthorProject(sdk);
    const artifact = await author.build("external.cleanupretry", "1.0.0");
    const installed = await privateHttp(fixture.origin, pluginPath(room, "packages"), "POST", admin, artifact.bytes);
    expect(installed.status).toBe(201);
    other = await createOwnedPluginRoom(fixture);
    const neighbour = await privateHttp(fixture.origin, pluginPath(other, "packages"), "POST", admin, artifact.bytes);
    expect(neighbour.status).toBe(201);
    const neighbourPackage = neighbour.json<any>().package;
    const invitation = await privateHttp(fixture.origin, `/api/rooms/${other}/invites`, "POST", admin, { role: "host", expiresInSeconds: 600 });
    expect(invitation.status).toBe(201);
    const admitted = await privateHttp(fixture.origin, "/api/tokens/state", "POST", {}, {
      identityProtocolVersion: 2, roomId: other, displayName: "Cleanup neighbour", inviteToken: inviteTokenFromLink(invitation.json<any>().inviteLink)
    });
    expect(admitted.status).toBe(200);
    const neighbourActor = { roomId: other, session: admitted.json<any>() };
    await bindPluginArtifact(fixture, neighbourActor, neighbourPackage, 0, "Preserved neighbour");
    const neighbourBefore = await privateHttp(fixture.origin, pluginPath(other, "packages"), "GET", admin);
    expect(neighbourBefore.status).toBe(200);
    path = join(fixture.documentStorageRoot, "documents", state.tenantId, room, state.resources.document.documentId, state.expected.document.filename);
    await rename(path, `${path}.held`); await mkdir(path);
    const failed = await privateHttp(fixture.origin, `/api/rooms/${room}`, "DELETE", admin);
    expect(failed.status).toBe(503); expect(failed.json()).toEqual({ error: "room_document_cleanup_unavailable" });
    const retained = await privateHttp(fixture.origin, `/api/rooms/${room}`, "GET", admin);
    expect(retained.status).toBe(200);
    expect(retained.json<any>().status).toBe("active");
    await fixture.restartApi();
    const pending = await privateHttp(fixture.origin, pluginPath(room, "packages"), "GET", admin);
    expect(pending.status).toBe(503); expect(pending.json()).toEqual({ error: "room_plugin_cleanup_pending" });
    await rm(path, { recursive: true }); await rename(`${path}.held`, path);
    const cleaned = await demo.cleanupPublicDemo(core);
    expect(cleaned.cleaned).toBe(true);
    await expect(access(path)).rejects.toThrow();
    await expect(access(stateFile)).rejects.toThrow();
    expect((await privateHttp(fixture.origin, `/api/rooms/${room}`, "GET", admin)).status).toBe(404);
    expect((await privateHttp(fixture.origin, `/api/rooms/${room}`, "DELETE", admin)).status).toBe(404);
    const tenants = await privateHttp(fixture.origin, "/api/tenants", "GET", admin);
    expect(tenants.status).toBe(200);
    expect(tenants.json<any>().items.some((tenant: any) => tenant.tenantId === state.tenantId)).toBe(false);
    const recordPath = demo.publicDemoCleanupRecordPath(stateFile);
    expect(await readdir(directory)).toEqual(["state.json.cleanup.json"]);
    const record = await readFile(recordPath, "utf8");
    expect(JSON.parse(record).lifecycle.cleanup).toMatchObject({ phase: "completed", pluginsCleaned: true, roomDeleted: true, tenantDeleted: true });
    expect(record.includes("inviteLink") || record.includes("identityCredential") || record.includes(fixture.adminToken)).toBe(false);
    for (const invite of state.resources.invites) expect(record.includes(inviteTokenFromLink(invite.inviteLink))).toBe(false);
    await expect(demo.cleanupPublicDemo({ ...core, stateFile: recordPath })).resolves.toMatchObject({ cleaned: true });
    expect(await readdir(directory)).toEqual(["state.json.cleanup.json"]);
    const neighbourAfter = await privateHttp(fixture.origin, pluginPath(other, "packages"), "GET", admin);
    expect(neighbourAfter.status).toBe(200); expect(neighbourAfter.json()).toEqual(neighbourBefore.json());
    const preserved = await privateHttp(fixture.origin, pluginPath(other, `packages/${neighbourPackage.packageId}/content`), "GET", bearer(neighbourActor.session.token));
    expect(preserved.status).toBe(200); expect(preserved.bytes.equals(artifact.bytes)).toBe(true);
    const sdkAfter = await fetch(new URL(sdkUrl, fixture.origin));
    expect(sdkAfter.status).toBe(200); expect(Buffer.from(await sdkAfter.arrayBuffer()).equals(sdk)).toBe(true);
  } finally {
    if (path && await access(`${path}.held`).then(() => true, () => false)) {
      await rm(path, { recursive: true, force: true }); await rename(`${path}.held`, path);
    }
    const cleanup = await access(stateFile).then(() => stateFile, () => demo.publicDemoCleanupRecordPath(stateFile));
    if (await access(cleanup).then(() => true, () => false)) await demo.cleanupPublicDemo({ ...core, stateFile: cleanup });
    if (other) await privateHttp(fixture.origin, `/api/rooms/${other}`, "DELETE", admin);
    await author?.close(); await fixture.close(); await rm(directory, { recursive: true, force: true });
  }
});
