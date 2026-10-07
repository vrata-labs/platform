import { createHash, randomUUID } from "node:crypto";
import { test, expect } from "playwright/test";
import { assertDenied, bearer, downloadPublicSdk, inviteTokenFromLink, pluginPath, privateHttp } from "./plugin-author-scenarios";

test.use({ trace: "off", screenshot: "off", video: "off" });

test("@staging T05 shared floor one denies every plugin route even to a genuinely admitted legacy Host", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  const adminToken = process.env.STAGING_ADMIN_TOKEN ?? process.env.VRATA_ADMIN_TOKEN ?? "";
  if (!adminToken) throw new Error("plugin_author_staging_admin_environment_required");
  if (!baseURL || new URL(baseURL).protocol !== "https:" || new URL(baseURL).origin !== baseURL.replace(/\/$/, "")) {
    throw new Error("plugin_author_staging_requires_https_origin");
  }
  const origin = new URL(baseURL).origin;
  const admin = { "x-vrata-admin-token": adminToken };
  const tenantId = `plugin-author-denial-${randomUUID()}`;
  let tenantCreated = false, roomId: string | undefined;
  const inviteIds: string[] = [];
  try {
    // Public SDK compatibility remains available while private author routes are
    // inactive. This downloads the pinned archive, without installing on stage.
    await downloadPublicSdk(request);
    expect((await privateHttp(origin, "/api/tenants", "POST", admin, { tenantId, name: "Plugin author floor-one denial" })).status).toBe(201);
    tenantCreated = true;
    const created = await privateHttp(origin, "/api/rooms", "POST", admin, {
      tenantId, templateId: "meeting-room-basic", name: "Private plugin denial fixture", visibility: "private", guestAllowed: true,
      features: { voice: false, screenShare: false, spatialAudio: false }
    });
    expect(created.status).toBe(201);
    roomId = created.json<{ roomId: string }>().roomId;
    const invitation = await privateHttp(origin, `/api/rooms/${roomId}/invites`, "POST", admin,
      { role: "host", waitingRoomEnabled: false, expiresInSeconds: 600 });
    expect(invitation.status).toBe(201);
    const invite = invitation.json<{ inviteId: string; inviteLink: string }>();
    inviteIds.push(invite.inviteId);
    const inviteToken = inviteTokenFromLink(invite.inviteLink);
    const participantId = `plugin-denial-${randomUUID()}`;
    const admitted = await privateHttp(origin, "/api/tokens/state", "POST", {},
      { roomId, participantId, displayName: "Legacy plugin Host", inviteToken });
    expect(admitted.status).toBe(200);
    const host = admitted.json<{ token: string; role: string }>();
    expect(host.role === "host").toBe(true);
    expect(typeof host.token === "string" && !host.token.startsWith("rs2.") && host.token.split(".").length === 3).toBe(true);
    let claims: { role: string; roleSource: string; roomId: string; tenantId: string; participantId: string };
    try { claims = JSON.parse(Buffer.from(host.token.split(".")[1], "base64url").toString("utf8")); }
    catch { throw new Error("plugin_author_staging_legacy_claims_invalid"); }
    expect(claims.role === "host" && claims.roleSource === "trusted" && claims.roomId === roomId &&
      claims.tenantId === tenantId && claims.participantId === participantId).toBe(true);
    // Decode is not authority evidence: the actual API verifies the Bearer and
    // resolves the active Host's stateTokenAccess before testing plugin denial.
    const control = await privateHttp(origin, `/api/rooms/${roomId}/session-control`, "GET", bearer(host.token));
    expect(control.status).toBe(200);
    const state = control.json<{ participant: { participantId: string; role: string; status: string }; state: { hostParticipantId: string } }>();
    expect(state.participant.participantId === participantId && state.participant.role === "host" && state.participant.status === "active").toBe(true);
    expect(state.state.hostParticipantId === participantId).toBe(true);

    // Public observations jointly prove floor=1: real v1 admission still works,
    // and plugin family refuses before identity/body/storage. No internal shared
    // service secret or policy mutation is required to inspect that boundary.
    const packageId = randomUUID(), pluginId = "external.stage-denial";
    const entry = "globalThis.__T05_NATIVE_AUTHOR_EXECUTED__ = true; export function init() {}";
    const artifact = Buffer.from(JSON.stringify({ manifest: { schemaVersion: 1, sdkApiVersion: 1, id: pluginId,
      version: "1.0.0", displayName: "Denial fixture", requestedCapabilities: ["status.set"],
      configSchema: { greeting: { type: "string", required: true, minLength: 1, maxLength: 256 } },
      entrySha256: createHash("sha256").update(entry, "utf8").digest("hex") }, entry }));
    const binding = { expectedRevision: 0, packageId, version: "1.0.0", artifactSha256: createHash("sha256").update(artifact).digest("hex"), enabled: true,
      config: { greeting: "PRIVATE_STAGING_DENIAL_CONFIG" }, approvedCapabilities: ["status.set"] };
    const routes = [["packages", "GET", undefined], ["packages", "POST", artifact], ["runtime", "GET", undefined],
      [`packages/${packageId}/content`, "GET", undefined], [`packages/${packageId}`, "DELETE", undefined],
      [`bindings/${pluginId}`, "PUT", binding], [`bindings/${pluginId}`, "DELETE", { expectedRevision: 0 }]] as const;
    for (const headers of [bearer(host.token), admin, {}, { cookie: `sessionToken=${host.token}` }, bearer(inviteToken)]) {
      for (const [suffix, method, body] of routes) {
        assertDenied(await privateHttp(origin, pluginPath(roomId, suffix), method, headers, body), 409, "plugin_identity_not_active");
      }
    }
    const navigation = await page.goto(`${origin}/rooms/${roomId}`, { waitUntil: "domcontentloaded" }).catch(() => {
      throw new Error("plugin_author_staging_room_shell_navigation_failed");
    });
    expect(navigation?.status()).toBe(200);
    // The browser likewise sees only the stable denial, never artifact bytes.
    const sourceDenial = await page.evaluate(async ({ path, token }) => {
      const response = await fetch(path, { credentials: "omit", headers: { authorization: `Bearer ${token}` } });
      const body = await response.json();
      return { status: response.status, denied: JSON.stringify(body) === JSON.stringify({ error: "plugin_identity_not_active" }),
        attachment: response.headers.has("content-disposition"), checksum: response.headers.has("x-artifact-sha256"),
        nativeExecuted: Reflect.has(globalThis, "__T05_NATIVE_AUTHOR_EXECUTED__") };
    }, { path: pluginPath(roomId, `packages/${packageId}/content`), token: host.token }).catch(() => {
      throw new Error("plugin_author_staging_browser_denial_failed");
    });
    expect(sourceDenial.status).toBe(409); expect(sourceDenial.denied).toBe(true);
    expect(sourceDenial.attachment || sourceDenial.checksum || sourceDenial.nativeExecuted).toBe(false);
    expect((await privateHttp(origin, `/api/rooms/${roomId}/session-control`, "GET", bearer(host.token))).status).toBe(200);
    // No DB/quota inference from an HTTP denial: deleting the owned room below
    // exercises indexed cleanup and ensures no retained binding/package fixture.
    // This is the shared floor-one gate, not positive author activation (T01a).
  } finally {
    await page.goto("about:blank").catch(() => undefined);
    let failed = false;
    for (const inviteId of inviteIds) {
      try { expect((await privateHttp(origin, `/api/rooms/${roomId}/invites/${inviteId}/revoke`, "POST", admin)).status).toBe(200); }
      catch { failed = true; }
    }
    if (roomId) {
      try { expect((await privateHttp(origin, `/api/rooms/${roomId}`, "DELETE", admin)).status).toBe(200); }
      catch { failed = true; }
    }
    if (tenantCreated) {
      try { expect((await privateHttp(origin, `/api/tenants/${tenantId}`, "DELETE", admin)).status).toBe(200); }
      catch { failed = true; }
    }
    if (failed) throw new Error("plugin_author_staging_owned_resources_cleanup_failed");
  }
});
