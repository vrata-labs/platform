import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { bearer, pluginPath, privateHttp, type ExternalArtifact } from "./plugin-author-scenarios";
import { enterOwnedPluginRoom, enterPluginRoom, expectPluginStatus, installPluginArtifact, startRoomPluginFixture, useOwnedActor } from "./room-plugin-fixture";

// Room invitations, RS2 and private config must never enter trace/video/snapshots.
test.use({ trace: "off", screenshot: "off", video: "off" });

const seatState = (page: Page) => page.evaluate(() => {
  const debug = (window as any).__VRATA_DEBUG__;
  return { participantId: debug?.participantId as string, currentSeatId: debug?.currentSeatId as string | null,
    pendingSeatId: debug?.pendingSeatId as string | null, occupancy: { ...(debug?.seatOccupancy ?? {}) } as Record<string, string>,
    seating: debug?.plugins?.seating as { grant: string } | undefined };
});

test("isolated v2 auto-seat seats only a newly entering participant through correlated platform seating", async ({ browser }) => {
  test.setTimeout(420_000); const value = await startRoomPluginFixture(2);
  try {
    const host = await enterOwnedPluginRoom(browser, value);
    await useOwnedActor(host, async () => {
      // The Host is ready and its one arrival window has passed before the behavior exists.
      await expect.poll(async () => (await seatState(host.page)).seating?.grant, { timeout: 30_000 }).not.toBe("waiting");
      await expect.poll(async () => (await seatState(host.page)).seating?.grant, { timeout: 40_000 }).toBe("closed");
      // The externally built SDK example, uploaded through the ordinary author API.
      const bytes = await readFile("packages/room-plugin-sdk/examples/auto-seat/auto-seat.vrata-plugin.json");
      const pkg = await installPluginArtifact(value, host, { bytes } as ExternalArtifact);
      const capabilities = ["seating.claimSelfOnEntry", "seating.cancelPendingOwnClaim", "status.set"];
      const bound = await privateHttp(value.origin, pluginPath(host.roomId, `bindings/${pkg.pluginId}`), "PUT", bearer(host.session.token), {
        expectedRevision: 0, packageId: pkg.packageId, version: pkg.version, artifactSha256: pkg.artifactSha256, enabled: true, config: {},
        approvedCapabilities: capabilities, capabilityApproval: { artifactSha256: pkg.artifactSha256, capabilities } });
      expect(bound.status).toBe(200);
      // A behavior enabled later never seats people who are already in the room.
      await expectPluginStatus(host.page, "host-late-enable", "Автопосадка не разрешена", 45_000);
      expect((await seatState(host.page)).currentSeatId).toBeNull();

      const member = await enterPluginRoom(browser, value, host.roomId, "member", "Owned plugin runtime Member");
      const refusing = await enterPluginRoom(browser, value, host.roomId, "member", "Owned plugin runtime Refusal", async context => {
        await context.addInitScript(roomId => sessionStorage.setItem(`vrata.autoSeatOptOut.${roomId}`, "1"), host.roomId);
      });
      try {
        await expect.poll(async () => (await seatState(member.page)).currentSeatId, { timeout: 45_000 }).not.toBeNull();
        const seated = await seatState(member.page);
        expect(seated.occupancy[seated.currentSeatId!]).toBe(seated.participantId);
        await expect.poll(async () => (await seatState(host.page)).occupancy[seated.currentSeatId!], { timeout: 15_000 }).toBe(seated.participantId);
        await expectPluginStatus(member.page, "member-seated", "Заявка принята");
        expect(seated.seating?.grant).toBe("used");

        // A refusal stored for this tab keeps the participant standing; the choice is visible to them.
        await expectPluginStatus(refusing.page, "refusal", "Автопосадка не разрешена", 45_000);
        await expect(refusing.page.locator("#room-plugin-seat-choice")).toBeVisible();
        await expect(refusing.page.locator("#room-plugin-seat-choice-input")).not.toBeChecked();
        expect((await seatState(refusing.page)).currentSeatId).toBeNull();

        // Standing up manually is final for this session: the behavior cannot seat the participant again.
        expect(await member.page.evaluate(() => (window as any).__VRATA_TEST__.teleportToFloor(0, 2))).toBe(true);
        await expect.poll(async () => (await seatState(member.page)).currentSeatId, { timeout: 15_000 }).toBeNull();
        await member.page.waitForTimeout(6000);
        const after = await seatState(member.page);
        expect([after.currentSeatId, after.pendingSeatId]).toEqual([null, null]);
        expect(Object.values(after.occupancy)).not.toContain(after.participantId);
        expect((await seatState(refusing.page)).currentSeatId).toBeNull();
      } finally { await member.context.close(); await refusing.context.close(); }
    });
  } finally { await value.close(); }
});
