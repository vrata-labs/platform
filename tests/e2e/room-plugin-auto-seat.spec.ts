import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { bearer, pluginPath, privateHttp, type ExternalArtifact } from "./plugin-author-scenarios";
import { enterOwnedPluginRoom, enterPluginRoom, installPluginArtifact, startRoomPluginFixture, useOwnedActor } from "./room-plugin-fixture";

// Room invitations, RS2 and private config must never enter trace/video/snapshots.
test.use({ trace: "off", screenshot: "off", video: "off" });

const seatState = (page: Page) => page.evaluate(() => {
  const debug = (window as any).__VRATA_DEBUG__;
  return { participantId: debug?.participantId as string, currentSeatId: debug?.currentSeatId as string | null,
    occupancy: { ...(debug?.seatOccupancy ?? {}) } as Record<string, string>, grant: debug?.plugins?.seating?.grant as string | undefined,
    ready: debug?.plugins?.seating?.ready as boolean | undefined };
});
const capabilities = ["seating.claimSelfOnEntry", "seating.cancelPendingOwnClaim", "status.set"];
async function expectSeated(page: Page, label: string) {
  try { await expect.poll(async () => (await seatState(page)).currentSeatId, { timeout: 60_000 }).not.toBeNull(); }
  catch (error) {
    const facts = await page.evaluate(() => {
      const debug = (window as any).__VRATA_DEBUG__;
      return { status: document.querySelector("#room-plugin-status-list")?.textContent ?? null, plugins: debug?.plugins,
        pending: debug?.pendingSeatId, occupancy: debug?.seatOccupancy, connected: debug?.roomStateConnected, scene: debug?.sceneBundleState };
    }).catch(() => ({ unavailable: true }));
    console.warn("owned_auto_seat_failed", JSON.stringify({ label, facts }));
    throw error;
  }
}

test("isolated v2 auto-seat gives four simultaneous entries four confirmed seats; stand, reload and disable keep people's choices", async ({ browser }) => {
  test.setTimeout(600_000); const value = await startRoomPluginFixture(2);
  try {
    const host = await enterOwnedPluginRoom(browser, value);
    await useOwnedActor(host, async () => {
      await expect.poll(async () => (await seatState(host.page)).grant, { timeout: 60_000 }).toBe("closed");
      // The exact externally built SDK artifact is bound to this new room through the ordinary author API.
      const pkg = await installPluginArtifact(value, host,
        { bytes: await readFile("packages/room-plugin-sdk/examples/auto-seat/auto-seat.vrata-plugin.json") } as ExternalArtifact);
      const put = (expectedRevision: number, enabled: boolean) => privateHttp(value.origin, pluginPath(host.roomId, `bindings/${pkg.pluginId}`), "PUT",
        bearer(host.session.token), { expectedRevision, packageId: pkg.packageId, version: pkg.version, artifactSha256: pkg.artifactSha256,
          enabled, config: {}, approvedCapabilities: capabilities, capabilityApproval: { artifactSha256: pkg.artifactSha256, capabilities } });
      const bound = await put(0, true); expect(bound.status).toBe(200);

      const members = await Promise.all([1, 2, 3, 4].map(index => enterPluginRoom(browser, value, host.roomId, "member", `Auto-seat member ${index}`)));
      let late: Awaited<ReturnType<typeof enterPluginRoom>> | undefined;
      try {
        for (const [index, member] of members.entries()) await expectSeated(member.page, `member-${index + 1}`);
        const seated = await Promise.all(members.map(member => seatState(member.page)));
        const seats = seated.map(state => state.currentSeatId!);
        expect(new Set(seats).size).toBe(4);
        await expect.poll(async () => {
          const occupancy = (await seatState(host.page)).occupancy;
          return seated.every(state => occupancy[state.currentSeatId!] === state.participantId);
        }, { timeout: 15_000 }).toBe(true);

        // The platform stand action releases the seat, returns to the entry point and is this tab's refusal.
        const [first] = members;
        await expect(first.page.locator("#stand-up")).toBeVisible();
        await first.page.locator("#stand-up").click();
        await expect.poll(async () => (await seatState(first.page)).currentSeatId, { timeout: 15_000 }).toBeNull();
        await expect(first.page.locator("#stand-up")).toBeHidden();
        await expect(first.page.locator("#room-plugin-seat-choice-input")).not.toBeChecked();
        await expect.poll(async () => (await seatState(host.page)).occupancy[seats[0]] ?? null, { timeout: 15_000 }).toBeNull();
        const readmission = first.page.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state" && response.status() === 200);
        void readmission.catch(() => undefined);
        await first.page.reload();
        await expect(first.page.locator("#guest-onboarding")).toBeVisible();
        await first.page.locator("#guest-name-input").fill("Auto-seat member 1");
        await first.page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
        await readmission;
        await expect.poll(async () => (await seatState(first.page)).ready, { timeout: 90_000 }).toBe(true);
        await first.page.waitForTimeout(6000);
        expect((await seatState(first.page)).currentSeatId).toBeNull();
        expect((await seatState(first.page)).participantId).toBe(seated[0].participantId);

        // Disabling the behavior leaves confirmed seats with their people; a new entry then stays standing.
        const library = (await privateHttp(value.origin, pluginPath(host.roomId, "packages"), "GET", bearer(host.session.token))).json<{ revision: number }>();
        expect((await put(library.revision, false)).status).toBe(200);
        await expect(members[1].page.locator("#room-plugin-statuses")).toBeHidden({ timeout: 15_000 });
        for (const [index, member] of members.slice(1).entries()) expect((await seatState(member.page)).currentSeatId).toBe(seats[index + 1]);
        late = await enterPluginRoom(browser, value, host.roomId, "member", "Auto-seat late member");
        await expect.poll(async () => (await seatState(late!.page)).ready, { timeout: 60_000 }).toBe(true);
        await late.page.waitForTimeout(6000);
        expect((await seatState(late.page)).currentSeatId).toBeNull();
        expect(late.requests.workers).toBe(0);
      } finally {
        await late?.context.close();
        for (const member of members) await member.context.close();
      }
    });
  } finally { await value.close(); }
});
