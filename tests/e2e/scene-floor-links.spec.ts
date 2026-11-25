import { expect, test, type Page } from "@playwright/test";
import { inlineSceneBundleUrl } from "./scene-bundle-fixtures.js";
import { completeGuestEntry } from "./guest-entry";

const lowerY = 0.001;
const upperY = 3.201;

function encodeData(type: string, value: unknown): string {
  return `data:${type},${encodeURIComponent(JSON.stringify(value))}`;
}

function twoFloorsBundle(): string {
  const inline = inlineSceneBundleUrl({
    sceneId: "two-floors", label: "Two floors",
    spawn: { x: 0, y: lowerY, z: 6 }, spawnYaw: 0
  });
  const manifest = JSON.parse(decodeURIComponent(inline.slice(inline.indexOf(",") + 1)));
  const gltf = JSON.parse(decodeURIComponent(manifest.glbPath.slice(manifest.glbPath.indexOf(",") + 1)));
  // The centre ray can hit this link on either level; a ray toward the floor passes below it.
  Object.assign(gltf.nodes[0], { name: "stairs", translation: [0, 1.2, 0], scale: [1, 2.2, 1] });
  manifest.glbPath = encodeData("model/gltf+json", gltf);
  const area = { minX: -2, maxX: 2, minZ: 1, maxZ: 8 };
  manifest.anchors = {
    teleportFloorY: lowerY,
    floorAreas: [{ ...area, y: lowerY }, { ...area, y: upperY }],
    floorLinks: [
      { node: "stairs", fromY: lowerY, destination: { x: 0, y: upperY, z: 6 } },
      { node: "stairs", fromY: upperY, destination: { x: 0, y: lowerY, z: 6 } }
    ]
  };
  return encodeData("application/json", manifest);
}

type Debug = {
  sceneDebug?: { state: string };
  localPose?: { root: { y: number; z: number } };
  interactionRay?: { targetKind: string; point: { z: number } | null };
};

async function debug(page: Page): Promise<Debug | undefined> {
  return page.evaluate(() => {
    const d = (window as Window & { __VRATA_DEBUG__?: Debug }).__VRATA_DEBUG__;
    return d && { sceneDebug: d.sceneDebug && { state: d.sceneDebug.state }, localPose: d.localPose, interactionRay: d.interactionRay };
  });
}

test("clicking the same stairs still switches floors after a regular teleport on each level", async ({ page, request }) => {
  const headers = { "x-vrata-admin-token": "test-admin-token" };
  const room = await request.post("/api/rooms", {
    headers, data: {
      tenantId: "demo-tenant", templateId: "personal-workspace-basic",
      name: "Two floors", guestAllowed: true, sceneBundleUrl: twoFloorsBundle(),
      avatarConfig: { avatarsEnabled: false }
    }
  });
  expect(room.ok()).toBe(true);
  const { roomId } = await room.json();
  try {
    await page.setViewportSize({ width: 1080, height: 720 });
    await page.goto(`/rooms/${roomId}`);
    await completeGuestEntry(page, "Stair tester");
    await expect.poll(async () => (await debug(page))?.sceneDebug?.state, { timeout: 20_000 }).toBe("loaded");
    await expect.poll(async () => (await debug(page))?.localPose?.root).toMatchObject({ y: lowerY, z: 6 });

    const canvas = page.locator("#scene > canvas");
    for (const [fromY, toY] of [[lowerY, upperY], [upperY, lowerY]]) {
      const walk = { x: 540, y: 680 };
      await canvas.hover({ position: walk });
      await expect.poll(async () => (await debug(page))?.interactionRay?.point?.z).toBeCloseTo(3.43, 1);
      await canvas.click({ position: walk });
      await expect.poll(async () => (await debug(page))?.localPose?.root?.z).toBeCloseTo(3.43, 1);
      expect((await debug(page))?.localPose?.root?.y).toBe(fromY);
      // Click again only after the 250 ms interaction debounce has elapsed.
      const stairs = { x: 540, y: 360 };
      await canvas.hover({ position: stairs });
      await expect.poll(async () => (await debug(page))?.interactionRay).toMatchObject({
        targetKind: "floor", point: { z: 0 }
      });
      await page.waitForTimeout(300);
      await canvas.click({ position: stairs });
      await expect.poll(async () => (await debug(page))?.localPose?.root).toMatchObject({ y: toY, z: 6 });
      await page.waitForTimeout(300);
    }
  } finally {
    await page.goto("about:blank");
    expect((await request.delete(`/api/rooms/${roomId}`, { headers })).ok()).toBe(true);
  }
});
