import { expect, type Browser, type Page, type Request, type WebSocketRoute } from "@playwright/test";
import { bearer, createExternalAuthorProject, downloadPublicSdk, pluginPath, privateHttp } from "./plugin-author-scenarios";
import { deleteOwnedPluginRoom, enterOwnedPluginRoom, enterPluginRoom, expectPluginStatus, installPluginArtifact, useOwnedActor, type RoomPluginOrigin } from "./room-plugin-fixture";
import { captureRoomAuthority, expectExactRoomAuthority, type RoomAuthorityCapture } from "./room-state-observation";
import { runSeatProtocolRace } from "./room-seat-protocol-race";
import { identityProtocolAt } from "./staging-identity";
import { inlineSceneBundleUrl } from "./scene-bundle-fixtures";
import { cleanupAll, withCleanup } from "./test-cleanup";

export const seatState = (page: Page) => page.evaluate(() => {
  const debug = (window as any).__VRATA_DEBUG__;
  return { participantId: debug?.participantId as string, currentSeatId: debug?.currentSeatId as string | null,
    pendingSeatId: debug?.pendingSeatId as string | null, occupancy: { ...(debug?.seatOccupancy ?? {}) } as Record<string, string>,
    ready: debug?.plugins?.seating?.ready as boolean | undefined, running: debug?.plugins?.running as number | undefined };
});
const capabilities = ["seating.claimSelfOnEntry", "seating.cancelPendingOwnClaim", "status.set"];

export async function runAutoSeatScenario(browser: Browser, value: RoomPluginOrigin) {
  expect(await identityProtocolAt(value.origin)).toBe(2);
  const captures: RoomAuthorityCapture[] = [];
  const author = await createExternalAuthorProject(await downloadPublicSdk(value.origin, "0.2.0"), "0.2.0");
  const contexts: Array<{ close(): Promise<void> }> = [];
  await withCleanup(async () => {
    const host = await enterOwnedPluginRoom(browser, value);
    await useOwnedActor(host, async () => {
      const pkg = await installPluginArtifact(value, host, await author.buildAutoSeat());
      const put = async (enabled: boolean) => {
        const library = await privateHttp(value.origin, pluginPath(host.roomId, "packages"), "GET", bearer(host.session.token));
        expect(library.status).toBe(200);
        const response = await privateHttp(value.origin, pluginPath(host.roomId, `bindings/${pkg.pluginId}`), "PUT", bearer(host.session.token), {
          expectedRevision: library.json<{ revision: number }>().revision, packageId: pkg.packageId, version: pkg.version, artifactSha256: pkg.artifactSha256,
          enabled, config: {}, approvedCapabilities: capabilities, capabilityApproval: { artifactSha256: pkg.artifactSha256, capabilities } });
        expect(response.status).toBe(200);
      };
      await put(true);
      await host.context.close();
      const observe = async (page: Page) => { const capture = await captureRoomAuthority(page); captures.push(capture); return capture; };
      const routes: Array<{ route: WebSocketRoute; page: Page }> = [], pages: Page[] = [];
      let barrierOpen = false;
      const observations = new Map<Page, RoomAuthorityCapture>();
      const entries = [1, 2, 3, 4].map(index => enterPluginRoom(browser, value, host.roomId, "member", `Auto-seat member ${index}`, async (context, page) => {
        contexts.push(context); pages.push(page); observations.set(page, await observe(page));
        // All four real clients finish scene loading before any gets the initial
        // authoritative snapshot. No fabricated readiness, snapshots or claims.
        await page.routeWebSocket(url => url.searchParams.has("roomId"), socket => {
          if (barrierOpen) socket.connectToServer(); else routes.push({ route: socket, page });
        });
      }));
      const settled = Promise.all(entries); void settled.catch(() => undefined);
      await withCleanup(async () => {
        await expect.poll(() => pages.length === 4 && routes.length === 4, { timeout: 90_000 }).toBe(true);
        await Promise.all(pages.map(page => expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__?.sceneBundleState), { timeout: 90_000 }).toBe("loaded")));
        barrierOpen = true;
        for (const { route } of routes) route.connectToServer();
        const members = (await settled).map(member => ({ ...member, participantId: member.session.participantId, authority: observations.get(member.page)! }));
        for (const member of members) await expect.poll(async () => Boolean((await seatState(member.page)).currentSeatId), { timeout: 60_000 }).toBe(true);
        const seated = await Promise.all(members.map(member => seatState(member.page)));
        const seats = seated.map(state => state.currentSeatId!);
        expect(new Set(seats).size).toBe(4);
        await expectExactRoomAuthority(members);
        for (const member of members) expect(member.authority.commands().some(command => command.type === "seat_claim_result" && command.accepted
          && member.authority.commands().some(sent => sent.type === "seat_claim" && sent.commandId === command.commandId && sent.seatId === command.seatId))).toBe(true);
        const free = Array.from({ length: 8 }, (_, index) => `seat-${String(index + 1).padStart(2, "0")}`).find(id => !seats.includes(id))!;
        await runSeatProtocolRace(value, host.roomId, members.map(member => member.participantId), free);
        await expectExactRoomAuthority(members); // Protocol contenders left; no ghosts.
        const [first] = members;
        await first.page.locator("#stand-up").click();
        await expect.poll(async () => (await seatState(first.page)).currentSeatId, { timeout: 15_000 }).toBeNull();
        await expect(first.page.locator("#room-plugin-seat-choice-input")).not.toBeChecked();
        await expectExactRoomAuthority(members);
        const previous = first.participantId;
        const beforeReload = first.authority.generation();
        const readmission = first.page.waitForResponse(response => new URL(response.url()).pathname === "/api/tokens/state" && response.status() === 200);
        void readmission.catch(() => undefined);
        await first.page.reload();
        await first.page.locator("#guest-name-input").fill("Auto-seat member 1");
        await first.page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
        const session = await (await readmission).json();
        expect(session.participantId === previous).toBe(true);
        await expect.poll(() => (first.authority.snapshot()?.generation ?? 0) > beforeReload, { timeout: 30_000 }).toBe(true);
        await expectExactRoomAuthority(members);
        const beforeReconnect = first.authority.generation();
        await first.page.evaluate(() => (window as any).__VRATA_TEST__.forceRoomStateReconnect());
        await expect.poll(() => (first.authority.snapshot()?.generation ?? 0) > beforeReconnect, { timeout: 30_000 }).toBe(true);
        await expectExactRoomAuthority(members);
        await first.page.waitForTimeout(6000);
        expect((await seatState(first.page)).currentSeatId).toBeNull();
        await put(false);
        await expect.poll(async () => (await seatState(members[1].page)).running, { timeout: 15_000 }).toBe(0);
        for (const [index, member] of members.slice(1).entries()) expect((await seatState(member.page)).currentSeatId === seats[index + 1]).toBe(true);
        for (const member of members) await member.context.close();
        const late = await enterPluginRoom(browser, value, host.roomId, "member", "Auto-seat disabled late member", async (context, page) => {
          contexts.push(context); observations.set(page, await observe(page));
        });
        const lateActor = { ...late, participantId: late.session.participantId, authority: observations.get(late.page)! };
        await expectExactRoomAuthority([lateActor]);
        await late.page.waitForTimeout(6000);
        expect((await seatState(late.page)).currentSeatId).toBeNull(); expect(late.requests.workers).toBe(0);
        // Keep one normal client to observe the server during cancellation.
        await put(true);
        await disablePendingClaim(browser, value, host.roomId, put, lateActor, contexts, observations, observe);
        await author.assertNotExecuted();
      }, () => [
        // Release a failed readiness barrier before closing pages; no pending routes remain.
        () => { barrierOpen = true; },
        ...routes.map(({ route, page }) => () => !page.isClosed() ? route.close() : undefined),
        // Closing entrants also settles failed pending admission waits before room deletion.
        () => cleanupAll(contexts.map(context => () => context.close())),
        async () => {
          const results = await Promise.allSettled(entries);
          const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
          if (errors.length) throw new AggregateError(errors, "owned_test_entries_failed");
        },
        () => cleanupAll(contexts.map(context => () => context.close())),
        () => { routes.length = 0; pages.length = 0; observations.clear(); }
      ]);
    });
  }, () => [...captures.map(capture => () => capture.close()), ...contexts.map(context => () => context.close()),
    () => { captures.length = 0; contexts.length = 0; }, () => author.close()]);
}

async function disablePendingClaim(browser: Browser, value: RoomPluginOrigin, roomId: string, put: (enabled: boolean) => Promise<void>,
  witness: { page: Page; participantId: string; authority: RoomAuthorityCapture }, contexts: Array<{ close(): Promise<void> }>,
  observations: Map<Page, RoomAuthorityCapture>, observe: (page: Page) => Promise<RoomAuthorityCapture>) {
  let held = false, accepted = false, releaseAck = false, claimAt = 0, releaseAt = 0;
  let claimId = "", claimedSeat = "", releaseId = "";
  let claimCount = 0, releaseCount = 0;
  const beganAt = performance.now(), phases: Record<string, number> = {};
  const mark = (phase: string) => { phases[phase] = performance.now(); };
  const runtimeReads: Array<{ at: number; status: number | null; revision: number | null; enabledBindings: number | null }> = [];
  const runtimeReadsPending = new Set<Promise<void>>();
  // Passive timing only: never intercept or replace runtime authority. Keep no
  // URLs, credentials, binding identities, config, source or raw response bytes.
  const onRuntimeFinished = (request: Request) => {
    if (!held || runtimeReads.length >= 8 || new URL(request.url()).pathname !== pluginPath(roomId, "runtime")) return;
    const row = { at: performance.now(), status: null as number | null, revision: null as number | null, enabledBindings: null as number | null };
    runtimeReads.push(row);
    // requestfinished means the body is already complete: diagnostic cleanup
    // must never wait for a live network response before it can close a page.
    const pending = (async () => {
      try {
        const response = await request.response(); if (!response) return;
        row.status = response.status();
        const body = await response.json();
        row.revision = Number.isSafeInteger(body?.revision) ? body.revision : null;
        row.enabledBindings = Array.isArray(body?.bindings) ? body.bindings.filter((binding: any) => binding?.enabled === true).length : null;
      } catch { /* An unavailable diagnostic body remains null, never a success. */ }
    })();
    runtimeReadsPending.add(pending);
    void pending.finally(() => runtimeReadsPending.delete(pending));
  };
  const queue: Array<{ type: string; frame: string | Buffer }> = [];
  let transport: WebSocketRoute | undefined;
  let pendingPage: Page | undefined;
  const entering = enterPluginRoom(browser, value, roomId, "member", "Auto-seat pending disable", async (context, page) => {
    pendingPage = page;
    contexts.push(context); observations.set(page, await observe(page));
    page.on("requestfinished", onRuntimeFinished);
    await page.routeWebSocket(url => url.searchParams.has("roomId"), socket => {
      transport = socket;
      const server = socket.connectToServer();
      socket.onMessage(message => {
        let payload: any; try { payload = JSON.parse(String(message)); } catch { server.send(message); return; }
        if (payload.type === "seat_claim" && String(payload.commandId).startsWith("plugin-seat:")) {
          held = true; claimAt = performance.now(); claimId = payload.commandId; claimedSeat = payload.seatId;
          claimCount++; phases.firstClaim ??= claimAt;
          mark("claim");
        }
        if (payload.type === "seat_release" && String(payload.commandId).startsWith("plugin-release:")) {
          releaseAt = performance.now(); releaseId = payload.commandId;
          releaseCount++; phases.firstRelease ??= releaseAt;
          mark("release");
        }
        server.send(message);
      });
      server.onMessage(message => {
        let payload: any; try { payload = JSON.parse(String(message)); } catch { socket.send(message); return; }
        if (held && ["room_state", "seat_claim_result", "seat_release_result"].includes(payload.type)) {
          // Coalesce consecutive snapshots, preserving claim/release ordering.
          if (payload.type === "room_state" && queue.at(-1)?.type === "room_state") queue[queue.length - 1] = { type: payload.type, frame: message };
          else {
            if (queue.length >= 32) throw new Error("t16_pending_claim_capture_bound");
            queue.push({ type: payload.type, frame: message });
          }
          if (!accepted && payload.type === "seat_claim_result" && payload.seatClaimResult?.commandId === claimId && payload.seatClaimResult?.accepted === true) {
            accepted = true; mark("serverAccepted");
          }
          if (!releaseAck && payload.type === "seat_release_result" && payload.seatReleaseResult?.commandId === releaseId) {
            releaseAck = true; mark("serverReleaseAck");
          }
        } else socket.send(message);
      });
    });
  });
  void entering.catch(() => undefined);
  let member: Awaited<ReturnType<typeof enterPluginRoom>> | undefined;
  await withCleanup(async () => {
    // Scene loading and normal onboarding have their own entry deadlines. The
    // claim deadline must not start while the new participant is still entering.
    member = await entering;
    mark("entryComplete");
    try { await expect.poll(() => accepted, { timeout: 15_000, intervals: [50] }).toBe(true); }
    catch (error) {
      const facts = await member.page.evaluate(() => {
        const debug = (window as any).__VRATA_DEBUG__;
        return { sceneLoaded: debug?.sceneBundleState === "loaded", connected: debug?.roomStateConnected === true,
          running: debug?.plugins?.running ?? null, failure: debug?.plugins?.lastFailure ?? null,
          grant: debug?.plugins?.seating?.grant ?? null, pending: Boolean(debug?.pendingSeatId), seated: Boolean(debug?.currentSeatId) };
      }).catch(() => ({ unavailable: true }));
      console.warn("t16_pending_claim_failed", JSON.stringify({ claimObserved: Boolean(claimId), acceptedObserved: accepted,
        releaseObserved: Boolean(releaseId), queuedTypes: queue.map(message => message.type), facts }));
      throw error;
    }
    mark("acceptedObserved");
    expect(Boolean((await seatState(pendingPage!)).pendingSeatId)).toBe(true);
    expect((await seatState(pendingPage!)).currentSeatId).toBeNull();
    mark("pendingVerified");
    // A transport capture sees server ACKs before this deliberate delay. Count
    // actual replay delivery as well, so pre-replay standing cannot pass.
    await pendingPage!.evaluate(({ claimId, claimedSeat }) => {
      const dispatch = EventTarget.prototype.dispatchEvent;
      const state = { accepted: 0, released: 0, occupied: 0, releaseId: "" };
      EventTarget.prototype.dispatchEvent = function (event) {
        if (this instanceof WebSocket && event instanceof MessageEvent && typeof event.data === "string" && event.data.length < 262_144) {
          try {
            const message = JSON.parse(event.data);
            if (message.type === "seat_claim_result" && message.seatClaimResult?.commandId === claimId && message.seatClaimResult.accepted === true) state.accepted++;
            if (message.type === "seat_release_result" && message.seatReleaseResult?.commandId === state.releaseId) state.released++;
            if (message.type === "room_state" && message.room?.seatOccupancy?.[claimedSeat] === (window as any).__VRATA_DEBUG__?.participantId) state.occupied++;
          } catch { /* Only allowlisted counters, no raw messages. */ }
        }
        return dispatch.call(this, event);
      };
      (window as any).__t16SeatDelivery = state;
      (window as any).__t16SeatDeliveryCleanup = () => {
        EventTarget.prototype.dispatchEvent = dispatch;
        delete (window as any).__t16SeatDelivery; delete (window as any).__t16SeatDeliveryCleanup;
      };
    }, { claimId, claimedSeat });
    mark("deliveryHookInstalled");
    mark("disableRequested");
    await put(false);
    mark("disableAck");
    const actor = { ...member, participantId: member.session.participantId, authority: observations.get(member.page)! };
    await expect.poll(async () => (await seatState(actor.page)).running, { timeout: 15_000 }).toBe(0);
    mark("runningZeroObserved");
    await expect.poll(() => releaseAck, { timeout: 15_000 }).toBe(true);
    mark("releaseAckObserved");
    expect(releaseAt > claimAt && releaseAt - claimAt < 3000).toBe(true); // Not the adapter's lost-answer timeout.
    await member.page.evaluate(releaseId => { (window as any).__t16SeatDelivery.releaseId = releaseId; }, releaseId);
    // Deliver ONLY occupied/accepted first. A later correct empty snapshot must
    // not conceal even one frame of applying the cancelled seating attempt.
    const acceptedIndex = queue.findIndex(message => message.type === "seat_claim_result"
      && JSON.parse(String(message.frame)).seatClaimResult?.commandId === claimId);
    expect(acceptedIndex > 0).toBe(true);
    const standingPose = await member.page.evaluate(() => {
      const root = (window as any).__VRATA_DEBUG__?.localPose?.root;
      return [root?.x, root?.y, root?.z];
    });
    expect(standingPose.every(Number.isFinite)).toBe(true);
    for (const message of queue.splice(0, acceptedIndex + 1)) transport!.send(message.frame);
    await expect.poll(() => member!.page.evaluate(() => {
      const state = (window as any).__t16SeatDelivery;
      return state?.accepted === 1 && state?.occupied > 0 && state?.released === 0;
    }), { timeout: 15_000 }).toBe(true);
    await member.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const intermediate = await seatState(member.page);
    expect(intermediate.currentSeatId === null && intermediate.pendingSeatId === null).toBe(true);
    expect(await member.page.evaluate(() => (window as any).__VRATA_DEBUG__?.locomotionMode === "desktop")).toBe(true);
    expect(await member.page.evaluate(standing => {
      const root = (window as any).__VRATA_DEBUG__?.localPose?.root;
      return JSON.stringify([root?.x, root?.y, root?.z]) === JSON.stringify(standing);
    }, standingPose)).toBe(true);
    // Now retain original wire order for empty occupancy and the correlated release ACK.
    for (const message of queue.splice(0)) transport!.send(message.frame);
    held = false;
    await expect.poll(() => member!.page.evaluate(() => {
      const state = (window as any).__t16SeatDelivery;
      return state?.accepted > 0 && state?.released > 0;
    }), { timeout: 15_000 }).toBe(true);
    await member.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect.poll(() => actor.authority.commands().some(command => command.type === "seat_release_result" && command.commandId === releaseId
      && actor.authority.commands().some(sent => sent.type === "seat_release" && sent.commandId === releaseId)), { timeout: 15_000 }).toBe(true);
    await expectExactRoomAuthority([witness, actor]);
    const state = await seatState(member.page);
    expect(state.currentSeatId === null && state.pendingSeatId === null && !Object.values(witness.authority.snapshot()!.occupancy).includes(actor.participantId)).toBe(true);
    expect(actor.authority.commands().some(command => command.type === "seat_claim_result" && command.commandId === claimId && command.accepted)).toBe(true);
    await member.context.close();
    await expectExactRoomAuthority([witness]);
  }, () => [async () => {
    pendingPage?.off("requestfinished", onRuntimeFinished);
    await Promise.allSettled(runtimeReadsPending);
    const offset = (at: number) => Math.round((at - (claimAt || beganAt)) * 10) / 10;
    console.info("t16_pending_claim_timing", JSON.stringify({ claimCount, releaseCount, claimObserved: Boolean(claimId), acceptedObserved: accepted,
      releaseObserved: Boolean(releaseId), releaseDeltaMs: claimAt && releaseAt ? Math.round((releaseAt - claimAt) * 10) / 10 : null,
      phaseOffsetsMs: Object.fromEntries(Object.entries(phases).map(([phase, at]) => [phase, offset(at)])),
      runtimeReads: runtimeReads.map(({ at, ...row }) => ({ offsetMs: offset(at), ...row })) }));
    runtimeReads.length = 0; runtimeReadsPending.clear();
  }, () => { held = false; queue.length = 0; },
    () => pendingPage && !pendingPage.isClosed() ? pendingPage.evaluate(() => (window as any).__t16SeatDeliveryCleanup?.()) : undefined,
    () => pendingPage && !pendingPage.isClosed() ? transport?.close() : undefined, () => member?.context.close(),
    () => pendingPage?.context().close(), () => entering]);
}

/** One tiny owned inline scene, not a catalog/scene-package change. */
export async function runNoAnchorAutoSeatScenario(browser: Browser, value: RoomPluginOrigin & { noAnchorTemplateId: string }) {
  const source = inlineSceneBundleUrl({ sceneId: "t16-no-seat-anchors", label: "No seat anchors regression" });
  const manifest = JSON.parse(decodeURIComponent(source.slice(source.indexOf(",") + 1)));
  manifest.anchors = { teleportFloorY: 0, seatAnchors: [] };
  const created = await privateHttp(value.origin, "/api/rooms", "POST", { "x-vrata-admin-token": value.adminToken }, {
    tenantId: "demo-tenant", templateId: value.noAnchorTemplateId, name: "Owned no-anchor regression", visibility: "private",
    sceneBundleUrl: `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`
  });
  expect(created.status).toBe(201);
  const roomId = created.json<{ roomId: string }>().roomId;
  let host: Awaited<ReturnType<typeof enterPluginRoom>> | undefined, member: typeof host;
  let author: Awaited<ReturnType<typeof createExternalAuthorProject>> | undefined;
  let authority: RoomAuthorityCapture | undefined;
  await withCleanup(async () => {
    host = await enterPluginRoom(browser, value, roomId);
    author = await createExternalAuthorProject(await downloadPublicSdk(value.origin, "0.2.0"), "0.2.0");
    const pkg = await installPluginArtifact(value, host, await author.buildAutoSeat());
    const bound = await privateHttp(value.origin, pluginPath(roomId, `bindings/${pkg.pluginId}`), "PUT", bearer(host.session.token), {
      expectedRevision: 0, packageId: pkg.packageId, version: pkg.version, artifactSha256: pkg.artifactSha256, enabled: true, config: {},
      approvedCapabilities: capabilities, capabilityApproval: { artifactSha256: pkg.artifactSha256, capabilities } });
    expect(bound.status).toBe(200);
    await host.context.close();
    member = await enterPluginRoom(browser, value, roomId, "member", "No anchors member", async (_context, page) => { authority = await captureRoomAuthority(page); });
    await expectPluginStatus(member.page, "no-anchors", "Свободных мест нет", 45_000);
    await member.page.waitForTimeout(6000);
    expect((await seatState(member.page)).currentSeatId).toBeNull();
    expect(authority!.commands().some(command => command.type === "seat_claim")).toBe(false);
    expect(await member.page.evaluate(() => (window as any).__VRATA_TEST__.requestSeatClaimById("seat-01"))).toBe(false);
    await expectExactRoomAuthority([{ page: member.page, participantId: member.session.participantId, authority: authority! }]);
    await author.assertNotExecuted();
  }, () => [() => authority?.close(), () => member?.context.close(), () => host?.context.close(), () => author?.close(),
    () => deleteOwnedPluginRoom(value, roomId)]);
}
