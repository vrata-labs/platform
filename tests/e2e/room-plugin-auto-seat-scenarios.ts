import { expect, type Browser, type Page, type Request, type WebSocketRoute } from "@playwright/test";
import { bearer, createExternalAuthorProject, downloadPublicSdk, pluginPath, privateHttp } from "./plugin-author-scenarios";
import { deleteOwnedPluginRoom, enterOwnedPluginRoom, enterPluginRoom, expectPluginStatus, installPluginArtifact, useOwnedActor, type RoomPluginOrigin } from "./room-plugin-fixture";
import { captureRoomAuthority, expectExactRoomAuthority, type RoomAuthorityCapture } from "./room-state-observation";
import { runSeatProtocolRace } from "./room-seat-protocol-race";
import { identityProtocolAt } from "./staging-identity";
import { inlineSceneBundleUrl } from "./scene-bundle-fixtures";
import { cleanupAll, withCleanup } from "./test-cleanup";
import { installSeatAckObservation } from "./seat-ack-observation";
import { installSeatEntryObservation } from "./seat-entry-observation";

export const seatState = (page: Page) => page.evaluate(() => {
  const debug = (window as any).__VRATA_DEBUG__;
  return { participantId: debug?.participantId as string, currentSeatId: debug?.currentSeatId as string | null,
    pendingSeatId: debug?.pendingSeatId as string | null, occupancy: { ...(debug?.seatOccupancy ?? {}) } as Record<string, string>,
    ready: debug?.plugins?.seating?.ready as boolean | undefined, running: debug?.plugins?.running as number | undefined };
});
const capabilities = ["seating.claimSelfOnEntry", "seating.cancelPendingOwnClaim", "status.set"];

/** External SDK build and ordinary Host CAS shared by the two integration witnesses.
 * Closing the Host renderer does not elevate or replace its admitted session. */
async function withAutoSeatRoom(browser: Browser, value: RoomPluginOrigin,
  run: (roomId: string, put: (enabled: boolean) => Promise<number>) => Promise<void>) {
  expect(await identityProtocolAt(value.origin)).toBe(2);
  const author = await createExternalAuthorProject(await downloadPublicSdk(value.origin, "0.2.0"), "0.2.0");
  await withCleanup(async () => {
    const host = await enterOwnedPluginRoom(browser, value);
    await useOwnedActor(host, async () => {
      const pkg = await installPluginArtifact(value, host, await author.buildAutoSeat());
      const library = await privateHttp(value.origin, pluginPath(host.roomId, "packages"), "GET", bearer(host.session.token));
      expect(library.status).toBe(200);
      let revision = library.json<{ revision: number }>().revision;
      const put = async (enabled: boolean) => {
        const response = await privateHttp(value.origin, pluginPath(host.roomId, `bindings/${pkg.pluginId}`), "PUT", bearer(host.session.token), {
          expectedRevision: revision, packageId: pkg.packageId, version: pkg.version, artifactSha256: pkg.artifactSha256,
          enabled, config: {}, approvedCapabilities: capabilities, capabilityApproval: { artifactSha256: pkg.artifactSha256, capabilities } });
        expect(response.status).toBe(200);
        revision = response.json<{ revision: number }>().revision;
        return revision;
      };
      await put(true);
      await host.context.close();
      await run(host.roomId, put);
      await author.assertNotExecuted();
    });
  }, () => [() => author.close()]);
}

/** This four-renderer entry deadline must not inherit the worker browser's GPU
 * process/cache lifetime from earlier SDK, canvas or public-demo scenarios.
 * Playwright's BrowserType retains this project's default launch options; do
 * not substitute flags or pre-run the plugin to warm its startup. */
async function withAutoSeatBrowser(browser: Browser, run: (owned: Browser) => Promise<void>) {
  const owned = await browser.browserType().launch();
  await withCleanup(() => run(owned), () => [() => owned.close()]);
}

export async function runAutoSeatScenario(browser: Browser, value: RoomPluginOrigin) {
  await withAutoSeatBrowser(browser, owned => runOwnedAutoSeatScenario(owned, value));
}

async function runOwnedAutoSeatScenario(browser: Browser, value: RoomPluginOrigin) {
  const captures: RoomAuthorityCapture[] = [];
  const contexts: Array<{ close(): Promise<void> }> = [];
  await withCleanup(() => withAutoSeatRoom(browser, value, async (roomId, put) => {
      const observe = async (page: Page) => { const capture = await captureRoomAuthority(page); captures.push(capture); return capture; };
      const pages: Page[] = [];
      let submitEntries!: () => void;
      const admissionGate = new Promise<void>(resolve => { submitEntries = resolve; });
      const preparedForms = new Set<Page>();
      const observations = new Map<Page, RoomAuthorityCapture>();
      const arrivalBeganAt = performance.now();
      const arrivalPhases: Record<string, number> = {};
      const entries = [1, 2, 3, 4].map(index => enterPluginRoom(browser, value, roomId, "member", `Auto-seat member ${index}`, async (context, page) => {
        contexts.push(context); pages.push(page); observations.set(page, await observe(page));
        await installSeatAckObservation(page);
        await installSeatEntryObservation(page);
      }, async page => { preparedForms.add(page); await admissionGate; }));
      const settled = Promise.all(entries); void settled.catch(() => undefined);
      await withCleanup(async () => {
        await expect.poll(() => pages.length === 4 && preparedForms.size === 4, { timeout: 90_000 }).toBe(true);
        // All four normal invitation forms are filled and actionable BEFORE
        // admission. Release real UI clicks, never post-ready HTTP or WS traffic.
        const prepared = await Promise.all(pages.map(page => page.evaluate(() => (window as any).__t16SeatEntryFacts())));
        expect(prepared.every(facts => facts.joinClicks.length === 0 && facts.admissionStarts.length === 0 && facts.discovery.length === 0)).toBe(true);
        submitEntries();
        arrivalPhases.barrierOpened = performance.now();
        const members = (await settled).map(member => ({ ...member, participantId: member.session.participantId, authority: observations.get(member.page)! }));
        arrivalPhases.scenesLoaded = performance.now();
        arrivalPhases.entriesComplete = performance.now();
        try {
          for (const member of members) await expect.poll(async () => Boolean((await seatState(member.page)).currentSeatId), { timeout: 60_000 }).toBe(true);
        } finally {
          // Passive allowlisted facts also survive a failure before pending-disable.
          // Keep identities, URLs, config and wire payloads out of diagnostics.
          const offset = (at: number) => Math.round(at - arrivalBeganAt);
          const facts = await Promise.all(members.map(async member => ({
            state: await member.page.evaluate(() => {
              const debug = (window as any).__VRATA_DEBUG__, plugins = debug?.plugins;
              return { loaded: debug?.sceneBundleState === "loaded", connected: debug?.roomStateConnected === true,
                pending: Boolean(debug?.pendingSeatId), seated: Boolean(debug?.currentSeatId),
                state: plugins?.state ?? null, running: plugins?.running ?? null, failure: plugins?.lastFailure ?? null,
                hostPhase: plugins?.lastHostPhase ?? null, startupTiming: plugins?.startupTiming ?? null,
                readyDeliveries: plugins?.readyDeliveries ?? null,
                ack: (window as any).__t16SeatAckFacts?.() ?? null,
                entry: (window as any).__t16SeatEntryFacts?.() ?? null,
                longTasks: (window as any).__meetingPerformance?.longTasks ?? null,
                seating: plugins?.seating ?? null };
            }).catch(() => ({ unavailable: true })),
            commands: member.authority.commands().map(command => ({ type: command.type, accepted: command.accepted,
              offsetMs: offset(command.observedAtMs) }))
          })));
          console.info("t16_arrival_timing", JSON.stringify({ phaseOffsetsMs: Object.fromEntries(Object.entries(arrivalPhases).map(([phase, at]) => [phase, offset(at)])), facts }));
        }
        const seated = await Promise.all(members.map(member => seatState(member.page)));
        const seats = seated.map(state => state.currentSeatId!);
        expect(new Set(seats).size).toBe(4);
        const entryFacts = await Promise.all(members.map(member => member.page.evaluate(() => (window as any).__t16SeatEntryFacts())));
        expect(entryFacts.every(facts => facts.joinClicks.length === 1 && facts.joinClicks[0].trusted
          && facts.admissionStarts.length === 1 && facts.discovery.some((row: any) => row.responseMs !== null))).toBe(true);
        // Compare actual click times using each page's performance time origin,
        // not the scheduling of Promise.all on the test runner.
        // This is a harness synchrony bound, not a product entry/claim deadline.
        const clicks = entryFacts.map(facts => facts.timeOriginMs + facts.joinClicks[0].atMs);
        expect(Math.max(...clicks) - Math.min(...clicks) < 3000).toBe(true);
        await expectExactRoomAuthority(members);
        for (const member of members) expect(member.authority.commands().some(command => command.type === "seat_claim_result" && command.accepted
          && member.authority.commands().some(sent => sent.type === "seat_claim" && sent.commandId === command.commandId && sent.seatId === command.seatId))).toBe(true);
        const free = Array.from({ length: 8 }, (_, index) => `seat-${String(index + 1).padStart(2, "0")}`).find(id => !seats.includes(id))!;
        await runSeatProtocolRace(value, roomId, members.map(member => member.participantId), free);
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
        const late = await enterPluginRoom(browser, value, roomId, "member", "Auto-seat disabled late member", async (context, page) => {
          contexts.push(context); observations.set(page, await observe(page));
        });
        const lateActor = { ...late, participantId: late.session.participantId, authority: observations.get(late.page)! };
        await expectExactRoomAuthority([lateActor]);
        await late.page.waitForTimeout(6000);
        expect((await seatState(late.page)).currentSeatId).toBeNull(); expect(late.requests.workers).toBe(0);
        await late.context.close();
      }, () => [
        () => { submitEntries(); },
        // Closing entrants also settles failed pending admission waits before room deletion.
        () => cleanupAll(contexts.map(context => () => context.close())),
        async () => {
          const results = await Promise.allSettled(entries);
          const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
          if (errors.length) throw new AggregateError(errors, "owned_test_entries_failed");
        },
        () => cleanupAll(contexts.map(context => () => context.close())),
        () => { preparedForms.clear(); pages.length = 0; observations.clear(); }
      ]);
  }), () => [...captures.map(capture => () => capture.close()), ...contexts.map(context => () => context.close()),
    () => { captures.length = 0; contexts.length = 0; }]);
}

/** Same local/X witness, independent of four-client startup and its lifecycle.
 * Only one renderer is live during the pending protocol race. */
export async function runPendingAutoSeatScenario(browser: Browser, value: RoomPluginOrigin) {
  const captures: RoomAuthorityCapture[] = [], contexts: Array<{ close(): Promise<void> }> = [];
  const observations = new Map<Page, RoomAuthorityCapture>();
  const observe = async (page: Page) => { const capture = await captureRoomAuthority(page); captures.push(capture); return capture; };
  await withCleanup(() => withAutoSeatRoom(browser, value, (roomId, put) =>
    disablePendingClaim(browser, value, roomId, put, contexts, observations, observe)),
  () => [...captures.map(capture => () => capture.close()), ...contexts.map(context => () => context.close()),
    () => { captures.length = 0; contexts.length = 0; observations.clear(); }]);
}

async function disablePendingClaim(browser: Browser, value: RoomPluginOrigin, roomId: string, put: (enabled: boolean) => Promise<number>,
  contexts: Array<{ close(): Promise<void> }>,
  observations: Map<Page, RoomAuthorityCapture>, observe: (page: Page) => Promise<RoomAuthorityCapture>) {
  let held = false, accepted = false, releaseAck = false, claimAt = 0, releaseAt = 0;
  let claimId = "", releaseId = "";
  let claimCount = 0, releaseCount = 0;
  // Startup is normal and bounded independently. Response observation begins at
  // the actual outgoing claim, never at scene/connection entry or discovery.
  let acceptedObservation: Promise<void> | undefined;
  let responseAwaited = false;
  let finishMutation!: () => void;
  const mutationGate = new Promise<void>(resolve => { finishMutation = resolve; });
  const protocolTasks = new Set<Promise<void>>();
  let protocolError: unknown, disableTask: Promise<void> | undefined;
  let disabledRevision: number | undefined;
  const track = (task: Promise<void>) => {
    protocolTasks.add(task);
    void task.catch(error => { protocolError ??= error; }).finally(() => protocolTasks.delete(task));
  };
  const beganAt = performance.now(), phases: Record<string, number> = {};
  const mark = (phase: string) => { phases[phase] = performance.now(); };
  const runtimeReads: Array<{ at: number; status: number | null; revision: number | null; enabledBindings: number | null }> = [];
  const runtimeReadsPending = new Set<Promise<void>>();
  let runtime: { revision: number | null; lastInstanceFailure: unknown; readyDeliveries: unknown; pendingBeforeSend: boolean; startup: any; entry: any; releaseDeltaMs: number | null;
    seating: { settlements?: Array<{ reason: string }> } | null } | null = null;
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
    await installSeatDeliveryObservation(page);
    await installSeatEntryObservation(page);
    page.on("requestfinished", onRuntimeFinished);
    await page.route(url => url.pathname === pluginPath(roomId, "runtime"), async route => {
      // Only this managed cancellation witness orders a pending refresh after
      // the real Host CAS. Otherwise an enabled read racing the mutation can
      // consume the next poll slot and test lost-answer instead of retirement.
      // No response is fabricated and initial normal entrants have no route.
      if (held) await mutationGate;
      await route.continue();
    });
    await page.routeWebSocket(url => url.searchParams.has("roomId"), socket => {
      transport = socket;
      const server = socket.connectToServer();
      socket.onMessage(message => {
        let payload: any; try { payload = JSON.parse(String(message)); } catch { server.send(message); return; }
        if (payload.type === "seat_claim" && String(payload.commandId).startsWith("plugin-seat:")) {
          held = true; claimAt = performance.now(); claimId = payload.commandId;
          claimCount++; phases.firstClaim ??= claimAt;
          mark("claim");
          acceptedObservation ??= expect.poll(() => { if (protocolError) throw protocolError; return accepted; },
            { timeout: 15_000, intervals: [50] }).toBe(true);
          void acceptedObservation.catch(() => undefined);
          // The preinstalled page hook captures actual pending/current BEFORE
          // send. Verify that saved fact later, without a Node/page round trip
          // delaying the real server acceptance inside the 3000ms window.
          server.send(message);
          return;
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
            mark("disableRequested");
            disableTask = put(false).then(revision => { disabledRevision = revision; mark("disableAck"); finishMutation(); });
            track(disableTask);
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
    // entryComplete proves only scene+connection, not instance readiness or
    // handler consumption. No discovery/worker event is artificially held here.
    member = await entering;
    mark("entryComplete");
    try {
      await expect.poll(() => { if (protocolError) throw protocolError; return Boolean(claimId); },
        { timeout: 60_000, intervals: [50] }).toBe(true);
      mark("startupObserved");
      responseAwaited = true;
      await acceptedObservation;
    }
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
    expect(phases.serverAccepted - phases.firstClaim < 15_000).toBe(true);
    expect(Boolean(disableTask)).toBe(true);
    await disableTask;
    if (protocolError) throw protocolError;
    const actor = { ...member, participantId: member.session.participantId, authority: observations.get(member.page)! };
    await expect.poll(async () => (await seatState(actor.page)).running, { timeout: 15_000 }).toBe(0);
    mark("runningZeroObserved");
    await expect.poll(() => releaseAck, { timeout: 15_000 }).toBe(true);
    mark("releaseAckObserved");
    expect(releaseAt > claimAt && releaseAt - claimAt < 3000).toBe(true); // Not the adapter's lost-answer timeout.
    expect(claimCount).toBe(1); expect(releaseCount).toBe(1);
    runtime = await member.page.evaluate(() => {
      const plugins = (window as any).__VRATA_DEBUG__?.plugins;
      return { revision: plugins?.revision ?? null, lastInstanceFailure: plugins?.lastInstanceFailure,
        readyDeliveries: plugins?.readyDeliveries ?? null,
        pendingBeforeSend: (window as any).__t16SeatDelivery?.pendingBeforeSend === true,
        startup: (window as any).__t16SeatDelivery?.startup ?? null, entry: (window as any).__t16SeatEntryFacts?.() ?? null,
        releaseDeltaMs: (window as any).__t16SeatDelivery?.releaseDeltaMs ?? null,
        seating: plugins?.seating ?? null };
    });
    expect(runtime.pendingBeforeSend).toBe(true);
    expect(Number.isFinite(runtime.releaseDeltaMs) && runtime.releaseDeltaMs! > 0 && runtime.releaseDeltaMs! < 3000).toBe(true);
    // Real page-clock proof, not a fake-clock or late instance's diagnostics.
    const startup = runtime.startup;
    expect(startup?.ready === true && startup.correlation === true && startup.online === true).toBe(true);
    expect([startup?.firstReadyAtMs, startup?.openedAtMs, startup?.claimAtMs].every(Number.isFinite)).toBe(true);
    expect(startup.openedAtMs >= startup.firstReadyAtMs && startup.openedAtMs - startup.firstReadyAtMs <= 20_000).toBe(true);
    expect(startup.claimAtMs >= startup.openedAtMs && startup.claimAtMs - startup.openedAtMs < 5000).toBe(true);
    expect(runtime.entry?.joinClicks.length === 1 && runtime.entry.joinClicks[0].trusted
      && runtime.entry.admissionStarts.length === 1 && runtime.entry.discovery.some((row: any) => row.status === 200)).toBe(true);
    expect(runtime.seating?.settlements?.map(row => row.reason)).toEqual(["retired"]);
    // This fresh page has one binding/claim instance. failEntry also retires
    // seating, and empty discovery clears failed entries/lastFailure, but NOT
    // this sticky signal. retired plus failed=0 alone is not disable causality.
    expect(runtime.lastInstanceFailure, "pending instance must not fail before disabled revision").toBeNull();
    expect(Number.isSafeInteger(disabledRevision)).toBe(true);
    expect(runtime.revision).toBe(disabledRevision);
    await Promise.all(runtimeReadsPending);
    expect(runtimeReads.some(row => row.status === 200 && row.enabledBindings === 0 && row.revision === runtime!.revision)).toBe(true);
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
    await expectExactRoomAuthority([actor]);
    const state = await seatState(member.page);
    expect(state.currentSeatId === null && state.pendingSeatId === null && Object.keys(actor.authority.snapshot()!.occupancy).length === 0).toBe(true);
    expect(actor.authority.commands().some(command => command.type === "seat_claim_result" && command.commandId === claimId && command.accepted)).toBe(true);
    await member.context.close();
    let lateDiscovery!: Promise<{ revision: number; bindings: unknown[] }>;
    const late = await enterPluginRoom(browser, value, roomId, "member", "Pending disabled late member", async (context, page) => {
      contexts.push(context); observations.set(page, await observe(page));
      // Register before navigation: entryComplete is only scene+connection.
      // Neither an authority snapshot nor workers=0 proves HTTP discovery.
      lateDiscovery = page.waitForResponse(response => new URL(response.url()).pathname === pluginPath(roomId, "runtime")
        && response.status() === 200, { timeout: 15_000 }).then(response => response.json());
      void lateDiscovery.catch(() => undefined);
    });
    const disabled = await lateDiscovery;
    expect(disabled.revision).toBe(disabledRevision); expect(disabled.bindings).toEqual([]);
    await expect.poll(() => late.page.evaluate(() => {
      const plugins = (window as any).__VRATA_DEBUG__?.plugins;
      return { state: plugins?.state, revision: plugins?.revision, instances: plugins?.instances,
        running: plugins?.running, failed: plugins?.failed, failure: plugins?.lastInstanceFailure };
    }), { timeout: 15_000 }).toEqual({ state: "empty", revision: disabledRevision, instances: 0, running: 0, failed: 0, failure: null });
    const lateActor = { ...late, participantId: late.session.participantId, authority: observations.get(late.page)! };
    await expectExactRoomAuthority([lateActor]);
    const lateState = await seatState(late.page);
    expect(lateState.currentSeatId === null && lateState.pendingSeatId === null).toBe(true);
    expect(late.requests.plugin > 0).toBe(true); expect(late.requests.workers).toBe(0); expect(late.requests.wasm).toBe(0);
    expect(lateActor.authority.commands().some(command => command.type === "seat_claim")).toBe(false);
    expect(lateActor.authority.snapshot()!.occupancy).toEqual({});
    mark("lateDisabledDiscoveryVerified");
    await late.context.close();
  }, () => [() => { finishMutation(); }, () => responseAwaited ? undefined : acceptedObservation, async () => {
    await Promise.allSettled(protocolTasks);
    if (protocolError) throw protocolError;
  }, async () => {
    pendingPage?.off("requestfinished", onRuntimeFinished);
    await Promise.allSettled(runtimeReadsPending);
    const finalRuntime = runtime ?? (pendingPage && !pendingPage.isClosed() ? await pendingPage.evaluate(() => {
      const plugins = (window as any).__VRATA_DEBUG__?.plugins;
      return { revision: plugins?.revision ?? null, lastInstanceFailure: plugins?.lastInstanceFailure,
        readyDeliveries: plugins?.readyDeliveries ?? null,
        pendingBeforeSend: (window as any).__t16SeatDelivery?.pendingBeforeSend === true,
        startup: (window as any).__t16SeatDelivery?.startup ?? null, entry: (window as any).__t16SeatEntryFacts?.() ?? null,
        releaseDeltaMs: (window as any).__t16SeatDelivery?.releaseDeltaMs ?? null,
        seating: plugins?.seating ?? null };
    }).catch(() => ({ unavailable: true })) : null);
    const offset = (at: number) => Math.round((at - (claimAt || beganAt)) * 10) / 10;
    console.info("t16_pending_claim_timing", JSON.stringify({ claimCount, releaseCount, claimObserved: Boolean(claimId), acceptedObserved: accepted,
      releaseObserved: Boolean(releaseId), releaseDeltaMs: claimAt && releaseAt ? Math.round((releaseAt - claimAt) * 10) / 10 : null,
      phaseOffsetsMs: Object.fromEntries(Object.entries(phases).map(([phase, at]) => [phase, offset(at)])),
      runtimeReads: runtimeReads.map(({ at, ...row }) => ({ offsetMs: offset(at), ...row })), runtime: finalRuntime }));
    runtimeReads.length = 0; runtimeReadsPending.clear();
  }, () => { held = false; queue.length = 0; },
    () => pendingPage && !pendingPage.isClosed() ? pendingPage.evaluate(() => (window as any).__t16SeatDeliveryCleanup?.()) : undefined,
    () => pendingPage && !pendingPage.isClosed() ? transport?.close() : undefined, () => member?.context.close(),
    () => pendingPage?.context().close(), () => entering]);
}

/** Observe actual replay before navigation/claims, not inside the 3000ms cancellation window.
 * The hook only reads traffic of the runtime's own socket and delegates every call unchanged. */
async function installSeatDeliveryObservation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const dispatch = EventTarget.prototype.dispatchEvent, send = WebSocket.prototype.send;
    const state = { accepted: 0, released: 0, occupied: 0, pendingBeforeSend: false, claimId: "", claimedSeat: "", releaseId: "",
      startup: null as { claimAtMs: number; firstReadyAtMs?: number; openedAtMs?: number; ready?: boolean; correlation?: boolean; online?: boolean } | null,
      releaseDeltaMs: null as number | null };
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string" && data.length < 262_144) {
        try {
          const message = JSON.parse(data);
          if (message.type === "seat_claim" && String(message.commandId).startsWith("plugin-seat:") && !state.claimId) {
            state.claimId = message.commandId; state.claimedSeat = message.seatId;
            const debug = (window as any).__VRATA_DEBUG__;
            state.pendingBeforeSend = debug?.pendingSeatId === message.seatId && debug?.currentSeatId === null;
            const seating = debug?.plugins?.seating;
            state.startup = { claimAtMs: performance.now(), firstReadyAtMs: seating?.firstReadyAtMs,
              openedAtMs: seating?.openedAtMs, ready: seating?.ready, correlation: seating?.correlation, online: seating?.online };
          }
          if (message.type === "seat_release" && String(message.commandId).startsWith("plugin-release:") && !state.releaseId) {
            state.releaseId = message.commandId;
            state.releaseDeltaMs = state.startup ? performance.now() - state.startup.claimAtMs : null;
          }
        } catch { /* Never alter transport delivery. */ }
      }
      return send.call(this, data);
    };
    EventTarget.prototype.dispatchEvent = function (event) {
      if (this instanceof WebSocket && event instanceof MessageEvent && typeof event.data === "string" && event.data.length < 262_144) {
        try {
          const message = JSON.parse(event.data);
          if (state.claimId && message.type === "seat_claim_result" && message.seatClaimResult?.commandId === state.claimId && message.seatClaimResult.accepted === true) state.accepted++;
          if (state.releaseId && message.type === "seat_release_result" && message.seatReleaseResult?.commandId === state.releaseId) state.released++;
          if (state.claimedSeat && message.type === "room_state" && message.room?.seatOccupancy?.[state.claimedSeat] === (window as any).__VRATA_DEBUG__?.participantId) state.occupied++;
        } catch { /* Only correlated counters; no raw messages retained. */ }
      }
      return dispatch.call(this, event);
    };
    (window as any).__t16SeatDelivery = state;
    (window as any).__t16SeatDeliveryCleanup = () => {
      WebSocket.prototype.send = send; EventTarget.prototype.dispatchEvent = dispatch;
      delete (window as any).__t16SeatDelivery; delete (window as any).__t16SeatDeliveryCleanup;
    };
  });
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
