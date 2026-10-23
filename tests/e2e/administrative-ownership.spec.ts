import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "playwright/test";
import { startIsolatedAuthorApi, bearer } from "./plugin-author-scenarios";

test.use({ trace: "off", screenshot: "off", video: "off" });
type Fixture = Awaited<ReturnType<typeof startIsolatedAuthorApi>>;
async function closeFixture(page: Page, fixture?: Fixture) {
  await page.goto("about:blank").catch(() => undefined);
  await fixture?.close();
}
async function openDraft(page: Page, h: Fixture) {
  await page.context().addInitScript(({ token }) => localStorage.setItem("vrata.controlPlaneAdminToken", token),
    { token: h.adminHeaders["x-vrata-admin-token"] });
  await page.goto(`${h.base}/control-plane`);
  await expect(page.locator("#dashboard-content")).toHaveAttribute("data-authorized", "true");
  await page.locator("#new-room").click();
  await page.locator("#template-select").selectOption("personal-room-basic");
  const slug = `ui-personal-${randomUUID().slice(0, 8)}`;
  await page.locator("#room-name-input").fill("Owned administrative workspace");
  await page.locator("#room-slug-input").fill(slug);
  return slug;
}

async function refreshApplied(page: Page): Promise<string | null> {
  const marker = randomUUID();
  const handler = async (route: import("playwright/test").Route) => {
    const response = await route.fetch(), payload = await response.json();
    await route.fulfill({ response, json: { ...payload, refreshAppliedMarker: marker } });
  };
  await page.route("**/api/rooms/*/manifest", handler);
  try {
    await page.locator("#refresh-room-detail").click();
    await expect.poll(() => page.locator("#room-detail").evaluate((el, expected) => {
      try { return JSON.parse(el.textContent ?? "{}").manifest?.refreshAppliedMarker === expected; } catch { return false; }
    }, marker)).toBe(true);
    return await page.locator("#invite-link").getAttribute("href");
  } finally { await page.unroute("**/api/rooms/*/manifest", handler); }
}

/** Holds only the next GET of one room item; later reads and polls pass through. */
async function holdNextRoomRead(page: Page, url: string) {
  let held!: () => void, release!: () => void, stopped = false;
  const entered = new Promise<void>(resolve => { held = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(url, async route => {
    if (route.request().method() !== "GET" || stopped) return route.continue();
    stopped = true; const response = await route.fetch(); held(); await gate; await route.fulfill({ response });
  });
  return { entered, release };
}

async function expectRoomDraftLocked(page: Page) {
  for (const selector of ["#room-name-input", "#primary-color-input", "#accent-color-input", "#feature-voice-input", "#asset-select",
    "#scene-bundle-select", "#avatar-enabled-input", "#avatar-quality-select", "#update-room", "#bind-scene-bundle"]) await expect(page.locator(selector)).toBeDisabled();
}
for (const floor of [1, 2] as const) test(`administrative personal-room form obeys protocol floor ${floor} without granting identity by ID`, async ({ page }) => {
  let fixture: Fixture | undefined;
  try {
    const h = await startIsolatedAuthorApi(floor); fixture = h;
    await h.storage.transitionReferenceTemplateCatalog("active");
    const slug = await openDraft(page, h), owner = page.locator("#room-owner-input");
    if (floor === 1) {
      await expect(owner).toHaveAttribute("required", "");
      await owner.fill("legacy-owner-ui");
    } else {
      await expect(owner).not.toHaveAttribute("required", "");
      await expect(owner).toHaveAttribute("readonly", "");
      await expect(owner).toHaveValue("");
      await expect(page.locator("#template-summary")).toContainText("explicit owner transfer");
    }
    await page.locator("#create-room").click();
    await expect(page.locator("#publish-status")).toContainText(floor === 2 ? "published-member-invite-created" : "published-invite-created");
    const room = await h.storage.getRoom(slug); expect(Boolean(room)).toBe(true);
    expect(room!.ownerParticipantId).toBe(floor === 2 ? null : "legacy-owner-ui");
    expect(room!.visibility).toBe("private"); expect(room!.guestAllowed).toBe(false);
    if (floor === 2) {
      expect(await h.storage.hasRoomIdentityAuthority(slug)).toBe(false);
      const invites = await h.storage.listRoomInvites(slug);
      expect(invites.length).toBe(1); expect(invites[0].role).toBe("member");
      const link = await page.locator("#invite-link").getAttribute("href");
      expect(Boolean(link)).toBe(true);
      const invited = await h.admit(slug, { inviteToken: new URL(link!).searchParams.get("invite") });
      expect(invited.status).toBe(200);
      const recipient = invited.json<{ token: string; participantId: string; isOwner: boolean; role: string }>();
      expect(recipient.isOwner).toBe(false); expect(recipient.role).toBe("member");
      const authority = await h.storage.roomIdentities.authority(room!); expect(Boolean(authority)).toBe(true);
      const handoff = await h.request(`/api/rooms/${slug}/owner/transfer`, "POST", h.adminHeaders,
        { expectedRevision: authority!.revision, participantId: recipient.participantId });
      expect(handoff.status).toBe(200);
      const control = await h.request(`/api/rooms/${slug}/session-control`, "GET", bearer(recipient.token));
      expect(control.status).toBe(200);
      const view = control.json<{ participant: { role: string; isOwner: boolean }; state: { hostParticipantId: string | null } }>();
      expect(view.participant.role).toBe("member"); expect(view.participant.isOwner).toBe(true); expect(view.state.hostParticipantId).toBe(null);
      await page.locator("#room-name-input").fill("Metadata edit after owner handoff");
      await page.locator("#update-room").click();
      await expect.poll(async () => (await h.storage.getRoom(slug))?.name).toBe("Metadata edit after owner handoff");
      expect((await h.storage.getRoom(slug))?.ownerParticipantId).toBe(null);
      const presented = await h.request(`/api/rooms/${slug}`, "GET", h.adminHeaders); expect(presented.status).toBe(200);
      expect(presented.json().currentOwnerParticipantId === recipient.participantId).toBe(true);
      const knownLink = await page.locator("#invite-link").getAttribute("href"); expect(Boolean(knownLink)).toBe(true);
      const refreshedLink = await refreshApplied(page);
      await expect(page.locator("#room-owner-input")).toHaveValue(recipient.participantId);
      expect(refreshedLink === knownLink).toBe(true);
      await page.locator("#create-invite").click();
      await expect(page.locator("#publish-status")).toContainText("invite-created");
      const afterHandoff = await h.storage.listRoomInvites(slug);
      expect(afterHandoff.filter(invite => invite.role === "guest").length).toBe(1);
      const guestLink = await page.locator("#invite-link").getAttribute("href"); expect(Boolean(guestLink)).toBe(true);
      const guestAdmission = await h.admit(slug, { inviteToken: new URL(guestLink!).searchParams.get("invite") }); expect(guestAdmission.status).toBe(200);
      const guest = guestAdmission.json<{ role: string; isOwner: boolean; permissions: string[] }>();
      expect(guest.role).toBe("guest"); expect(guest.isOwner).toBe(false); expect(guest.permissions.includes("notes.edit")).toBe(false);
    }
  } finally { await closeFixture(page, fixture); }
});

test("a stale legacy personal draft refreshes its protocol hint and can retry without sending the old owner ID", async ({ page }) => {
  let fixture: Fixture | undefined;
  try {
    const h = await startIsolatedAuthorApi(1); fixture = h;
    await h.storage.transitionReferenceTemplateCatalog("active");
    const slug = await openDraft(page, h);
    await page.locator("#room-owner-input").fill("stale-legacy-owner");
    await h.storage.identityProtocol.raise(2);
    await page.locator("#create-room").click();
    await expect(page.locator("#publish-status")).toContainText("identity_upgrade_required");
    await expect(page.locator("#room-slug-input")).toHaveValue(slug);
    await expect(page.locator("#room-name-input")).toHaveValue("Owned administrative workspace");
    await expect(page.locator("#room-owner-input")).toHaveAttribute("readonly", "");
    expect(await h.storage.getRoom(slug)).toBe(null);
    await page.locator("#create-room").click();
    await expect(page.locator("#publish-status")).toContainText("published-member-invite-created");
    expect((await h.storage.getRoom(slug))?.ownerParticipantId).toBe(null);
  } finally { await closeFixture(page, fixture); }
});

for (const failure of ["invites", "manifest"] as const) test(`successful room creation survives ${failure} follow-up failure and retry invitation remains Member`, async ({ page }) => {
  let fixture: Fixture | undefined;
  try {
    const h = await startIsolatedAuthorApi(2); fixture = h;
    await h.storage.transitionReferenceTemplateCatalog("active");
    let createdPosts = 0, failedOnce = false;
    page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/rooms") createdPosts += 1; });
    await page.route(`**/api/rooms/*/${failure}`, async route => {
      const relevant = route.request().method() === (failure === "invites" ? "POST" : "GET");
      if (relevant && !failedOnce) {
        failedOnce = true;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture_followup_unavailable" }) });
      } else await route.continue();
    });
    const slug = await openDraft(page, h);
    await page.locator("#create-room").click();
    await expect(page.locator("#publish-status")).toContainText("published-followup-failed");
    expect(failedOnce).toBe(true); expect(createdPosts).toBe(1);
    const room = await h.storage.getRoom(slug); expect(Boolean(room)).toBe(true); expect(room!.ownerParticipantId).toBe(null);
    const link = await page.locator("#room-link").getAttribute("href");
    expect(Boolean(link && new URL(link).pathname === `/rooms/${slug}`)).toBe(true);
    await page.locator("#create-invite").click();
    await expect(page.locator("#publish-status")).toContainText("invite-created");
    const invites = await h.storage.listRoomInvites(slug);
    expect(invites.length).toBe(1); expect(invites[0].role).toBe("member"); expect(createdPosts).toBe(1);
    const inviteLink = await page.locator("#invite-link").getAttribute("href"); expect(Boolean(inviteLink)).toBe(true);
    const refreshedLink = await refreshApplied(page); expect(refreshedLink === inviteLink).toBe(true);
    const admitted = await h.admit(slug, { inviteToken: new URL(refreshedLink!).searchParams.get("invite") }); expect(admitted.status).toBe(200);
    const recipient = admitted.json<{ participantId: string; token: string; role: string; isOwner: boolean }>();
    expect(recipient.role).toBe("member"); expect(recipient.isOwner).toBe(false);
    const authority = await h.storage.roomIdentities.authority(room!); expect(Boolean(authority)).toBe(true);
    const handoff = await h.request(`/api/rooms/${slug}/owner/transfer`, "POST", h.adminHeaders,
      { expectedRevision: authority!.revision, participantId: recipient.participantId }); expect(handoff.status).toBe(200);
    const control = await h.request(`/api/rooms/${slug}/session-control`, "GET", bearer(recipient.token)); expect(control.status).toBe(200);
    const view = control.json<{ participant: { role: string; isOwner: boolean; permissions: string[] } }>();
    expect(view.participant.role).toBe("member"); expect(view.participant.isOwner).toBe(true);
    expect(view.participant.permissions.includes("notes.edit")).toBe(true);
  } finally { await closeFixture(page, fixture); }
});

test("an older refresh cannot discard the one-time link of an invitation created while it was waiting", async ({ page }) => {
  let fixture: Fixture | undefined, release!: () => void;
  try {
    const h = await startIsolatedAuthorApi(2); fixture = h; await h.storage.transitionReferenceTemplateCatalog("active");
    await openDraft(page, h); await page.locator("#create-room").click();
    await expect(page.locator("#publish-status")).toContainText("published-member-invite-created");
    let held!: () => void, captured!: () => void;
    const entered = new Promise<void>(resolve => { held = resolve; }), listed = new Promise<void>(resolve => { captured = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let stopped = false, observed = false; const marker = randomUUID();
    await page.route("**/api/rooms/*/manifest", async route => {
      if (stopped) return route.continue();
      stopped = true; const response = await route.fetch(), payload = await response.json(); held(); await gate;
      await route.fulfill({ response, json: { ...payload, refreshAppliedMarker: marker } });
    });
    await page.route("**/api/rooms/*/invites", async route => {
      if (route.request().method() !== "GET" || observed) return route.continue();
      observed = true; const response = await route.fetch(), payload = await response.json();
      expect(Array.isArray(payload.items) && payload.items.length === 1).toBe(true);
      await route.fulfill({ response }); captured();
    });
    await page.locator("#refresh-room-detail").click(); await Promise.all([entered, listed]);
    await page.locator("#create-invite").click(); await expect(page.locator("#publish-status")).toContainText("invite-created");
    const newLink = await page.locator("#invite-link").getAttribute("href"); expect(Boolean(newLink && newLink !== "#")).toBe(true);
    release();
    await expect.poll(() => page.locator("#room-detail").evaluate((el, expected) => {
      try { return JSON.parse(el.textContent ?? "{}").manifest?.refreshAppliedMarker === expected; } catch { return false; }
    }, marker)).toBe(true);
    expect((await page.locator("#invite-link").getAttribute("href")) === newLink).toBe(true);
    await expect(page.locator("#invite-select option")).toHaveCount(2);
  } finally { release?.(); await closeFixture(page, fixture); }
});

test("revoke targets the selected invite and removes its link even when the following list read fails", async ({ page }) => {
  let fixture: Fixture | undefined;
  try {
    const h = await startIsolatedAuthorApi(2); fixture = h; await h.storage.transitionReferenceTemplateCatalog("active");
    const slug = await openDraft(page, h); await page.locator("#create-room").click();
    await expect(page.locator("#publish-status")).toContainText("published-member-invite-created");
    const original = (await h.storage.listRoomInvites(slug))[0];
    await page.locator("#create-invite").click(); await expect(page.locator("#publish-status")).toContainText("invite-created");
    await expect(page.locator("#invite-select option")).toHaveCount(2);
    await page.locator("#invite-select").selectOption(original.inviteId);
    await page.route("**/api/rooms/*/invites", async route => {
      if (route.request().method() === "GET") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture_refresh_unavailable" }) });
      else await route.continue();
    });
    await page.locator("#revoke-invite").click(); await expect(page.locator("#publish-status")).toContainText("invite-revoked");
    const records = await h.storage.listRoomInvites(slug);
    expect(Boolean(records.find(invite => invite.inviteId === original.inviteId)?.revokedAt)).toBe(true);
    expect(records.filter(invite => invite.inviteId !== original.inviteId).every(invite => !invite.revokedAt)).toBe(true);
    await expect(page.locator("#invite-select")).toHaveValue(original.inviteId);
    await expect(page.locator(`#invite-select option[value="${original.inviteId}"]`)).toContainText("[revoked]");
    await expect.poll(async () => (await page.locator("#invite-link").getAttribute("href")) === "#").toBe(true);
  } finally { await closeFixture(page, fixture); }
});

test("a known invitation link expires on a poll render while list reads keep failing and its metadata stays selected", async ({ page }) => {
  let fixture: Fixture | undefined, forwarded!: () => void;
  try {
    const h = await startIsolatedAuthorApi(2); fixture = h; await h.storage.transitionReferenceTemplateCatalog("active");
    // Only the browser clock moves; the server retains real time and the stored expiry.
    await page.clock.install();
    const slug = await openDraft(page, h); await page.locator("#create-room").click();
    await expect(page.locator("#publish-status")).toContainText("published-member-invite-created");
    const invite = (await h.storage.listRoomInvites(slug))[0];
    const knownLink = await page.locator("#invite-link").getAttribute("href"); expect(Boolean(knownLink && knownLink !== "#")).toBe(true);
    let failedLists = 0;
    await page.route("**/api/rooms/*/invites", async route => {
      if (route.request().method() !== "GET") return route.continue();
      failedLists += 1; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture_list_unavailable" }) });
    });
    expect((await refreshApplied(page)) === knownLink).toBe(true); expect(failedLists > 0).toBe(true);
    const afterForward = new Promise<void>(resolve => { forwarded = resolve; }), marker = randomUUID();
    await page.route("**/api/rooms/*/manifest", async route => {
      const response = await route.fetch(), payload = await response.json(); await afterForward;
      await route.fulfill({ response, json: { ...payload, refreshAppliedMarker: marker } });
    });
    await page.clock.fastForward(Date.parse(invite.expiresAt) - Date.now() + 60_000); forwarded();
    await expect.poll(() => page.locator("#room-detail").evaluate((el, expected) => {
      try { return JSON.parse(el.textContent ?? "{}").manifest?.refreshAppliedMarker === expected; } catch { return false; }
    }, marker), { timeout: 15000 }).toBe(true);
    await expect(page.locator("#invite-select")).toHaveValue(invite.inviteId);
    await expect(page.locator(`#invite-select option[value="${invite.inviteId}"]`)).toContainText(`expires:${invite.expiresAt}`);
    expect((await page.locator("#invite-link").getAttribute("href")) === "#").toBe(true);
    expect((await page.locator("#invite-link").textContent()) === "").toBe(true);
    expect(await page.locator("#room-detail").evaluate(el => {
      try { return (JSON.parse(el.textContent ?? "{}").invites ?? []).some((item: { inviteLink?: string }) => Boolean(item.inviteLink)); } catch { return true; }
    })).toBe(false);
  } finally { forwarded?.(); await closeFixture(page, fixture); }
});

test("a failed older poll cannot restore a link revoked externally and observed by a newer poll", async ({ page }) => {
  let fixture: Fixture | undefined, release!: () => void;
  try {
    const h = await startIsolatedAuthorApi(2); fixture = h; await h.storage.transitionReferenceTemplateCatalog("active");
    const slug = await openDraft(page, h); await page.locator("#create-room").click();
    await expect(page.locator("#publish-status")).toContainText("published-member-invite-created");
    const invite = (await h.storage.listRoomInvites(slug))[0];
    let held!: () => void, failed!: () => void;
    const entered = new Promise<void>(resolve => { held = resolve; }), listFailed = new Promise<void>(resolve => { failed = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const oldMarker = randomUUID(), newMarker = randomUUID(); let manifests = 0, failedOnce = false;
    await page.route("**/api/rooms/*/manifest", async route => {
      const index = manifests++, response = await route.fetch(), payload = await response.json();
      if (index === 0) { held(); await gate; }
      await route.fulfill({ response, json: { ...payload, refreshAppliedMarker: index === 0 ? oldMarker : newMarker } });
    });
    await page.route("**/api/rooms/*/invites", async route => {
      if (route.request().method() === "GET" && !failedOnce) {
        failedOnce = true;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture_old_read_failed" }) }); failed();
      } else await route.continue();
    });
    // Actual 5-second polling preserves the selection generation across both reads.
    await Promise.all([entered, listFailed]);
    const revoked = await h.request(`/api/rooms/${slug}/invites/${invite.inviteId}/revoke`, "POST", h.adminHeaders); expect(revoked.status).toBe(200);
    await expect.poll(() => page.locator("#room-detail").evaluate((el, expected) => {
      try { return JSON.parse(el.textContent ?? "{}").manifest?.refreshAppliedMarker === expected; } catch { return false; }
    }, newMarker), { timeout: 15000 }).toBe(true);
    await expect(page.locator(`#invite-select option[value="${invite.inviteId}"]`)).toContainText("[revoked]");
    release();
    await expect.poll(() => page.locator("#room-detail").evaluate((el, expected) => {
      try { return JSON.parse(el.textContent ?? "{}").manifest?.refreshAppliedMarker === expected; } catch { return false; }
    }, oldMarker)).toBe(true);
    await expect(page.locator(`#invite-select option[value="${invite.inviteId}"]`)).toContainText("[revoked]");
    expect((await page.locator("#invite-link").getAttribute("href")) === "#").toBe(true);
  } finally { release?.(); await closeFixture(page, fixture); }
});

test("ordered successful polls and a delayed create ACK cannot undo an externally confirmed revoke", async ({ page }) => {
  let fixture: Fixture | undefined, releasePoll!: () => void, releaseCreate!: () => void;
  try {
    const h = await startIsolatedAuthorApi(2); fixture = h; await h.storage.transitionReferenceTemplateCatalog("active");
    const slug = await openDraft(page, h); await page.locator("#create-room").click();
    await expect(page.locator("#publish-status")).toContainText("published-member-invite-created");
    let created!: () => void, held!: () => void, listed!: () => void;
    const persisted = new Promise<void>(resolve => { created = resolve; }), entered = new Promise<void>(resolve => { held = resolve; });
    const oldListCaptured = new Promise<void>(resolve => { listed = resolve; });
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve; }), pollGate = new Promise<void>(resolve => { releasePoll = resolve; });
    let delayedId = "", manifests = 0, captured = false;
    const oldMarker = randomUUID(), newMarker = randomUUID();
    await page.route("**/api/rooms/*/invites", async route => {
      if (route.request().method() === "POST" && !delayedId) {
        const response = await route.fetch(), payload = await response.json(); delayedId = payload.inviteId; created(); await createGate;
        await route.fulfill({ response }); return;
      }
      if (route.request().method() === "GET" && !captured && delayedId) {
        captured = true; const response = await route.fetch(), payload = await response.json();
        expect(payload.items.some((invite: { inviteId: string; revokedAt?: string }) => invite.inviteId === delayedId && !invite.revokedAt)).toBe(true);
        await route.fulfill({ response }); listed(); return;
      }
      await route.continue();
    });
    await page.locator("#create-invite").click(); await persisted;
    await page.route("**/api/rooms/*/manifest", async route => {
      const index = manifests++, response = await route.fetch(), payload = await response.json();
      if (index === 0) { held(); await pollGate; }
      await route.fulfill({ response, json: { ...payload, refreshAppliedMarker: index === 0 ? oldMarker : newMarker } });
    });
    await Promise.all([entered, oldListCaptured]);
    expect((await h.request(`/api/rooms/${slug}/invites/${delayedId}/revoke`, "POST", h.adminHeaders)).status).toBe(200);
    await expect.poll(() => page.locator("#room-detail").evaluate((el, marker) => {
      try { return JSON.parse(el.textContent ?? "{}").manifest?.refreshAppliedMarker === marker; } catch { return false; }
    }, newMarker), { timeout: 15000 }).toBe(true);
    await expect(page.locator(`#invite-select option[value="${delayedId}"]`)).toContainText("[revoked]");
    releasePoll();
    await expect.poll(() => page.locator("#room-detail").evaluate((el, marker) => {
      try { return JSON.parse(el.textContent ?? "{}").manifest?.refreshAppliedMarker === marker; } catch { return false; }
    }, oldMarker)).toBe(true);
    await expect(page.locator(`#invite-select option[value="${delayedId}"]`)).toContainText("[revoked]");
    releaseCreate(); await expect(page.locator("#publish-status")).toContainText("invite-created");
    await expect(page.locator("#invite-select")).toHaveValue(delayedId);
    await expect(page.locator(`#invite-select option[value="${delayedId}"]`)).toContainText("[revoked]");
    expect((await page.locator("#invite-link").getAttribute("href")) === "#").toBe(true);
  } finally { releasePoll?.(); releaseCreate?.(); await closeFixture(page, fixture); }
});

test("completion of an older poll cannot replace the Owner already observed after handoff", async ({ page }) => {
  let fixture: Fixture | undefined, release!: () => void;
  try {
    const h = await startIsolatedAuthorApi(2); fixture = h; await h.storage.transitionReferenceTemplateCatalog("active");
    const slug = await openDraft(page, h); await page.locator("#create-room").click();
    await expect(page.locator("#publish-status")).toContainText("published-member-invite-created");
    const link = await page.locator("#invite-link").getAttribute("href"); expect(Boolean(link)).toBe(true);
    const response = await h.admit(slug, { inviteToken: new URL(link!).searchParams.get("invite") }); expect(response.status).toBe(200);
    const recipient = response.json<{ participantId: string }>();
    let held!: () => void;
    const entered = new Promise<void>(resolve => { held = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const oldMarker = randomUUID(), newMarker = randomUUID(); let count = 0;
    await page.route("**/api/rooms/*/manifest", async route => {
      const index = count++, returned = await route.fetch(), payload = await returned.json();
      if (index === 0) { held(); await gate; }
      await route.fulfill({ response: returned, json: { ...payload, refreshAppliedMarker: index === 0 ? oldMarker : newMarker } });
    });
    await entered;
    const authority = await h.storage.roomIdentities.authority({ tenantId: "demo-tenant", roomId: slug }); expect(Boolean(authority)).toBe(true);
    expect((await h.request(`/api/rooms/${slug}/owner/transfer`, "POST", h.adminHeaders,
      { participantId: recipient.participantId, expectedRevision: authority!.revision })).status).toBe(200);
    await expect.poll(() => page.locator("#room-detail").evaluate((el, marker) => {
      try { return JSON.parse(el.textContent ?? "{}").manifest?.refreshAppliedMarker === marker; } catch { return false; }
    }, newMarker), { timeout: 15000 }).toBe(true);
    await expect(page.locator("#room-owner-input")).toHaveValue(recipient.participantId);
    release();
    await expect.poll(() => page.locator("#room-detail").evaluate((el, marker) => {
      try { return JSON.parse(el.textContent ?? "{}").manifest?.refreshAppliedMarker === marker; } catch { return false; }
    }, oldMarker)).toBe(true);
    await expect(page.locator("#room-owner-input")).toHaveValue(recipient.participantId);
  } finally { release?.(); await closeFixture(page, fixture); }
});

test("a reordered item GET keeps the newer Owner and its subsequent invitation defaults to Guest", async ({ page }) => {
  let fixture: Fixture | undefined, release!: () => void;
  try {
    const h = await startIsolatedAuthorApi(2); fixture = h; await h.storage.transitionReferenceTemplateCatalog("active");
    const slug = await openDraft(page, h); await page.locator("#create-room").click();
    await expect(page.locator("#publish-status")).toContainText("published-member-invite-created");
    const link = await page.locator("#invite-link").getAttribute("href"); expect(Boolean(link)).toBe(true);
    const admitted = await h.admit(slug, { inviteToken: new URL(link!).searchParams.get("invite") }); expect(admitted.status).toBe(200);
    const recipient = admitted.json<{ participantId: string }>();
    let held!: () => void;
    const entered = new Promise<void>(resolve => { held = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    let stopped = false, manifests = 0; const newer = randomUUID(), older = randomUUID();
    await page.route(`${h.base}/api/rooms/${slug}`, async route => {
      if (route.request().method() !== "GET" || stopped) return route.continue();
      stopped = true; const response = await route.fetch(), payload = await response.json();
      expect(payload.currentOwnerParticipantId === null).toBe(true); held(); await gate; await route.fulfill({ response });
    });
    await page.route("**/api/rooms/*/manifest", async route => {
      const index = manifests++, response = await route.fetch(), payload = await response.json();
      await route.fulfill({ response, json: { ...payload, refreshAppliedMarker: index === 0 ? newer : older } });
    });
    await entered;
    const authority = await h.storage.roomIdentities.authority({ tenantId: "demo-tenant", roomId: slug }); expect(Boolean(authority)).toBe(true);
    expect((await h.request(`/api/rooms/${slug}/owner/transfer`, "POST", h.adminHeaders,
      { participantId: recipient.participantId, expectedRevision: authority!.revision })).status).toBe(200);
    await expect.poll(() => page.locator("#room-detail").evaluate((el, marker) => {
      try { return JSON.parse(el.textContent ?? "{}").manifest?.refreshAppliedMarker === marker; } catch { return false; }
    }, newer), { timeout: 15000 }).toBe(true);
    await expect(page.locator("#room-owner-input")).toHaveValue(recipient.participantId);
    release();
    await expect.poll(() => page.locator("#room-detail").evaluate((el, marker) => {
      try { return JSON.parse(el.textContent ?? "{}").manifest?.refreshAppliedMarker === marker; } catch { return false; }
    }, older)).toBe(true);
    await expect(page.locator("#room-owner-input")).toHaveValue(recipient.participantId);
    await page.locator("#create-invite").click(); await expect(page.locator("#publish-status")).toContainText("invite-created");
    expect((await h.storage.listRoomInvites(slug)).filter(invite => invite.role === "guest").length).toBe(1);
  } finally { release?.(); await closeFixture(page, fixture); }
});

test("a poll overtaking normal room selection cannot leave the previous room's editable fields", async ({ page }) => {
  let fixture: Fixture | undefined, release!: () => void;
  try {
    const h = await startIsolatedAuthorApi(2); fixture = h; await h.storage.transitionReferenceTemplateCatalog("active");
    const slugA = await openDraft(page, h); await page.locator("#create-room").click();
    await expect(page.locator("#publish-status")).toContainText("published-member-invite-created");
    const slugB = await openDraft(page, h); await page.locator("#room-name-input").fill("Second room form data");
    await page.locator("#create-room").click(); await expect(page.locator("#publish-status")).toContainText("published-member-invite-created");
    await page.locator("#rooms-list button").filter({ hasText: "Owned administrative workspace" }).click();
    await expect(page.locator("#room-slug-input")).toHaveValue(slugA);
    let held!: () => void;
    const entered = new Promise<void>(resolve => { held = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    let stopped = false; const marker = randomUUID();
    await page.route(`${h.base}/api/rooms/${slugB}`, async route => {
      if (route.request().method() !== "GET" || stopped) return route.continue();
      stopped = true; const response = await route.fetch(); held(); await gate; await route.fulfill({ response });
    });
    await page.route("**/api/rooms/*/manifest", async route => {
      const response = await route.fetch(), payload = await response.json(); await route.fulfill({ response, json: { ...payload, refreshAppliedMarker: marker } });
    });
    await page.locator("#rooms-list button").filter({ hasText: "Second room form data" }).click(); await entered;
    await expect(page.locator("#update-room")).toBeDisabled();
    await expect(page.locator("#room-name-input")).toBeDisabled();
    await expect.poll(() => page.locator("#room-detail").evaluate((el, expected) => {
      try { const value = JSON.parse(el.textContent ?? "{}"); return value.room?.roomId === expected.slug && value.manifest?.refreshAppliedMarker === expected.marker; } catch { return false; }
    }, { slug: slugB, marker }), { timeout: 15000 }).toBe(true);
    await expect(page.locator("#update-room")).toBeDisabled();
    await expect(page.locator("#room-name-input")).toBeDisabled();
    release(); await expect(page.locator("#room-slug-input")).toHaveValue(slugB);
    await expect(page.locator("#room-name-input")).toHaveValue("Second room form data");
    await expect(page.locator("#update-room")).toBeEnabled();
    await expect(page.locator("#room-name-input")).toBeEnabled();
    const patched = page.waitForResponse(response => response.request().method() === "PATCH" && response.url() === `${h.base}/api/rooms/${slugB}`);
    await page.locator("#update-room").click();
    const update = await patched; expect(update.status()).toBe(200);
    expect(update.request().postDataJSON().name).toBe("Second room form data");
    expect((await h.storage.getRoom(slugB))?.name).toBe("Second room form data");
    expect((await h.storage.getRoom(slugA))?.name).toBe("Owned administrative workspace");
  } finally { release?.(); await closeFixture(page, fixture); }
});

test("an edit started before created or reselected room fields hydrate is applied after them and persisted by Update", async ({ page }) => {
  let fixture: Fixture | undefined; const releases: Array<() => void> = [];
  try {
    const h = await startIsolatedAuthorApi(2); fixture = h; await h.storage.transitionReferenceTemplateCatalog("active");
    const slug = await openDraft(page, h), roomUrl = `${h.base}/api/rooms/${slug}`, name = page.locator("#room-name-input");
    // No room is selected in the draft, so polls cannot claim the held read before creation selects the room.
    const created = await holdNextRoomRead(page, roomUrl); releases.push(created.release);
    const posted = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/rooms");
    await page.locator("#create-room").click(); expect((await posted).status()).toBe(201); await created.entered;
    await expect(page.locator("#publish-status")).toHaveText("published"); await expectRoomDraftLocked(page);
    let renamed = false; const rename = name.fill("Updated owned workspace").then(() => { renamed = true; });
    await expect(name).toBeDisabled(); expect(renamed).toBe(false);
    created.release(); await rename;
    await expect(page.locator("#publish-status")).toContainText("published-member-invite-created");
    await expect(name).toHaveValue("Updated owned workspace");
    await page.locator("#primary-color-input").fill("#22aa88");
    const patched = page.waitForResponse(response => response.request().method() === "PATCH" && response.url() === roomUrl);
    await page.locator("#update-room").click();
    const update = await patched; expect(update.status()).toBe(200);
    const updated = await update.json(); expect(updated.name).toBe("Updated owned workspace"); expect(updated.theme.primaryColor).toBe("#22aa88");
    const stored = await h.storage.getRoom(slug); expect(stored?.name).toBe("Updated owned workspace"); expect(stored?.theme?.primaryColor).toBe("#22aa88");
    await expect(page.locator("#publish-status")).toContainText("updated"); await expect(page.locator("#update-room")).toBeEnabled();
    await page.locator("#new-room").click();
    await expect(name).toBeEnabled(); await expect(page.locator("#primary-color-input")).toBeEnabled();
    const reselected = await holdNextRoomRead(page, roomUrl); releases.push(reselected.release);
    await page.locator("#rooms-list button").filter({ hasText: "Updated owned workspace" }).click(); await reselected.entered;
    await expectRoomDraftLocked(page);
    let edited = false; const edit = name.fill("Reselected workspace name").then(() => { edited = true; });
    await expect(name).toBeDisabled(); expect(edited).toBe(false);
    reselected.release(); await edit;
    await expect(page.locator("#room-slug-input")).toHaveValue(slug); await expect(name).toHaveValue("Reselected workspace name");
    await page.locator("#accent-color-input").fill("#132a46");
    const repatched = page.waitForResponse(response => response.request().method() === "PATCH" && response.url() === roomUrl);
    await page.locator("#update-room").click();
    const reupdate = await repatched; expect(reupdate.status()).toBe(200);
    const body = await reupdate.json(); expect(body.name).toBe("Reselected workspace name");
    expect(body.theme.accentColor).toBe("#132a46"); expect(body.theme.primaryColor).toBe("#22aa88");
    expect((await h.storage.getRoom(slug))?.name).toBe("Reselected workspace name");
  } finally { releases.forEach(release => release()); await closeFixture(page, fixture); }
});
