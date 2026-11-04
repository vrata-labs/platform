import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { bearer, pluginPath, privateHttp, type ExternalArtifact } from "./plugin-author-scenarios";
import { enterOwnedPluginRoom, enterPluginRoom, installPluginArtifact, useOwnedActor } from "./room-plugin-fixture";
import { runAutoSeatScenario, runNoAnchorAutoSeatScenario, runPendingAutoSeatScenario } from "./room-plugin-auto-seat-scenarios";
import { startLightSceneRoomPluginFixture, startNoAnchorRoomPluginFixture } from "./room-plugin-no-anchor-fixture";
import { withCleanup } from "./test-cleanup";

// Room invitations, RS2 and private config must never enter trace/video/snapshots.
test.use({ trace: "off", screenshot: "off", video: "off" });

const seatState = (page: Page) => page.evaluate(() => {
  const debug = (window as any).__VRATA_DEBUG__;
  return { participantId: debug?.participantId as string, currentSeatId: debug?.currentSeatId as string | null,
    occupancy: { ...(debug?.seatOccupancy ?? {}) } as Record<string, string>, grant: debug?.plugins?.seating?.grant as string | undefined,
    ready: debug?.plugins?.seating?.ready as boolean | undefined };
});
const capabilities = ["seating.claimSelfOnEntry", "seating.cancelPendingOwnClaim", "status.set"];
test("isolated v2 auto-seat gives four simultaneous entries four confirmed seats; stand, reload and disable keep people's choices", async ({ browser }) => {
  test.setTimeout(600_000); const value = await startLightSceneRoomPluginFixture();
  await withCleanup(() => runAutoSeatScenario(browser, value, 4), () => [() => value.close()]);
});

test("isolated v2 auto-seat pending retirement suppresses intermediate late accept and leaves no ghosts", async ({ browser }) => {
  test.setTimeout(300_000); const value = await startLightSceneRoomPluginFixture();
  await withCleanup(() => runPendingAutoSeatScenario(browser, value), () => [() => value.close()]);
});

test("isolated v2 external auto-seat with no scene anchors stays standing without a claim", async ({ browser }) => {
  test.setTimeout(180_000);
  const value = await startNoAnchorRoomPluginFixture();
  await withCleanup(() => runNoAnchorAutoSeatScenario(browser, value), () => [() => value.close()]);
});

test("isolated v2 member whose browser cannot host plugins enters normally, is never auto-seated and seats manually", async ({ browser }) => {
  test.setTimeout(300_000); const value = await startLightSceneRoomPluginFixture();
  try {
    const host = await enterOwnedPluginRoom(browser, value);
    await useOwnedActor(host, async () => {
      const pkg = await installPluginArtifact(value, host,
        { bytes: await readFile("packages/room-plugin-sdk/examples/auto-seat/auto-seat.vrata-plugin.json") } as ExternalArtifact);
      const bound = await privateHttp(value.origin, pluginPath(host.roomId, `bindings/${pkg.pluginId}`), "PUT", bearer(host.session.token), {
        expectedRevision: 0, packageId: pkg.packageId, version: pkg.version, artifactSha256: pkg.artifactSha256, enabled: true, config: {},
        approvedCapabilities: capabilities, capabilityApproval: { artifactSha256: pkg.artifactSha256, capabilities } });
      expect(bound.status).toBe(200);
      await host.context.close();

      // A browser without Worker cannot start the plugin kernel; everything else is the ordinary entry.
      const member = await enterPluginRoom(browser, value, host.roomId, "member", "No plugin host member", async context => {
        await context.addInitScript(() => { delete (window as { Worker?: unknown }).Worker; });
      });
      try {
        const session = member.session as typeof member.session & { identityProtocolVersion?: number };
        expect(session.identityProtocolVersion).toBe(2);
        expect((await seatState(member.page)).participantId).toBe(session.participantId);
        // The enabled binding reached this tab, and its host reports the failure instead of running it.
        await expect.poll(() => member.page.evaluate(() => {
          const plugins = (window as any).__VRATA_DEBUG__?.plugins;
          return { hostFailed: plugins?.hostFailed, lastFailure: plugins?.lastFailure, running: plugins?.running };
        }), { timeout: 60_000 }).toEqual({ hostFailed: true, lastFailure: "host-unavailable", running: 0 });
        expect(member.requests.plugin).toBeGreaterThan(0);
        expect(member.requests.workers).toBe(0);
        // The arrival window passes and the person stays standing.
        await expect.poll(async () => (await seatState(member.page)).ready, { timeout: 60_000 }).toBe(true);
        await member.page.waitForTimeout(6000);
        expect((await seatState(member.page)).currentSeatId).toBeNull();
        expect(member.requests.workers).toBe(0);
        // Manual seating through the ordinary room-state claim still works.
        expect(await member.page.evaluate(() => (window as any).__VRATA_TEST__.requestSeatClaimById("seat-01"))).toBe(true);
        await expect.poll(async () => (await seatState(member.page)).currentSeatId, { timeout: 15_000 }).toBe("seat-01");
        expect((await seatState(member.page)).occupancy["seat-01"]).toBe(session.participantId);
        expect(await member.page.evaluate(() => (window as any).__VRATA_DEBUG__?.roomStateConnected)).toBe(true);
      } finally { await member.context.close(); }
    });
  } finally { await value.close(); }
});
