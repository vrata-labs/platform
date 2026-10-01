import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { startReferenceTemplateFixture } from "./reference-template-fixture";
import { signRoomSessionToken } from "../../packages/shared-types/src/session-token.js";

// Raising the floor is irreversible. This case owns an isolated schema and is
// intentionally never tagged for the shared staging database.
test.use({ trace: "off", screenshot: "off", video: "off", viewport: { width: 390, height: 844 } });

for (const staging of [false, true]) test(`${staging ? "@staging " : ""}obsolete development-key credentials trigger a real upgrade denial`, async ({ page, request }) => {
  test.skip(!staging && !process.env.VRATA_TEST_POSTGRES_URL, "Requires isolated PostgreSQL");
  test.setTimeout(90_000);
  const fixture = staging ? null : await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, { stateTokenSecret: "identity-key-rotation-browser-test-secret-32" });
  const origin = fixture?.origin ?? process.env.BASE_URL!;
  const roomId = staging ? process.env.STAGING_ROOM_ID ?? "demo-room" : "demo-room";
  const participantId = `old-key-${randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const token = signRoomSessionToken({ tenantId: "demo-tenant", roomId, participantId, displayName: "Old-key denial check",
    role: "guest", permissions: [], sessionId: randomUUID(), jti: randomUUID(), iat: now, exp: now + 600 }, "dev-state-secret");
  try {
    await page.addInitScript(id => sessionStorage.setItem("vrata.participantId", id), participantId);
    // Forward a real obsolete credential; do not synthesize the server response.
    await page.route("**/api/tokens/state", route => route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${token}` } }));
    const denied = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state");
    await page.goto(`${origin}/rooms/${roomId}?onboard=0`);
    const response = await denied;
    expect(response.status()).toBe(409);
    expect(await response.json()).toEqual({ error: "identity_required", reason: "identity_upgrade_required" });
    await expect(page.locator("#session-upgrade-dialog")).toBeVisible();
    await expect(page.locator("#session-upgrade-title")).toHaveText("Update required to rejoin this room");
    expect(await page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(false);
    if (fixture) {
      const policy = await request.get(`${origin}/api/internal/identity-policy`, { headers: { "x-vrata-internal-token": "test-internal-token" } });
      expect((await policy.json()).minimumProtocolVersion).toBe(1);
    }
  } finally { await page.goto("about:blank").catch(() => {}); await fixture?.close(); }
});

test("real protocol activation stops a legacy client while a fresh tab joins with a stable server-issued identity", async ({ page, request, browser }) => {
  test.skip(!process.env.VRATA_TEST_POSTGRES_URL, "Requires an isolated PostgreSQL fixture");
  test.setTimeout(120_000);
  const fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, {
    stateTokenSecret: "isolated-v2-browser-activation-secret-32-bytes"
  });
  const requireApi = createRequire(resolve("apps/api/package.json"));
  const { Pool } = requireApi("pg");
  const pool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL, options: `-c search_path=${fixture.schema},public` });
  let releaseWrite: (() => void) | undefined;
  const fresh = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    expect(fixture.schema).toMatch(/^template_e2e_[0-9a-f]{32}$/);
    const namespace = await pool.query("select current_schema() as name, 'room_identity_protocol_policy'::regclass::oid as policy");
    expect(namespace.rows[0].name).toBe(fixture.schema);
    const owner = await pool.query("select n.nspname from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid=$1", [namespace.rows[0].policy]);
    expect(owner.rows[0].nspname).toBe(fixture.schema);
    const { PostgresStorage } = await import(pathToFileURL(resolve("apps/api/dist/storage.js")).href);
    const storage = new PostgresStorage(pool);
    await page.goto(`${fixture.origin}/rooms/demo-room?role=host&onboard=0`);
    await expect(page.locator("#notes-editor")).toBeEnabled({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(true);
    const legacyHostId = await page.evaluate(() => (window as any).__VRATA_DEBUG__?.participantId) as string;
    const legacyRoom = await storage.getRoom("demo-room");
    await storage.updateRoom("demo-room", { sessionControl: { ...legacyRoom!.sessionControl, hostParticipantId: legacyHostId } });
    const before = await page.locator("#notes-editor").inputValue();
    const scope = await page.locator("#notes-scope-select").inputValue();
    let sent!: () => void;
    const started = new Promise<void>(done => { sent = done; });
    const held = new Promise<void>(done => { releaseWrite = done; });
    await page.route("**/api/rooms/demo-room/notes/*", async route => {
      if (route.request().method() !== "PUT") return route.continue();
      sent(); await held;
      await route.continue().catch(() => undefined);
    });
    const draft = "Draft retained across the real server protocol boundary";
    await page.locator("#notes-editor").fill(draft);
    await started;
    await storage.identityProtocol.raise(2);
    releaseWrite();
    await expect(page.locator("#session-upgrade-dialog")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(`#session-upgrade-draft-${scope}`)).toHaveValue(draft);
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(false);
    const persisted = await request.get(`${fixture.origin}/api/rooms/demo-room/notes/${scope}`, { headers: { "x-vrata-admin-token": fixture.adminToken } });
    expect(persisted.status()).toBe(200);
    expect((await persisted.json()).note.content).toBe(before);
    await fixture.restartApi();
    const untrustedId = `tab-${randomUUID()}`;
    await fresh.addInitScript(id => sessionStorage.setItem("vrata.participantId", id), untrustedId);
    const admission = fresh.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state");
    await fresh.goto(`${fixture.origin}/rooms/demo-room?onboard=0`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    const response = await admission;
    expect(response.status()).toBe(200);
    const joined = await response.json() as { participantId: string; identityCredential: string; role: string };
    expect(joined.participantId).not.toBe(untrustedId);
    expect(joined.role).toBe("guest");
    expect(joined.identityCredential).toMatch(/^ri2\./);
    await expect.poll(() => fresh.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(true);
    await expect(fresh.locator("#session-upgrade-dialog")).toBeHidden();
    expect(await fresh.evaluate(() => (window as any).__VRATA_DEBUG__?.participantId)).toBe(joined.participantId);
    const rejoin = fresh.waitForResponse(next => new URL(next.url()).pathname === "/api/tokens/state");
    await fresh.reload();
    expect((await rejoin).status()).toBe(200);
    expect((await (await rejoin).json() as { participantId: string }).participantId).toBe(joined.participantId);
    await expect.poll(() => fresh.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(true);
    expect(await storage.identityProtocol.minimum()).toBe(2);
    const recovery = await request.post(`${fixture.origin}/api/rooms/demo-room/identity-recovery`, {
      headers: { "x-vrata-admin-token": fixture.adminToken }, data: { participantId: legacyHostId, role: "host" }
    });
    expect(recovery.status()).toBe(201);
    const proof = (await recovery.json() as { recoveryCredential: string }).recoveryCredential;
    await expect(page.locator("#room-recovery-panel")).toBeVisible();
    await page.locator("#room-recovery-panel summary").click();
    await page.locator("#room-recovery-credential").fill(proof);
    const recovered = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state" && response.status() === 200);
    await page.locator("#room-recovery-submit").click();
    await recovered;
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.participantId).catch(() => null)).toBe(legacyHostId);
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.access?.role).catch(() => null)).toBe("host");
  } finally {
    releaseWrite?.();
    await Promise.allSettled([page.goto("about:blank"), fresh.close()]);
    await pool.end();
    await fixture.close();
  }
});

test("legacy private owner recovers through an administrator-issued single-use code", async ({ page, request }) => {
  test.skip(!process.env.VRATA_TEST_POSTGRES_URL, "Requires an isolated PostgreSQL fixture");
  test.setTimeout(90_000);
  const fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, {
    stateTokenSecret: "isolated-v2-legacy-owner-recovery-secret-32-bytes"
  });
  const requireApi = createRequire(resolve("apps/api/package.json"));
  const { Pool } = requireApi("pg");
  const pool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL,
    options: `-c search_path=${fixture.schema},public` });
  const { PostgresStorage } = await import(pathToFileURL(resolve("apps/api/dist/storage.js")).href);
  try {
    const storage = new PostgresStorage(pool);
    const legacy = await storage.createRoom({ tenantId: "demo-tenant", templateId: "personal-room-basic",
      name: "Recover legacy owner", roomType: "personal", ownerParticipantId: "legacy-owner",
      visibility: "private", guestAllowed: false, sessionControl: { hostParticipantId: "legacy-owner" } });
    await storage.identityProtocol.raise(2);
    const denied = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state");
    await page.goto(`${fixture.origin}/rooms/${legacy.roomId}?onboard=0`, { waitUntil: "domcontentloaded" });
    expect((await denied).status()).toBe(403);
    const issued = await request.post(`${fixture.origin}/api/rooms/${legacy.roomId}/identity-recovery`, {
      headers: { "x-vrata-admin-token": fixture.adminToken },
      data: { participantId: "legacy-owner", role: "owner" }
    });
    expect(issued.status()).toBe(201);
    const proof = (await issued.json() as { recoveryCredential: string }).recoveryCredential;
    await page.locator("#room-recovery-panel summary").click();
    await page.locator("#room-recovery-credential").fill(proof);
    const recovered = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state" && response.status() === 200);
    await page.locator("#room-recovery-submit").click();
    await recovered;
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.participantId).catch(() => null)).toBe("legacy-owner");
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.personalRoom?.isOwner).catch(() => null)).toBe(true);
    await expect(page.locator("#notes-editor")).toBeEnabled();
    const replay = await request.post(`${fixture.origin}/api/tokens/state`, {
      data: { roomId: legacy.roomId, identityProtocolVersion: 2, recoveryCredential: proof }
    });
    expect(replay.status()).toBe(409);
  } finally {
    await page.goto("about:blank").catch(() => undefined);
    await pool.end();
    await fixture.close();
  }
});

test("v2 personal owner persists across reload and a copied public ID cannot reopen the room", async ({ page, browser }) => {
  test.skip(!process.env.VRATA_TEST_POSTGRES_URL, "Requires an isolated PostgreSQL fixture");
  test.setTimeout(90_000);
  const fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, {
    stateTokenSecret: "isolated-v2-personal-owner-browser-secret-32-bytes"
  });
  const requireApi = createRequire(resolve("apps/api/package.json"));
  const { Pool } = requireApi("pg");
  const pool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL,
    options: `-c search_path=${fixture.schema},public` });
  const { PostgresStorage } = await import(pathToFileURL(resolve("apps/api/dist/storage.js")).href);
  const untrusted = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const deniedPaths: string[] = [];
  page.on("response", response => {
    if ([401, 409, 426].includes(response.status())) deniedPaths.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  try {
    await new PostgresStorage(pool).identityProtocol.raise(2);
    await page.goto(`${fixture.origin}/rooms/demo-room?onboard=0`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(true);
    await page.locator("#open-personal-room").click({ timeout: 5000 }).catch(error => {
      throw new Error(`personal_room_button_blocked:${deniedPaths.join(",")}`, { cause: error });
    });
    await expect.poll(() => new URL(page.url()).pathname).not.toBe("/rooms/demo-room");
    await expect(page).toHaveURL(/\/rooms\/[^/?]+/);
    const personalUrl = page.url();
    expect(personalUrl).not.toContain("/rooms/demo-room");
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(true);
    const ownerId = await page.evaluate(() => (window as any).__VRATA_DEBUG__?.participantId) as string;
    expect(ownerId).toBeTruthy();
    const reloadAdmission = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state");
    await page.reload({ waitUntil: "domcontentloaded" });
    expect((await reloadAdmission).status()).toBe(200);
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.participantId)).toBe(ownerId);
    await page.goto(`${fixture.origin}/rooms/demo-room?onboard=0`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#open-personal-room")).toBeEnabled();
    await page.locator("#open-personal-room").click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(new URL(personalUrl).pathname);
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.participantId)).toBe(ownerId);
    await untrusted.addInitScript(id => sessionStorage.setItem("vrata.participantId", id), ownerId);
    const denied = untrusted.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state");
    await untrusted.goto(personalUrl, { waitUntil: "domcontentloaded" });
    expect((await denied).status()).toBe(403);
    await expect(untrusted.locator("#session-upgrade-dialog")).toBeHidden();
  } finally {
    await Promise.allSettled([page.goto("about:blank"), untrusted.close()]);
    await pool.end();
    await fixture.close();
  }
});

test("personal owner hands off to an invited Member with proof and live controls", async ({ page, browser, request }) => {
  test.skip(!process.env.VRATA_TEST_POSTGRES_URL, "Requires an isolated PostgreSQL fixture");
  test.setTimeout(120_000);
  const fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, {
    stateTokenSecret: "isolated-v2-owner-handoff-browser-secret-32-bytes"
  });
  const requireApi = createRequire(resolve("apps/api/package.json"));
  const { Pool } = requireApi("pg");
  const pool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL,
    options: `-c search_path=${fixture.schema},public` });
  const { PostgresStorage } = await import(pathToFileURL(resolve("apps/api/dist/storage.js")).href);
  const recipientPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await new PostgresStorage(pool).identityProtocol.raise(2);
    const opened = await request.post(`${fixture.origin}/api/personal-room`, {
      data: { identityProtocolVersion: 2, displayName: "Original owner" }
    });
    expect(opened.status()).toBe(201);
    const owner = await opened.json() as { room: { roomId: string }; identityCredential: string; participantId: string };
    await page.addInitScript(input => sessionStorage.setItem(`vrata.identity.v2.${encodeURIComponent(input.roomId)}`, input.credential),
      { roomId: owner.room.roomId, credential: owner.identityCredential });
    const personalUrl = `${fixture.origin}/rooms/${owner.room.roomId}?onboard=0`;
    await page.goto(personalUrl, { waitUntil: "domcontentloaded" });
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.personalRoom?.isOwner)).toBe(true);
    const invitation = await request.post(`${fixture.origin}/api/rooms/${owner.room.roomId}/invites`, {
      headers: { "x-vrata-admin-token": fixture.adminToken }, data: { role: "member", expiresInSeconds: 120 }
    });
    expect(invitation.status()).toBe(201);
    const inviteLink = (await invitation.json() as { inviteLink: string }).inviteLink;
    await recipientPage.goto(`${inviteLink}&onboard=0`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => recipientPage.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(true);
    const recipientId = await recipientPage.evaluate(() => (window as any).__VRATA_DEBUG__?.participantId) as string;
    await expect.poll(() => page.locator("#host-participant-select option").evaluateAll((options, target) =>
      options.some(option => (option as HTMLOptionElement).value === target), recipientId), { timeout: 20_000 }).toBe(true);
    await page.locator("#host-participant-select").selectOption(recipientId);
    await expect(page.locator("#transfer-owner")).toBeEnabled({ timeout: 20_000 });
    const transferred = page.waitForResponse(response => new URL(response.url()).pathname === `/api/rooms/${owner.room.roomId}/owner/transfer`);
    await page.locator("#transfer-owner").click();
    expect((await transferred).status()).toBe(200);
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.personalRoom?.isOwner)).toBe(false);
    await expect.poll(() => recipientPage.evaluate(() => (window as any).__VRATA_DEBUG__?.personalRoom?.isOwner),
      { timeout: 20_000 }).toBe(true);
    await expect(recipientPage.locator("#host-controls")).toBeVisible();
    expect(await recipientPage.evaluate(() => (window as any).__VRATA_DEBUG__?.access?.role)).toBe("member");
    const recipientAdmission = recipientPage.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state");
    await recipientPage.reload({ waitUntil: "domcontentloaded" });
    expect((await recipientAdmission).status()).toBe(200);
    await expect.poll(() => recipientPage.evaluate(() => (window as any).__VRATA_DEBUG__?.personalRoom?.isOwner).catch(() => null)).toBe(true);
  } finally {
    await Promise.allSettled([page.goto("about:blank"), recipientPage.close()]);
    await pool.end();
    await fixture.close();
  }
});

test("anonymous v2 admission is bounded while an existing tab can renew its identity", async ({ page, browser }) => {
  test.skip(!process.env.VRATA_TEST_POSTGRES_URL, "Requires an isolated PostgreSQL fixture");
  test.setTimeout(90_000);
  const fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, {
    stateTokenSecret: "isolated-v2-anonymous-admission-secret-32-bytes"
  });
  const requireApi = createRequire(resolve("apps/api/package.json"));
  const { Pool } = requireApi("pg");
  const pool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL,
    options: `-c search_path=${fixture.schema},public` });
  const { PostgresStorage } = await import(pathToFileURL(resolve("apps/api/dist/storage.js")).href);
  const blockedTab = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await new PostgresStorage(pool).identityProtocol.raise(2);
    await page.goto(`${fixture.origin}/rooms/demo-room?onboard=0`, { waitUntil: "domcontentloaded" });
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(true);
    const participantId = await page.evaluate(() => (window as any).__VRATA_DEBUG__?.participantId) as string;
    const peers = (await pool.query("select distinct origin_hash from room_identity_admission_buckets_v2 where kind='room'")).rows;
    expect(peers).toHaveLength(1);
    const start = Math.floor(Date.now() / 60_000) * 60_000;
    await pool.query(`insert into room_identity_admission_buckets_v2 (origin_hash,kind,window_ms,window_start_ms,attempts)
      values ($1,'room',60000,$2,180),($1,'room',60000,$3,180)
      on conflict (origin_hash,kind,window_ms,window_start_ms) do update set attempts=180`, [peers[0].origin_hash, start, start + 60_000]);
    const denied = blockedTab.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state");
    await blockedTab.goto(`${fixture.origin}/rooms/demo-room?onboard=0`, { waitUntil: "domcontentloaded" });
    expect((await denied).status()).toBe(429);
    await expect(blockedTab.locator("#guest-access-line")).toContainText("Too many new room entries");
    const renewed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state");
    await page.reload({ waitUntil: "domcontentloaded" });
    expect((await renewed).status()).toBe(200);
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.participantId).catch(() => null)).toBe(participantId);
  } finally {
    await Promise.allSettled([page.goto("about:blank"), blockedTab.close()]);
    await pool.end();
    await fixture.close();
  }
});

test("isolated live v2 room-state socket rechecks role and revocation before privileged effects", async () => {
  test.skip(!process.env.VRATA_TEST_POSTGRES_URL, "Requires isolated PostgreSQL");
  test.setTimeout(120_000);
  const secret = "isolated-v2-websocket-session-secret-32-bytes";
  const fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, { stateTokenSecret: secret });
  const requireApi = createRequire(resolve("apps/api/package.json"));
  const requireState = createRequire(resolve("apps/room-state/package.json"));
  const { Pool } = requireApi("pg");
  const { WebSocket: NativeWebSocket } = requireState("ws");
  const pool = new Pool({ connectionString: process.env.VRATA_TEST_POSTGRES_URL,
    options: `-c search_path=${fixture.schema},public` });
  const { PostgresStorage } = await import(pathToFileURL(resolve("apps/api/dist/storage.js")).href);
  const { createRoomIdentityService } = await import(pathToFileURL(resolve("apps/api/dist/identity/service.js")).href);
  const storage = new PostgresStorage(pool);
  let roomId: string | undefined;
  let socket: InstanceType<typeof NativeWebSocket> | undefined;
  try {
    expect(fixture.schema).toMatch(/^template_e2e_[0-9a-f]{32}$/);
    const bound = await pool.query("select current_schema() as name");
    expect(bound.rows[0].name).toBe(fixture.schema);
    await storage.identityProtocol.raise(2);
    const room = await storage.createRoom({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "V2 socket authority" });
    roomId = room.roomId;
    const scope = { tenantId: room.tenantId, roomId };
    const invitation = await fetch(`${fixture.origin}/api/rooms/${roomId}/invites`, { method: "POST",
      headers: { "content-type": "application/json", "x-vrata-admin-token": fixture.adminToken },
      body: JSON.stringify({ role: "host", expiresInSeconds: 60 }) });
    expect(invitation.status).toBe(201);
    const inviteLink = (await invitation.json() as { inviteLink: string }).inviteLink;
    const rawInvite = new URL(inviteLink).searchParams.get("invite");
    expect(rawInvite).toBeTruthy();
    const inviteTokenHash = createHmac("sha256", secret).update(rawInvite!).digest("base64url");
    const service = createRoomIdentityService(storage.roomIdentities, secret, Date.now, { identityLifetimeSeconds: 86_400 });
    const host = await service.admit({ ...scope, displayName: "Host", inviteTokenHash });
    const next = await service.admit({ ...scope, displayName: "Member" });
    const { sessionToken } = await service.issueSession(host.credential, scope);
    const address = new URL(fixture.stateOrigin.replace(/^http/, "ws"));
    address.searchParams.set("roomId", roomId);
    address.searchParams.set("participantId", host.identity.participantId);
    address.searchParams.set("accessToken", sessionToken);
    const spoofedAddress = new URL(address);
    spoofedAddress.searchParams.set("participantId", next.identity.participantId);
    const spoofed = new NativeWebSocket(spoofedAddress);
    const [spoofCode] = await once(spoofed, "close");
    expect(spoofCode).toBe(1008);
    const legacyAddress = new URL(address);
    const now = Math.floor(Date.now() / 1000);
    legacyAddress.searchParams.set("accessToken", signRoomSessionToken({ ...scope,
      participantId: host.identity.participantId, displayName: "Legacy impersonator", role: "host", permissions: [],
      sessionId: randomUUID(), jti: randomUUID(), iat: now, exp: now + 900 }, secret));
    const legacy = new NativeWebSocket(legacyAddress);
    const [legacyCode] = await once(legacy, "close");
    expect(legacyCode).toBe(4406);
    socket = new NativeWebSocket(address);
    const messages: Array<{ type?: string; result?: { accepted?: boolean; role?: string } }> = [];
    socket.on("message", (raw: Buffer) => { messages.push(JSON.parse(String(raw))); });
    await once(socket, "open");
    await expect.poll(() => messages.some(value => value.type === "room_state")).toBe(true);
    socket.send(JSON.stringify({ type: "surface_create_object", probeOnly: true }));
    await expect.poll(() => messages.some(value => value.type === "surface_command_result" && value.result?.accepted === true)).toBe(true);
    await storage.roomIdentities.transition(scope, { actorType: "room-session", proof: host.identity }, 1,
      { type: "transfer-host", targetParticipantId: next.identity.participantId });
    const inviteFrom = (bearer: string) => fetch(`${fixture.origin}/api/rooms/${roomId}/invites`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ role: "guest", expiresInSeconds: 60 })
    });
    expect((await inviteFrom(sessionToken)).status).toBe(403, "the former Host cannot issue a new v2 invitation");
    const successor = await service.issueSession(next.credential, scope);
    expect((await inviteFrom(successor.sessionToken)).status).toBe(201);
    socket.send(JSON.stringify({ type: "surface_create_object", probeOnly: true }));
    await expect.poll(() => messages.some(value => value.type === "access_denied" && value.result?.role === "member")).toBe(true);
    expect(socket.readyState).toBe(NativeWebSocket.OPEN);
    await storage.roomIdentities.revoke(scope, host.identity.identityId, 1);
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "surface_create_object", probeOnly: true }));
    const [code] = await closed;
    expect(code).toBe(1008);
    expect(messages.filter(value => value.type === "surface_command_result").length).toBe(1);
  } finally {
    socket?.close();
    if (roomId) await storage.deleteRoom(roomId);
    await pool.end();
    await fixture.close();
  }
});
