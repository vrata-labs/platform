import { expect, type Page, type Request } from "@playwright/test";
import { randomInt, randomUUID } from "node:crypto";
import { bearer, createExternalAuthorProject, downloadPublicSdk, nativeMarker, pluginPath, privateHttp, sha256 } from "./plugin-author-scenarios";
import { uploadThroughUi, chooseVersion, act } from "./plugin-author-ui";
import { expectPluginStatus } from "./room-plugin-fixture";
import { chooseMeetingPanel } from "./meeting-tools-acceptance";
import type { RoomAuthorityCapture } from "./room-state-observation";
import { cleanupAll } from "./test-cleanup";

type Actor = { page: Page; participantId: string; sessionToken: string; authority: RoomAuthorityCapture };
type Library = { revision: number; packages: Array<{ packageId: string; pluginId: string; version: string; artifactSha256: string }>;
  bindings: Array<{ pluginId: string; packageId: string; version: string; artifactSha256: string; enabled: boolean; approvedCapabilities: string[] }> };

export async function publicDemoPluginLifecycle(origin: string, roomId: string, host: Actor, member: Actor, guest: Actor) {
  const author = await createExternalAuthorProject(await downloadPublicSdk(origin, "0.2.0"), "0.2.0");
  let authorRequests = 0, documentUploads = 0, invalidAuthority = false;
  const onRequest = (request: Request) => {
    const path = new URL(request.url()).pathname;
    const pdfUpload = path === `/api/rooms/${roomId}/documents` && request.method() === "POST";
    if (!path.includes(`/rooms/${roomId}/plugins/`) && !pdfUpload) return;
    authorRequests++;
    if (pdfUpload) documentUploads++;
    const headers = request.headers();
    invalidAuthority ||= Boolean(headers["x-vrata-admin-token"]) || !headers.authorization?.startsWith("Bearer rs2.");
  };
  host.page.on("request", onRequest);
  const read = async (actor = host) => {
    const response = await privateHttp(origin, pluginPath(roomId, "packages"), "GET", bearer(actor.sessionToken));
    expect(response.status).toBe(200);
    return response.json<Library>();
  };
  try {
    await chooseMeetingPanel(host.page, "people", false);
    for (const actor of [host, member, guest]) {
      expect(await actor.page.evaluate(() => (window as any).__VRATA_DEBUG__?.plugins?.running ?? 0)).toBe(0);
    }
    await expect(host.page.locator("#room-plugin-author")).toBeVisible();
    const pluginId = `external.demo-${randomUUID().replaceAll("-", "")}`;
    const body = (version: string) => `export function init(context: RoomPluginContext) { return context.sdk.status.set(String(context.config.greeting) + " ${version}"); }`;
    const first = await author.build(pluginId, "1.0.0", ["status.set"], body("v1"));
    const second = await author.build(pluginId, "1.0.1", ["status.set", "seating.cancelPendingOwnClaim"], body("v2"));
    await uploadThroughUi(host.page, first);
    const entry = host.page.locator(`[data-plugin-id="${pluginId}"]`);
    await entry.locator('[data-config-key="greeting"]').fill("Public demo");
    await entry.locator('[data-capability="status.set"]').check();
    await act(host.page, entry, "enable", "Behavior enabled");
    await expectPluginStatus(member.page, "public-demo-v1", "Public demo v1", 45_000);
    let library = await read();
    expect(library.revision).toBe(1);
    const exactBinding = (value: Library, artifact: typeof first, enabled: boolean) => {
      const binding = value.bindings.find(row => row.pluginId === pluginId);
      const pkg = value.packages.find(row => row.packageId === binding?.packageId);
      expect(Boolean(binding && pkg && binding.version === artifact.version && pkg.version === artifact.version
        && binding.artifactSha256 === artifact.artifactSha256 && pkg.artifactSha256 === artifact.artifactSha256 && binding.enabled === enabled
        && binding.approvedCapabilities.length === artifact.capabilities.length
        && artifact.capabilities.every(capability => binding.approvedCapabilities.includes(capability)))).toBe(true);
    };
    exactBinding(library, first, true);
    await uploadThroughUi(host.page, second);
    await chooseVersion(entry, second.version);
    await expect(entry.locator('[data-capability="seating.cancelPendingOwnClaim"]')).not.toBeChecked();
    expect((await read()).revision).toBe(library.revision);
    await expectPluginStatus(member.page, "public-demo-unapproved", "Public demo v1");
    await entry.locator('[data-capability="seating.cancelPendingOwnClaim"]').check();
    await act(host.page, entry, "enable", "Behavior enabled");
    library = await read(); expect(library.revision).toBe(2); exactBinding(library, second, true);
    await expectPluginStatus(member.page, "public-demo-v2", "Public demo v2");
    await expect(member.page.locator("#room-plugin-status-list")).not.toContainText("Public demo v1");
    const stale = await privateHttp(origin, pluginPath(roomId, `bindings/${pluginId}`), "PUT", bearer(host.sessionToken), {
      ...library.bindings[0], expectedRevision: 1, config: { greeting: "stale" }, approvedCapabilities: ["status.set"] });
    expect(stale.status).toBe(409);
    expect(sha256(Buffer.from(JSON.stringify(await read()))) === sha256(Buffer.from(JSON.stringify(library)))).toBe(true);
    await act(host.page, entry, "disable", "Behavior disabled");
    library = await read(); expect(library.revision).toBe(3); exactBinding(library, second, false);
    await expect.poll(() => member.page.evaluate(() => (window as any).__VRATA_DEBUG__?.plugins?.running), { timeout: 15_000 }).toBe(0);
    await expect(member.page.locator("#room-plugin-status-list")).not.toContainText("Public demo");
    // A retired generation cannot reintroduce its effect while disabled.
    await member.page.waitForTimeout(1000);
    expect(await member.page.evaluate(() => (window as any).__VRATA_DEBUG__?.plugins?.running)).toBe(0);
    await act(host.page, entry, "enable", "Behavior enabled");
    library = await read(); expect(library.revision).toBe(4); exactBinding(library, second, true);
    await expectPluginStatus(member.page, "public-demo-reenabled", "Public demo v2");
    for (const actor of [member, guest]) await denyAuthor(actor, host);
    expect(authorRequests > 0 && !invalidAuthority).toBe(true);
    for (const actor of [host, member, guest]) expect(await actor.page.evaluate(marker => Reflect.has(window, marker), nativeMarker)).toBe(false);
    await author.assertNotExecuted();

    async function denyAuthor(actor: Actor, currentHost: Actor) {
      await expect(actor.page.locator("#room-plugin-author")).toBeHidden();
      expect(await actor.page.locator("#room-plugin-author").evaluate(element => (element as HTMLElement).hidden)).toBe(true);
      const before = await read(currentHost), binding = before.bindings.find(row => row.pluginId === pluginId)!;
      const hash = sha256(Buffer.from(JSON.stringify(before)));
      for (const [suffix, method, body] of [["packages", "GET", undefined], ["packages", "POST", second.bytes],
        [`bindings/${pluginId}`, "PUT", { ...binding, expectedRevision: before.revision, config: { greeting: "denied" }, approvedCapabilities: [] }],
        [`bindings/${pluginId}`, "DELETE", { expectedRevision: before.revision }], [`packages/${binding.packageId}`, "DELETE", undefined]] as const) {
        const response = await privateHttp(origin, pluginPath(roomId, suffix), method, bearer(actor.sessionToken), body);
        expect(response.status).toBe(403);
        expect(response.bytes.toString() === JSON.stringify({ error: "plugin_author_forbidden" })).toBe(true);
      }
      expect(sha256(Buffer.from(JSON.stringify(await read(currentHost)))) === hash).toBe(true);
      await expectPluginStatus(member.page, "public-demo-denial-unchanged", "Public demo v2");
    }
    return { denyAuthor, read,
      assertNormalAuthorRequests() { expect(authorRequests > 0 && documentUploads > 0 && !invalidAuthority).toBe(true); },
      async close() { await cleanupAll([() => host.page.off("request", onRequest), () => author.close()]); } };
  } catch (error) { await cleanupAll([() => host.page.off("request", onRequest), () => author.close()], { error }); throw error; }
}

/** Short normal-UI authority handoff, not another Presenter/media suite. */
export async function publicDemoAuthorityChanges(origin: string, roomId: string, host: Actor, member: Actor,
  plugins: Awaited<ReturnType<typeof publicDemoPluginLifecycle>>, documentId: string) {
  const role = (actor: Actor, expected: string) => expect.poll(() => actor.page.evaluate(() => (window as any).__VRATA_DEBUG__?.access?.role), { timeout: 30_000 }).toBe(expected);
  const action = async (actor: Actor, target: Actor, selector: string, suffix: string) => {
    await chooseMeetingPanel(actor.page, "people", false);
    await actor.page.locator("#host-participant-select").selectOption(target.participantId);
    const response = actor.page.waitForResponse(response => response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/rooms/${roomId}/${suffix}`);
    void response.catch(() => undefined);
    await actor.page.locator(selector).click(); expect((await response).status()).toBe(200);
  };
  await action(host, member, "#grant-presenter", `presenters/${member.participantId}/grant`);
  await role(member, "presenter");
  await expect(member.page.locator("#document-upload-button")).toBeEnabled();
  await plugins.denyAuthor(member, host);
  await member.page.evaluate(() => (window as any).__t16HoldSocket());
  await action(host, member, "#revoke-presenter", `presenters/${member.participantId}/revoke`);
  await role(member, "member");
  await expect(member.page.locator("#document-upload-button")).toBeDisabled();
  await deniedPrivilegedEffects(member, host);
  await host.page.evaluate(() => (window as any).__t16HoldSocket());
  await action(host, member, "#transfer-host", "host/transfer");
  await role(host, "member"); await role(member, "host");
  await chooseMeetingPanel(member.page, "people", false);
  await expect(member.page.locator("#room-plugin-author")).toBeVisible();
  await plugins.read(member);
  await plugins.denyAuthor(host, member);
  await deniedPrivilegedEffects(host, member);

  async function deniedPrivilegedEffects(actor: Actor, reader: Actor) {
    const get = async (suffix: string) => {
      const response = await privateHttp(origin, `/api/rooms/${roomId}/${suffix}`, "GET", bearer(reader.sessionToken));
      expect(response.status).toBe(200); return sha256(response.bytes);
    };
    const before = await Promise.all([get("documents"), get("notes/shared")]);
    const mediaHash = reader.authority.snapshot()?.mediaHash;
    expect(Boolean(mediaHash)).toBe(true);
    const denied = await privateHttp(origin, `/api/rooms/${roomId}/documents/${documentId}/surface`, "POST", bearer(actor.sessionToken), { surfaceId: "debug-main" });
    expect(denied.status).toBe(403);
    const commandId = `t16-old-author-${randomUUID()}`;
    const delivery = await actor.page.evaluate(commandId => (window as any).__t16SocketCommand({ type: "surface_create_object", probeOnly: false, commandId,
      surfaceId: "debug-main", objectType: "pdf-presentation" }), commandId);
    expect(delivery).toBe("sent");
    await expect.poll(() => actor.authority.commands().some(value => value.commandId === commandId && value.type === "access_denied"
      && value.accepted === false && value.permissionDenied && actor.authority.commands().some(sent => sent.type === "surface_create_object"
        && sent.commandId === commandId && sent.socketScope === value.socketScope && sent.generation === value.generation)), { timeout: 15_000 }).toBe(true);
    // A real server-side presence update, ordered after the denial on the SAME
    // held socket, makes the reader observe fresh media bytes, not a cached hash.
    const marker = randomInt(1, 2 ** 48 - 1);
    const barrier = reader.authority.watchParticipantBarrier(actor.participantId, marker);
    try {
      expect(await actor.page.evaluate(marker => (window as any).__t16SocketCommand({ type: "participant_update", participant: { clientTimeMs: marker } }), marker)).toBe("sent");
      await expect.poll(() => Boolean(barrier.snapshot()), { timeout: 15_000 }).toBe(true);
      expect(barrier.snapshot()?.mediaHash === mediaHash).toBe(true);
    } finally { barrier.close(); }
    expect(JSON.stringify(await Promise.all([get("documents"), get("notes/shared")])) === JSON.stringify(before)).toBe(true);
  }
}
