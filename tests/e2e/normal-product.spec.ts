import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { inlineSceneBundleUrl } from "./scene-bundle-fixtures.js";
import type { RuntimeTestApi } from "../../apps/runtime-web/src/testing/runtime-test-api.js";

type Debug = {
  participantId: string;
  roomStateConnected: boolean;
  currentSeatId: string | null;
  seatOccupancy: Record<string, string>;
  localPose: { root: { x: number; y: number; z: number }; head: { y: number } };
  sceneDebug: { state: string; camera: { world: { x: number; y: number; z: number } } };
  mediaObjects: { physicalSurfaceIdsWithoutLogicalState: string[]; surfaces: Array<{ surfaceId: string; activeObjectType: string | null; textureId: string | null }> };
  markdownBoard: { notes: Array<{ text: string }> };
  avatarTransportPreview?: { poseFrame: { head: { y: number } } };
};

function fixtureBundle() {
  const inline = inlineSceneBundleUrl({ sceneId: "normal-product-regression", label: "Normal product regression", spawn: { x: 0, y: 0, z: 4 }, spawnYaw: 0 });
  const manifest = JSON.parse(decodeURIComponent(inline.slice(inline.indexOf(",") + 1)));
  manifest.anchors = { teleportFloorY: 0, seatAnchors: [-1, 0, 1].map((x, index) => ({ id: `seat-${index}`, position: { x, y: 0, z: 1 }, seatHeight: .48, yaw: 0, radius: .35 })) };
  manifest.mediaSurfaces = ["workspace-main", "desk-aux"].map((surfaceId, i) => ({ surfaceId, label: surfaceId, kind: "wall", widthM: 1.6, heightM: .9, widthPx: 1280, heightPx: 720, visible: true, allowedObjectTypes: ["markdown-board"], transform: { x: i * 2 - 1, y: 1.3, z: -.5, yaw: 0, pitch: 0, roll: 0 } }));
  return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
}

async function readDebug(page: Page): Promise<Debug> {
  return page.evaluate(() => {
    const d = (window as Window & { __VRATA_DEBUG__: Debug }).__VRATA_DEBUG__;
    return { participantId: d.participantId, roomStateConnected: d.roomStateConnected, currentSeatId: d.currentSeatId, seatOccupancy: d.seatOccupancy, localPose: d.localPose, sceneDebug: d.sceneDebug && { state: d.sceneDebug.state, camera: d.sceneDebug.camera }, mediaObjects: d.mediaObjects && { physicalSurfaceIdsWithoutLogicalState: d.mediaObjects.physicalSurfaceIdsWithoutLogicalState, surfaces: d.mediaObjects.surfaces }, markdownBoard: d.markdownBoard, avatarTransportPreview: d.avatarTransportPreview };
  });
}

async function verifyNormalProduct({ page, request }: { page: Page; request: APIRequestContext }, staging: boolean) {
  const token = process.env.STAGING_ADMIN_TOKEN ?? (staging ? "" : "test-admin-token");
  expect(token, "admin token required for isolated regression room").not.toBe("");
  const headers = { "x-vrata-admin-token": token };
  const created = await request.post("/api/rooms", { headers, data: { tenantId: "demo-tenant", templateId: "personal-workspace-basic", name: "Normal product regression", guestAllowed: true, sceneBundleUrl: fixtureBundle(), avatarConfig: { avatarsEnabled: true, avatarSeatsEnabled: true, avatarFallbackCapsulesEnabled: false } } });
  expect(created.ok()).toBe(true);
  const { roomId } = await created.json();
  const observer = await page.context().newPage();
  try {
    const invite = await request.post(`/api/rooms/${roomId}/invites`, { headers, data: { role: "host", expiresInSeconds: 600 } });
    expect(invite.ok()).toBe(true);
    const link = new URL((await invite.json()).inviteLink);
    link.searchParams.set("debug", "1"); link.searchParams.set("scenefit", "0");
    await page.goto(`${link.pathname}${link.search}`);
    if (await page.locator("#guest-onboarding").isVisible()) {
      await page.locator("#guest-name-input").fill("Regression host");
      await page.locator("#guest-enter-without-audio").click();
    }
    await expect.poll(async () => (await readDebug(page)).sceneDebug?.state, { timeout: 30_000 }).toBe("loaded");
    await expect.poll(async () => (await readDebug(page)).roomStateConnected, { timeout: 20_000 }).toBe(true);
    const participantId = (await readDebug(page)).participantId;
    await observer.addInitScript(() => sessionStorage.setItem("vrata.participantId", `observer-${crypto.randomUUID()}`));
    await observer.goto(`/rooms/${roomId}?debug=1&scenefit=0`);
    if (await observer.locator("#guest-onboarding").isVisible()) {
      await observer.locator("#guest-name-input").fill("Regression observer");
      await observer.locator("#guest-enter-without-audio").click();
    }
    await expect.poll(async () => (await readDebug(observer)).roomStateConnected, { timeout: 20_000 }).toBe(true);
    expect((await readDebug(observer)).participantId).not.toBe(participantId);
    for (let i = 0; i < 3; i++) {
      const seatId = `seat-${i}`;
      expect(await page.evaluate(id => (window as Window & { __VRATA_TEST__: RuntimeTestApi }).__VRATA_TEST__.requestSeatClaimById(id), seatId)).toBe(true);
      await expect.poll(async () => (await readDebug(observer)).seatOccupancy[seatId], { timeout: 15_000 }).toBe(participantId);
      await expect.poll(async () => (await readDebug(page)).sceneDebug.camera.world.y, { timeout: 15_000 }).toBeCloseTo(1.2, 2);
      expect((await readDebug(page)).localPose.head.y).toBeCloseTo(1.2, 2);
      await expect.poll(async () => (await readDebug(page)).avatarTransportPreview?.poseFrame.head.y, { timeout: 15_000 }).toBeCloseTo(1.2, 2);
      const before = (await readDebug(page)).localPose.root;
      await page.keyboard.down("w"); await page.waitForTimeout(200); await page.keyboard.up("w");
      expect((await readDebug(page)).localPose.root).toEqual(before);
      expect(await page.evaluate(() => (window as Window & { __VRATA_TEST__: RuntimeTestApi }).__VRATA_TEST__.teleportToFloor(0, 4))).toBe(true);
      await expect.poll(async () => (await readDebug(observer)).seatOccupancy[seatId] ?? null, { timeout: 15_000 }).toBe(null);
      // Keep polling through broadcasts from the observer; a stale snapshot must
      // not reapply the old seat after the initial teleport succeeded.
      await page.waitForTimeout(300);
      await expect.poll(async () => (await readDebug(page)).localPose.root, { timeout: 15_000 }).toMatchObject({ x: 0, y: 0, z: 4 });
    }
    expect((await readDebug(page)).mediaObjects.physicalSurfaceIdsWithoutLogicalState).toEqual([]);
    for (const surfaceId of ["workspace-main", "desk-aux"]) {
      expect(await page.evaluate(id => (window as Window & { __VRATA_TEST__: RuntimeTestApi }).__VRATA_TEST__.createMarkdownBoardObject(id), surfaceId)).toBe(true);
      await expect.poll(async () => (await readDebug(observer)).mediaObjects.surfaces.find(s => s.surfaceId === surfaceId)?.activeObjectType, { timeout: 15_000 }).toBe("markdown-board");
      expect(await page.evaluate(id => (window as Window & { __VRATA_TEST__: RuntimeTestApi }).__VRATA_TEST__.createStickyNote({ text: `Visible ${id}`, surfaceId: id, x: .25, y: .25 }), surfaceId)).toBe(true);
      expect(await observer.evaluate(id => (window as Window & { __VRATA_TEST__: RuntimeTestApi }).__VRATA_TEST__.selectMediaSurface(id), surfaceId)).toBe(true);
      await expect.poll(async () => (await readDebug(observer)).markdownBoard.notes.map(n => n.text), { timeout: 15_000 }).toContain(`Visible ${surfaceId}`);
      await expect.poll(() => observer.evaluate(id => (window as Window & { __VRATA_TEST__: RuntimeTestApi }).__VRATA_TEST__.getMediaCanvasRuntimeKinds(id), surfaceId), { timeout: 15_000 }).toContain("markdown-board");
      const pixels = await observer.evaluate(id => (window as Window & { __VRATA_TEST__: RuntimeTestApi }).__VRATA_TEST__.sampleMediaSurfaceTexture(id, { u: .5, v: .5 }, { width: 1, height: 1 }), surfaceId);
      expect(pixels?.samples.length).toBeGreaterThan(0);
      expect((await readDebug(observer)).mediaObjects.surfaces.find(s => s.surfaceId === surfaceId)?.textureId).toBeTruthy();
    }
  } finally {
    await observer.close();
    await page.goto("about:blank");
    expect((await request.delete(`/api/rooms/${roomId}`, { headers })).ok()).toBe(true);
  }
}

test("normal product seats and scene-owned media surfaces", async ({ page, request }) => {
  test.setTimeout(120_000);
  await verifyNormalProduct({ page, request }, false);
});

test("@staging normal product seats and scene-owned media surfaces", async ({ page, request }) => {
  test.setTimeout(120_000);
  await verifyNormalProduct({ page, request }, true);
});
