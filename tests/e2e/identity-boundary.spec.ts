import { expect, test, type APIRequestContext } from "@playwright/test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { PDFDocument } from "pdf-lib";
import { startReferenceTemplateFixture } from "./reference-template-fixture";
import { identityProtocolAt } from "./staging-identity";
import { signRoomSessionToken } from "../../packages/shared-types/src/session-token.js";

// Raising the floor is irreversible. This case owns an isolated schema and is
// intentionally never tagged for the shared staging database.
test.use({ trace: "off", screenshot: "off", video: "off", viewport: { width: 390, height: 844 } });

/** A real identity-v1 body (client-chosen participant ID and role, no bearer) is refused before any credential is issued. */
async function expectIdentityV1AdmissionRefused(request: APIRequestContext, origin: string, roomId: string) {
  const response = await request.post(`${origin}/api/tokens/state`, { data: {
    roomId, participantId: `identity-v1-${randomUUID()}`, requestedRole: "host", displayName: "Identity v1 client" } });
  expect(response.status()).toBe(426);
  // Exact body: no token, participant ID or identity credential.
  expect(await response.json()).toEqual({ error: "identity_required", reason: "identity_upgrade_required" });
}

for (const staging of [false, true]) test(`${staging ? "@staging " : ""}obsolete development-key credentials trigger a real upgrade denial`, async ({ page, request }) => {
  test.skip(!staging && !process.env.VRATA_TEST_POSTGRES_URL, "Requires isolated PostgreSQL");
  test.setTimeout(90_000);
  const fixture = staging ? null : await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, { stateTokenSecret: "identity-key-rotation-browser-test-secret-32" });
  const origin = fixture?.origin ?? process.env.BASE_URL!;
  const floor = staging ? await identityProtocolAt(origin) : 1;
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
    // Floor 1 classifies the rotated development key; floor 2 refuses every bearer at admission.
    expect(response.status()).toBe(floor === 2 ? 426 : 409);
    expect(await response.json()).toEqual({ error: "identity_required", reason: "identity_upgrade_required" });
    await expect(page.locator("#session-upgrade-dialog")).toBeVisible();
    await expect(page.locator("#session-upgrade-title")).toHaveText("Update required to rejoin this room");
    expect(await page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(false);
    if (floor === 2) await expectIdentityV1AdmissionRefused(request, origin, roomId);
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
    const legacyAdmission = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state" && response.status() === 200);
    void legacyAdmission.catch(() => undefined);
    await page.goto(`${fixture.origin}/rooms/demo-room?role=host&onboard=0`);
    await expect(page.locator("#notes-editor")).toBeEnabled({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(true);
    const legacyHostId = await page.evaluate(() => (window as any).__VRATA_DEBUG__?.participantId) as string;
    const legacyRoom = await storage.getRoom("demo-room");
    await storage.updateRoom("demo-room", { sessionControl: { ...legacyRoom!.sessionControl, hostParticipantId: legacyHostId } });
    // A room material created before activation through the ordinary document upload with the legacy host session.
    const legacySession = await (await legacyAdmission).json() as { token: string };
    const pdf = await PDFDocument.create(); pdf.addPage([320, 180]);
    const pdfBytes = Buffer.from(await pdf.save());
    const uploaded = await request.post(`${fixture.origin}/api/rooms/demo-room/documents`, { headers: { authorization: `Bearer ${legacySession.token}` },
      multipart: { document: { name: "kept-across-identity-activation.pdf", mimeType: "application/pdf", buffer: pdfBytes } } });
    expect(uploaded.status()).toBe(201);
    const keptDocument = (await uploaded.json() as { document: { documentId: string; uploadedBy: string } }).document;
    expect(keptDocument.uploadedBy).toBe(legacyHostId);
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
    await expectIdentityV1AdmissionRefused(request, fixture.origin, "demo-room");
    const untrustedId = `tab-${randomUUID()}`;
    // Everything the fresh tab sends, from before navigation until after its reload: URLs, headers, bodies and socket frames.
    const outgoing: string[] = [], roomStateParticipants: string[] = [], presenceParticipants: string[] = [];
    let presenceWrites = 0;
    fresh.on("request", item => {
      const body = item.postDataBuffer()?.toString("latin1") ?? "";
      // headers() leaves out cookies; the tab's cookie jar is checked separately below.
      outgoing.push(item.url(), JSON.stringify(item.headers()), body);
      const presence = /^\/api\/rooms\/[^/]+\/presence\/([^/]+)$/.exec(new URL(item.url()).pathname);
      if (presence && item.method() === "PUT") {
        presenceWrites += 1;
        presenceParticipants.push(decodeURIComponent(presence[1]), (JSON.parse(body) as { participantId: string }).participantId);
      }
    });
    fresh.on("websocket", socket => {
      outgoing.push(socket.url());
      const participant = new URL(socket.url()).searchParams.get("participantId");
      if (participant !== null) roomStateParticipants.push(participant);
      socket.on("framesent", frame => outgoing.push(typeof frame.payload === "string" ? frame.payload : frame.payload.toString("latin1")));
    });
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
    await expect.poll(() => presenceWrites, { timeout: 15_000 }).toBeGreaterThan(0);
    const presenceWritesBeforeReload = presenceWrites;
    const rejoin = fresh.waitForResponse(next => new URL(next.url()).pathname === "/api/tokens/state");
    await fresh.reload();
    expect((await rejoin).status()).toBe(200);
    expect((await (await rejoin).json() as { participantId: string }).participantId).toBe(joined.participantId);
    await expect.poll(() => fresh.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(true);
    await expect.poll(() => presenceWrites, { timeout: 15_000 }).toBeGreaterThan(presenceWritesBeforeReload);
    // The planted local ID never leaves the tab; room-state and presence (path and body) carry only the issued one.
    expect(outgoing.filter(entry => entry.includes(untrustedId))).toEqual([]);
    expect((await fresh.context().cookies()).filter(cookie => `${cookie.name}=${cookie.value}`.includes(untrustedId))).toEqual([]);
    expect(roomStateParticipants.length).toBeGreaterThanOrEqual(2);
    expect([...new Set([...roomStateParticipants, ...presenceParticipants])]).toEqual([joined.participantId]);
    expect(await storage.identityProtocol.minimum()).toBe(2);
    const recovery = await request.post(`${fixture.origin}/api/rooms/demo-room/identity-recovery`, {
      headers: { "x-vrata-admin-token": fixture.adminToken }, data: { participantId: legacyHostId, role: "host" }
    });
    expect(recovery.status()).toBe(201);
    const proof = (await recovery.json() as { recoveryCredential: string }).recoveryCredential;
    await expect(page.locator("#room-recovery-panel")).toBeVisible();
    await page.locator("#room-recovery-panel summary").click();
    await page.locator("#room-recovery-credential").fill(proof);
    // Recovery reloads the page, which discards response bodies; keep the sessions the real server issues from here on.
    const recoveredSessions: string[] = [];
    await page.route("**/api/tokens/state", async route => {
      const response = await route.fetch();
      if (response.status() === 200) recoveredSessions.push((await response.json() as { token: string }).token);
      await route.fulfill({ response });
    });
    const recovered = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state" && response.status() === 200);
    await page.locator("#room-recovery-submit").click();
    await recovered;
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.participantId).catch(() => null)).toBe(legacyHostId);
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.access?.role).catch(() => null)).toBe("host");
    // Room materials survive activation: the recovered host still lists the document uploaded before the raise.
    expect(recoveredSessions.length).toBeGreaterThan(0);
    const library = await request.get(`${fixture.origin}/api/rooms/demo-room/documents`, { headers: { authorization: `Bearer ${recoveredSessions.at(-1)}` } });
    expect(library.status()).toBe(200);
    expect((await library.json() as { items: Array<{ documentId: string }> }).items.map(item => item.documentId)).toContain(keptDocument.documentId);
    const download = await request.get(`${fixture.origin}/api/rooms/demo-room/documents/${keptDocument.documentId}/download`,
      { headers: { authorization: `Bearer ${recoveredSessions.at(-1)}` } });
    expect(download.status()).toBe(200);
    expect(Buffer.compare(await download.body(), pdfBytes)).toBe(0);
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

for (const holdSceneAsset of [false, true]) test(holdSceneAsset
  ? "personal owner handoff is observed while recipient scene asset is held"
  : "personal owner hands off to an invited Member with proof and live controls", async ({ page, browser, request }) => {
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
  let releaseSceneAsset: (() => void) | undefined;
  let bootAssetHeld = false;
  if (holdSceneAsset) {
    const held = new Promise<void>(resolve => { releaseSceneAsset = resolve; });
    await recipientPage.route("**/*.glb", async route => {
      const url = new URL(route.request().url());
      // Hold only the scene GLB on this fixture's asset server, not avatars or a remote resource.
      if (url.origin === fixture.assetsOrigin && !url.pathname.includes("/avatars/")) { bootAssetHeld = true; await held; }
      await route.continue().catch(() => undefined);
    });
  }
  const recipientPolls: Array<{ status: number; ownerMatches: boolean; isOwner: boolean; revision: number | null }> = [];
  const recipientMedia: Array<{ status: number; recovery: boolean; changed: boolean }> = [];
  const recipientStartup: Array<{ stage: string; status: number; denied: boolean; recovery: boolean }> = [];
  const ownerMedia: Array<{ status: number; recovery: boolean }> = [];
  let transferTargetMatches = false, transferRevision: number | null = null;
  const observeOriginalOwner = async (response: import("@playwright/test").Response) => {
    try {
      const url = new URL(response.url());
      if (url.origin !== fixture.origin || url.pathname !== "/api/tokens/media") return;
      const body = response.status() >= 400 ? await response.json().catch(() => null) : null;
      ownerMedia.push({ status: response.status(), recovery: body?.reason === "identity_recovery_required" });
      if (ownerMedia.length > 16) ownerMedia.shift();
    } catch { /* never retain credentials or error text */ }
  };
  page.on("response", observeOriginalOwner);
  let observedRoom = "", observedRecipient = "";
  const observeOwnerPoll = async (response: import("@playwright/test").Response) => {
    try {
      const url = new URL(response.url());
      if (url.origin !== fixture.origin && url.origin !== fixture.assetsOrigin) return;
      const stage = url.pathname === "/api/tokens/state" ? "state" : url.pathname === "/health" ? "health"
        : url.pathname === `/api/rooms/${observedRoom}/manifest` ? "manifest"
        : url.pathname.startsWith(`/api/rooms/${observedRoom}/presence/`) ? "presence"
        : url.pathname === `/api/rooms/${observedRoom}/spaces` ? "spaces"
        : url.pathname.includes("/avatars/") ? "avatar" : url.pathname.endsWith("scene.json") ? "scene" : null;
      if (stage && recipientStartup.length < 64) {
        const body = response.status() >= 400 ? await response.json().catch(() => null) : null;
        recipientStartup.push({ stage, status: response.status(), denied: response.status() >= 400,
          recovery: body?.reason === "identity_recovery_required" });
      }
      if (url.origin !== fixture.origin) return;
      if (url.pathname === "/api/tokens/media") {
        const body = await response.json();
        recipientMedia.push({ status: response.status(), recovery: body.reason === "identity_recovery_required", changed: body.reason === "room_state_changed" });
        if (recipientMedia.length > 16) recipientMedia.shift();
        return;
      }
      if (url.pathname !== `/api/rooms/${observedRoom}/session-control`) return;
      const body = await response.json();
      recipientPolls.push({ status: response.status(), ownerMatches: typeof body.ownerParticipantId === "string" && body.ownerParticipantId === observedRecipient,
        isOwner: body.participant?.isOwner === true, revision: Number.isSafeInteger(body.authorityRevision) ? body.authorityRevision : null });
      if (recipientPolls.length > 32) recipientPolls.shift();
    } catch { /* keep only allowlisted scalar observations */ }
  };
  recipientPage.on("response", observeOwnerPoll);
  try {
    await new PostgresStorage(pool).identityProtocol.raise(2);
    const opened = await request.post(`${fixture.origin}/api/personal-room`, {
      data: { identityProtocolVersion: 2, displayName: "Original owner" }
    });
    expect(opened.status()).toBe(201);
    const owner = await opened.json() as { room: { roomId: string }; identityCredential: string; participantId: string };
    observedRoom = owner.room.roomId;
    await page.addInitScript(input => sessionStorage.setItem(`vrata.identity.v2.${encodeURIComponent(input.roomId)}`, input.credential),
      { roomId: owner.room.roomId, credential: owner.identityCredential });
    const personalUrl = `${fixture.origin}/rooms/${owner.room.roomId}?onboard=0`;
    await page.goto(personalUrl, { waitUntil: "domcontentloaded" });
    // The early ownership DTO and socket-open flag precede avatar/scene boot. Exercise live handoff only after the
    // ordinary controls are ready; keep the handoff assertions and their deadlines independent of asset loading.
    await expect(page.locator("#join-audio")).toBeEnabled({ timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.personalRoom?.isOwner)).toBe(true);
    const invitation = await request.post(`${fixture.origin}/api/rooms/${owner.room.roomId}/invites`, {
      headers: { "x-vrata-admin-token": fixture.adminToken }, data: { role: "member", expiresInSeconds: 120 }
    });
    expect(invitation.status()).toBe(201);
    const inviteLink = (await invitation.json() as { inviteLink: string }).inviteLink;
    await recipientPage.goto(`${inviteLink}&onboard=0`, { waitUntil: "domcontentloaded" });
    if (holdSceneAsset) await expect.poll(() => bootAssetHeld, { timeout: 20_000 }).toBe(true);
    else await expect(recipientPage.locator("#join-audio")).toBeEnabled({ timeout: 20_000 });
    await expect.poll(() => recipientPage.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(true);
    const recipientId = await recipientPage.evaluate(() => (window as any).__VRATA_DEBUG__?.participantId) as string;
    observedRecipient = recipientId;
    await page.bringToFront();
    await expect.poll(() => page.locator("#host-participant-select option").evaluateAll((options, target) =>
      options.some(option => (option as HTMLOptionElement).value === target), recipientId), { timeout: 20_000 }).toBe(true);
    await page.locator("#host-participant-select").selectOption(recipientId);
    await expect(page.locator("#transfer-owner")).toBeEnabled({ timeout: 20_000 });
    const transferred = page.waitForResponse(response => new URL(response.url()).pathname === `/api/rooms/${owner.room.roomId}/owner/transfer`);
    await page.locator("#transfer-owner").click();
    const transferResponse = await transferred;
    expect(transferResponse.status()).toBe(200);
    const transferBody = await transferResponse.json();
    transferTargetMatches = transferBody.ownerParticipantId === recipientId;
    transferRevision = Number.isSafeInteger(transferBody.revision) ? transferBody.revision : null;
    expect(transferTargetMatches).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.personalRoom?.isOwner)).toBe(false);
    await recipientPage.bringToFront();
    await expect.poll(() => recipientPage.evaluate(() => (window as any).__VRATA_DEBUG__?.personalRoom?.isOwner),
      { timeout: 20_000 }).toBe(true);
    await expect(recipientPage.locator("#host-controls")).toBeVisible();
    expect(await recipientPage.evaluate(() => (window as any).__VRATA_DEBUG__?.access?.role)).toBe("member");
    releaseSceneAsset?.();
    const recipientAdmission = recipientPage.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state");
    let recipientReloadCommitted = false;
    const observeReloadCommit = (frame: import("@playwright/test").Frame) => {
      if (frame === recipientPage.mainFrame()) recipientReloadCommitted = true;
    };
    recipientPage.on("framenavigated", observeReloadCommit);
    const recipientReloadControl = recipientPage.waitForResponse(response => recipientReloadCommitted && response.request().method() === "GET"
      && new URL(response.url()).pathname === `/api/rooms/${owner.room.roomId}/session-control`);
    await recipientPage.reload({ waitUntil: "domcontentloaded" });
    expect((await recipientAdmission).status()).toBe(200);
    expect((await recipientReloadControl).status()).toBe(200);
    recipientPage.off("framenavigated", observeReloadCommit);
    await expect(recipientPage.locator("#join-audio")).toBeEnabled({ timeout: 20_000 });
    await expect.poll(() => recipientPage.evaluate(() => (window as any).__VRATA_DEBUG__?.personalRoom?.isOwner).catch(() => null)).toBe(true);
  } catch (error) {
    const recipient = await recipientPage.evaluate(() => {
      const debug = (window as any).__VRATA_DEBUG__;
      const gate = document.getElementById("session-upgrade-dialog")?.getBoundingClientRect();
      return { visible: document.visibilityState === "visible",
        connected: debug?.roomStateConnected === true, isOwner: debug?.personalRoom?.isOwner === true,
        personal: debug?.personalRoom?.roomType === "personal",
        sceneLoaded: debug?.sceneDebug?.state === "loaded", hostControlsEnabled: debug?.featureFlags?.hostControlsEnabled === true,
        gateVisible: !!gate && gate.width > 0 && gate.height > 0 };
    }).catch(() => null);
    const originalOwner = await page.evaluate(() => {
      const gate = document.getElementById("session-upgrade-dialog")?.getBoundingClientRect();
      return { isOwner: (window as any).__VRATA_DEBUG__?.personalRoom?.isOwner === true,
        connected: (window as any).__VRATA_DEBUG__?.roomStateConnected === true, gateVisible: !!gate && gate.width > 0 && gate.height > 0 };
    }).catch(() => null);
    await test.info().attach("owner-handoff-readiness", { body: JSON.stringify({ transferTargetMatches, transferRevision, originalOwner, ownerMedia, recipient, polls: recipientPolls, media: recipientMedia, startup: recipientStartup }), contentType: "application/json" });
    throw error;
  } finally {
    releaseSceneAsset?.();
    recipientPage.off("response", observeOwnerPoll);
    page.off("response", observeOriginalOwner);
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
    await storage.roomIdentities.transition(scope, { actorType: "room-session", proof: host.identity, expiresAtSeconds: Math.floor(Date.now() / 1000) + 600 }, 1,
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
