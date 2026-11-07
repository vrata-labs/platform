import type { Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ref = (value: unknown) => typeof value === "string" ? createHash("sha256").update(value).digest("hex").slice(0, 16) : null;
const code = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : null;
const numeric = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
async function bounded<T>(work: Promise<T>, fallback: T, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Retain counters and correlations, never note text, config, URLs, tokens, SDP or candidates. */
export function mediaFacts(media: any) {
  return {
    surfaces: Object.values(media?.surfaces ?? {}).slice(0, 32).map((surface: any) => ({ surface: code(surface.surfaceId),
      object: ref(surface.activeObjectId), type: code(surface.activeObjectType), revision: numeric(surface.revision), hasTexture: typeof surface.textureId === "number",
      visible: surface.visible === true, runtimeVisible: surface.runtimeVisible === true })),
    objects: Object.values(media?.objects ?? {}).slice(0, 64).map((object: any) => ({ object: ref(object.objectId),
      surface: code(object.surfaceId), type: code(object.type), revision: numeric(object.revision), owner: ref(object.ownerParticipantId),
      status: code(object.status), state: code(object.state?.status), track: ref(object.state?.mediaTrackSid),
      notes: Array.isArray(object.state?.notes) ? object.state.notes.length : null,
      strokes: Array.isArray(object.state?.strokes) ? object.state.strokes.length : null }))
  };
}

export function mediaParticipantFacts(participants: any[]) {
  return participants.slice(0, 32).map(person => {
    let binding: any = null; try { binding = JSON.parse(person.attributes?.vrataMediaBinding); } catch { /* Unbound observer. */ }
    return { identity: ref(person.identity), participant: ref(binding?.participantId), scope: code(binding?.scope),
      tracks: (person.tracks ?? []).slice(0, 16).map((track: any) => ({ track: ref(track.sid), source: track.source, type: track.type, muted: track.muted })) };
  });
}

export async function writeFunctionalDiagnostics(stage: string, facts: unknown) {
  const root = process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR;
  if (!root) { console.warn("functional_diagnostics", JSON.stringify({ stage, facts })); return; }
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(resolve(root, `${stage.replace(/[^a-zA-Z0-9_-]/g, "_")}-${randomUUID()}.json`),
    JSON.stringify({ schema: 1, stage, at: Date.now(), facts }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}

/** Observe the ORIGINAL poll promises on Node's clock; never retry or settle them.
 * Each transition is persisted independently, including after a failure attachment.
 * The bounded log contains only fixed actor/section labels and five booleans. */
export function observeMeetingPanelPoll(context: { actor?: string; section: string; touch: boolean },
  sink?: (event: object) => void, now = Date.now) {
  const actor = ["host", "member-1", "member-2", "guest"].includes(context.actor ?? "") ? context.actor : "unspecified";
  const section = ["audio", "present", "board", "notes", "people"].includes(context.section) ? context.section : "other";
  const root = process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR;
  const file = root && resolve(root, `panel-poll-${randomUUID()}.jsonl`);
  let count = 0, attempts = 0, outcome = "pending";
  const record = (event: object) => {
    if (count++ >= 128) return;
    const row = { actor, section, touch: context.touch === true, atMs: now(), outcome, ...event };
    if (sink) sink(row);
    else if (file) {
      mkdirSync(root!, { recursive: true, mode: 0o700 });
      appendFileSync(file, JSON.stringify(row) + "\n", { mode: 0o600 });
    }
  };
  // Diagnostic I/O must not change the original assertion's result.
  const safeRecord = (event: object) => { try { record(event); } catch { console.warn("panel_poll_diagnostic_write_failed"); } };
  return {
    sample<T>(action: () => Promise<T>): Promise<T> {
      const attempt = ++attempts, startedAtMs = now();
      safeRecord({ event: "start", attempt, startedAtMs });
      let original: Promise<T>;
      try { original = action(); }
      catch (error) { safeRecord({ event: "reject", attempt, startedAtMs }); throw error; }
      void original.then(value => {
        const booleans = Object.fromEntries(["open", "focused", "headingBelowNavigation", "targetWideEnough", "targetTallEnough"]
          .map(key => [key, typeof (value as any)?.[key] === "boolean" ? (value as any)[key] : null]));
        safeRecord({ event: "resolve", attempt, startedAtMs, booleans });
      }, () => safeRecord({ event: "reject", attempt, startedAtMs }));
      return original;
    },
    finish(passed: boolean) { outcome = passed ? "passed" : "failed"; safeRecord({ event: "predicate-finished" }); }
  };
}

/** Projection of the EXISTING Guest evaluate; no SDK/private room access.
 * connected-passive records a past completed startup, not a connect/device phase
 * or proof the same room is still installed (it may later disconnect).
 * No negative field here proves that installation or binding failed. */
export function guestSubscriptionFacts(value: any) {
  const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? Math.min(v, 1024) : null;
  const boolean = (v: unknown) => typeof v === "boolean" ? v : null;
  return { subscribed: count(value?.subscribed), browserNowMs: numeric(value?.browserNowMs), browserWallTimeMs: numeric(value?.browserWallTimeMs),
    passiveStartupCompleted: boolean(value?.passiveStartupCompleted), passiveStartupFailed: boolean(value?.passiveStartupFailed),
    shareErrorPresent: boolean(value?.shareErrorPresent), activeScreenPresent: boolean(value?.activeScreenPresent),
    surfaceHasTexture: boolean(value?.surfaceHasTexture), videoElements: count(value?.videoElements) };
}

/** Observe only the original Guest promise. Keep bounded DTOs in memory until
 * flush AFTER the whole protected scenario, not between its assertions. Late
 * answers keep the original failure. Configured times are not Playwright internals. */
export function observeGuestSubscriptionPoll(presenter: number, sink?: (event: object) => unknown, now = Date.now) {
  const root = process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR;
  const file = root && resolve(root, `guest-subscription-poll-${randomUUID()}.jsonl`);
  let attempts = 0, outcome = "pending", lifecycleEvents = 0;
  let configuredStartAtMs: number | null = null, predicateFinishedAtMs: number | null = null;
  const queue: object[] = [], maxPending = 146; // 64 sample pairs + 16 lifecycle + start/finish
  let enabled = false, draining: Promise<void> | null = null, diagnosticFailure: Error | null = null;
  let failureReported = false;
  const reportFailure = () => {
    if (enabled && diagnosticFailure && !failureReported) {
      failureReported = true; console.warn("guest_subscription_diagnostic_persistence_failed");
    }
  };
  const fail = () => {
    diagnosticFailure = new Error("guest_subscription_diagnostic_persistence_failed");
    queue.length = 0; reportFailure();
  };
  const drain = () => {
    if (!enabled || draining || diagnosticFailure || !queue.length) return;
    // Never execute a supplied sink in sample()/the original promise reaction.
    draining = Promise.resolve().then(async () => {
      if (!sink && file) await mkdir(root!, { recursive: true, mode: 0o700 });
      while (queue.length && !diagnosticFailure) {
        const row = queue[0];
        if (sink) await sink(row);
        else if (file) await appendFile(file, JSON.stringify(row) + "\n", { mode: 0o600 });
        else console.warn("guest_subscription_diagnostic", JSON.stringify(row));
        queue.shift();
      }
    }).catch(fail).finally(() => { draining = null; drain(); });
  };
  const record = (event: object) => {
    if (diagnosticFailure) return;
    if (queue.length >= maxPending) { fail(); return; }
    const atMs = now(), configuredDeadlineAtMs = configuredStartAtMs === null ? null : configuredStartAtMs + 20_000;
    queue.push({ actor: "guest", presenter: presenter === 1 || presenter === 2 ? presenter : null,
      configuredStartAtMs, configuredDeadlineAtMs, timeoutMs: 20_000, clockBasis: "node-before-expect-poll-call",
      atMs, afterConfiguredDeadline: configuredDeadlineAtMs === null ? null : atMs > configuredDeadlineAtMs,
      predicateFinishedAtMs, afterPredicateFinished: predicateFinishedAtMs !== null, outcome, ...event });
    drain();
  };
  return {
    start<T>(predicate: () => T): T {
      configuredStartAtMs = now();
      record({ event: "poll-start" });
      return predicate();
    },
    sample<T>(action: () => Promise<T>): Promise<T> {
      const attempt = ++attempts, sampleStartedAtMs = now(), retained = attempt <= 64;
      let original: Promise<T>;
      try { original = action(); }
      catch (error) {
        if (retained) { record({ event: "sample-start", attempt, sampleStartedAtMs }); record({ event: "sample-reject", attempt, sampleStartedAtMs }); }
        throw error;
      }
      if (retained) {
        record({ event: "sample-start", attempt, sampleStartedAtMs });
        void original.then(value => record({ event: "sample-resolve", attempt, sampleStartedAtMs, facts: guestSubscriptionFacts(value) }),
          () => record({ event: "sample-reject", attempt, sampleStartedAtMs }));
      }
      return original;
    },
    // HTTP receipt is an upper bound on startup completion, not its timestamp:
    // reportDiagnostics awaits stats/screenshot before sending the request.
    lifecycle(note: unknown, observedAtMs: number) {
      if (note !== "media_connected_passive" || lifecycleEvents++ >= 16) return;
      record({ event: "passive-startup-report-observed", observedAtMs: numeric(observedAtMs) });
    },
    finish(passed: boolean) {
      if (outcome !== "pending") return;
      outcome = passed ? "passed" : "failed";
      predicateFinishedAtMs = now();
      record({ event: "predicate-finished", attempts, omittedSamples: Math.max(0, attempts - 64) });
    },
    /** Call only after ALL protected assertions. Subsequent late rows use the
     * same handled queue, including after a failure attachment/initial flush. */
    async flush() {
      enabled = true; reportFailure(); drain();
      if (!await bounded((async () => { while (draining) await draining; return true; })(), false)) fail();
      if (diagnosticFailure) throw diagnosticFailure;
    }
  };
}

/** Export errors/timeouts cannot replace the assertion; always clean up once. */
export async function finalizeFunctionalDiagnostics(failed: boolean, persist: () => Promise<void>, cleanup: () => Promise<void>) {
  try {
    const exported = await bounded(Promise.resolve().then(persist).then(() => true), false);
    if (!exported) console.warn("functional_diagnostic_export_timed_out");
  }
  catch { console.warn("functional_diagnostic_export_failed"); }
  try { await cleanup(); }
  catch (error) { if (!failed) throw error; console.warn("functional_diagnostic_cleanup_failed"); }
}

/** Re-project browser memory in Node; never serialize arbitrary RTC fields. */
export function collectedTransportFacts(value: any) {
  const state = (v: unknown, allowed: string[]) => typeof v === "string" && allowed.includes(v) ? v : null;
  const connection = (v: unknown) => state(v, ["new", "connecting", "connected", "disconnected", "failed", "closed"]);
  const ice = (v: unknown) => state(v, ["new", "checking", "connected", "completed", "disconnected", "failed", "closed"]);
  return { unavailable: value?.unavailable === true, sampleTimedOut: value?.sampleTimedOut === true,
    browserNowMs: numeric(value?.browserNowMs), browserWallTimeMs: numeric(value?.browserWallTimeMs),
    peerConnections: (Array.isArray(value?.peerConnections) ? value.peerConnections : []).slice(0, 16).map((peer: any, index: number) => ({
      index, firstIceConnectedAtMs: numeric(peer?.firstIceConnectedAtMs), pcConnectedAtMs: numeric(peer?.pcConnectedAtMs),
      transportSample: peer?.transportSample ? { startedAtMs: numeric(peer.transportSample.startedAtMs), resolvedAtMs: numeric(peer.transportSample.resolvedAtMs),
        status: state(peer.transportSample.status, ["pending", "resolved", "rejected", "timed-out"]),
        connectionAtStart: connection(peer.transportSample.connectionAtStart), connectionAtResolve: connection(peer.transportSample.connectionAtResolve),
        iceAtStart: ice(peer.transportSample.iceAtStart), iceAtResolve: ice(peer.transportSample.iceAtResolve),
        transports: (Array.isArray(peer.transportSample.transports) ? peer.transportSample.transports : []).slice(0, 4).map((transport: any) => ({
          dtlsState: state(transport?.dtlsState, ["new", "connecting", "connected", "closed", "failed"]),
          selectedPair: transport?.selectedPair ? { state: state(transport.selectedPair.state, ["frozen", "waiting", "in-progress", "failed", "succeeded"]),
            nominated: typeof transport.selectedPair.nominated === "boolean" ? transport.selectedPair.nominated : null,
            bytesSent: numeric(transport.selectedPair.bytesSent), bytesReceived: numeric(transport.selectedPair.bytesReceived) } : null })) } : null })) };
}

/** Standalone init function so the exact browser instrumentation has pure controls. */
export function installFunctionalBrowserObservation(sampleFirstIceConnected = false) {
    const peers: RTCPeerConnection[] = [], events: any[] = [], peerConnections: any[] = [];
    const add = (event: object) => { events.push({ atMs: performance.now(), ...event }); if (events.length > 128) events.shift(); };
    (window as any).__functionalObservation = { peers, events, peerConnections };
    const Native = window.RTCPeerConnection;
    if (Native) window.RTCPeerConnection = new Proxy(Native, { construct(target, args) {
      const peer = Reflect.construct(target, args) as RTCPeerConnection, index = peers.length;
      if (index >= 16) return peer;
      peers.push(peer);
      const facts = { index, firstIceConnectedAtMs: null as number | null, pcConnectedAtMs: null as number | null,
        transportSample: null as any };
      peerConnections.push(facts);
      const sampleTransport = () => {
        if (!sampleFirstIceConnected || facts.firstIceConnectedAtMs !== null || peer.iceConnectionState !== "connected") return;
        facts.firstIceConnectedAtMs = performance.now();
        const sample = facts.transportSample = { startedAtMs: performance.now(), resolvedAtMs: null as number | null,
          connectionAtStart: peer.connectionState, iceAtStart: peer.iceConnectionState,
          status: "pending", transports: [] as object[] };
        add({ kind: "rtc-transport-start", index, startedAtMs: sample.startedAtMs });
        let settled = false;
        const timer = setTimeout(() => finish("timed-out"), 5000);
        const finish = (status: string, transports: object[] = []) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          Object.assign(sample, { status, resolvedAtMs: performance.now(), connectionAtResolve: peer.connectionState, iceAtResolve: peer.iceConnectionState, transports });
          add({ kind: "rtc-transport-result", index, ...sample });
        };
        const state = (value: unknown, allowed: string[]) => typeof value === "string" && allowed.includes(value) ? value : null;
        const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
        try {
          void peer.getStats().then(report => {
            const transports: object[] = [];
            report.forEach(value => {
              if (value.type !== "transport" || transports.length >= 4) return;
              const pair = report.get(value.selectedCandidatePairId);
              transports.push({ type: "transport", dtlsState: state(value.dtlsState, ["new", "connecting", "connected", "closed", "failed"]),
                selectedPair: pair?.type === "candidate-pair" ? { type: "candidate-pair",
                  state: state(pair.state, ["frozen", "waiting", "in-progress", "failed", "succeeded"]),
                  nominated: typeof pair.nominated === "boolean" ? pair.nominated : null,
                  bytesSent: number(pair.bytesSent), bytesReceived: number(pair.bytesReceived) } : null });
            });
            finish("resolved", transports);
          }, () => finish("rejected")).catch(() => finish("rejected"));
        } catch { finish("rejected"); }
      };
      for (const event of ["connectionstatechange", "iceconnectionstatechange", "signalingstatechange", "track"]) {
        peer.addEventListener(event, () => {
          if (event === "connectionstatechange" && peer.connectionState === "connected" && facts.pcConnectedAtMs === null) facts.pcConnectedAtMs = performance.now();
          add({ kind: "rtc", index, event, connection: peer.connectionState, ice: peer.iceConnectionState, signaling: peer.signalingState });
          if (event === "iceconnectionstatechange") sampleTransport();
        });
      }
      return peer;
    } });
    // Observe only the trusted plugin kernel's phase headers, not author code/config/effects.
    const WorkerClass = window.Worker;
    if (WorkerClass) window.Worker = new Proxy(WorkerClass, { construct(target, args) {
      const worker = Reflect.construct(target, args) as Worker;
      if (!/room-plugin-(?:worker|kernel)-/.test(String(args[0]))) return worker;
      const index = workerIndex++;
      add({ kind: "worker-created", index });
      const record = (direction: string, value: any) => add({ kind: "worker", index, direction,
        type: ["prepare", "prepared", "init", "event", "result", "failed", "closed", "terminate", "requests", "respond", "cancel"].includes(value?.type) ? value.type : "other",
        id: typeof value?.id === "number" ? value.id : null,
        hostPhase: typeof value?.hostPhase === "string" && /^[a-z-]{1,60}$/.test(value.hostPhase) ? value.hostPhase : null,
        failure: typeof value?.failure === "string" && /^[a-z_-]{1,60}$/.test(value.failure) ? value.failure : null,
        moduleAgeMs: typeof value?.startupTiming?.moduleAgeMs === "number" ? value.startupTiming.moduleAgeMs : null,
        prepareMs: typeof value?.startupTiming?.prepareMs === "number" ? value.startupTiming.prepareMs : null });
      worker.addEventListener("message", event => record("received", event.data));
      const post = worker.postMessage;
      worker.postMessage = function (...args: any[]) { record("sent", args[0]); return Reflect.apply(post, this, args); };
      return worker;
    } });
    let workerIndex = 0;
}

/** Passive observation of EXISTING transports. No new participant, socket, route or mocked transport. */
export async function observeFunctionalClient(page: Page, options: { transportAtFirstIceConnected?: boolean } = {}) {
  const started = Date.now(), events: any[] = [], sockets = new Set<string>();
  const add = (event: object) => { events.push({ atMs: Date.now() - started, ...event }); if (events.length > 256) events.shift(); };
  const cdp = await page.context().newCDPSession(page);
  const created = (event: any) => {
    try { if (new URL(event.url).searchParams.has("roomId")) { sockets.add(event.requestId); add({ kind: "socket-created" }); } } catch { /* No raw URL. */ }
  };
  const closed = (event: any) => { if (sockets.delete(event.requestId)) add({ kind: "socket-closed" }); };
  const frame = (direction: string, event: any) => {
    if (!sockets.has(event.requestId) || event.response.opcode !== 1 || event.response.payloadData.length > 262144) return;
    let message: any; try { message = JSON.parse(event.response.payloadData); } catch { return; }
    if (direction === "received" && message.type === "room_state") {
      const facts = mediaFacts(message.room?.mediaObjects), signature = JSON.stringify(facts);
      if (signature !== lastMedia) { lastMedia = signature; add({ kind: "room-media", facts }); }
    } else if (/^surface_/.test(message.type) || message.type === "access_denied") {
      const value = direction === "sent" ? message : message.result;
      add({ kind: "command", direction, type: code(message.type), command: ref(value?.commandId), surface: code(value?.surfaceId),
        object: ref(value?.objectId), expectedRevision: numeric(value?.expectedRevision), revision: numeric(value?.revision),
        patchType: code(value?.patch?.type), accepted: typeof value?.accepted === "boolean" ? value.accepted : null, reason: code(value?.blockedReason) });
    }
  };
  let lastMedia = "";
  const sent = (event: any) => frame("sent", event), received = (event: any) => frame("received", event);
  cdp.on("Network.webSocketCreated", created); cdp.on("Network.webSocketClosed", closed);
  cdp.on("Network.webSocketFrameSent", sent); cdp.on("Network.webSocketFrameReceived", received);
  await cdp.send("Network.enable");
  const requests = new WeakMap<object, number>();
  const guestPolls = new Set<ReturnType<typeof observeGuestSubscriptionPoll>>();
  let passiveReportObservedAtMs: number | null = null;
  const request = (request: any) => {
    requests.set(request, Date.now());
    try {
      if (request.method() !== "POST" || !/^\/api\/rooms\/[^/]+\/diagnostics$/.test(new URL(request.url()).pathname)) return;
      // Discard the rest of this existing request immediately; no headers/body retained.
      if (request.postDataJSON()?.note !== "media_connected_passive") return;
      passiveReportObservedAtMs = Date.now();
      for (const poll of guestPolls) poll.lifecycle("media_connected_passive", passiveReportObservedAtMs);
    } catch { /* Not a diagnostics JSON request. */ }
  };
  const failedRequest = (request: any) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/tokens/media" || /\/plugins\/(?:runtime|bindings)/.test(path)) {
      add({ kind: "request-failed", mediaToken: path === "/api/tokens/media", elapsedMs: Date.now() - (requests.get(request) ?? Date.now()) });
    }
  };
  const pending = new Set<Promise<void>>();
  const response = (response: any) => {
    const path = new URL(response.url()).pathname;
    const kind = path === "/api/tokens/media" ? "media-token" : /\/plugins\/(?:runtime|bindings)/.test(path) ? "plugin-http" : null;
    if (!kind) return;
    const job = (async () => {
      const body = await response.json().catch(() => null);
      let grant: any = null;
      // Decode only in memory, then immediately discard the credential.
      try { grant = JSON.parse(Buffer.from(body.token.split(".")[1], "base64url").toString()).video; } catch { /* Denial/non-JWT. */ }
      add({ kind, status: response.status(), elapsedMs: Date.now() - (requests.get(response.request()) ?? Date.now()),
        revision: numeric(body?.revision), leaseExpiresAtMs: numeric(body?.leaseExpiresAtMs),
        bindingCount: Array.isArray(body?.bindings) ? body.bindings.length : null,
        identity: ref((() => { try { return JSON.parse(Buffer.from(body.token.split(".")[1], "base64url").toString()).sub; } catch { return null; } })()),
        role: code(body?.access?.role), reason: code(body?.reason ?? body?.error),
        canSubscribe: typeof grant?.canSubscribe === "boolean" ? grant.canSubscribe : null,
        canPublish: typeof grant?.canPublish === "boolean" ? grant.canPublish : null,
        sources: Array.isArray(grant?.canPublishSources) ? grant.canPublishSources.map((v: unknown) => typeof v === "number" ? v : code(v)) : null });
    })();
    pending.add(job); void job.finally(() => pending.delete(job));
  };
  page.on("request", request); page.on("response", response); page.on("requestfailed", failedRequest);
  await page.addInitScript(installFunctionalBrowserObservation, options.transportAtFirstIceConnected === true);
  return {
    mark(label: string) { add({ kind: "checkpoint", label }); },
    observeGuestSubscription(presenter: number) {
      const poll = observeGuestSubscriptionPoll(presenter);
      guestPolls.add(poll);
      if (passiveReportObservedAtMs !== null) poll.lifecycle("media_connected_passive", passiveReportObservedAtMs);
      return poll;
    },
    /** Read only bounded one-shot facts already collected by the init script.
     * Unlike snapshot(), this does NOT request fresh native getStats. */
    async collectedTransportSnapshot() {
      return collectedTransportFacts(await bounded(page.evaluate(() => {
        const observation = (window as any).__functionalObservation;
        return { browserNowMs: performance.now(), browserWallTimeMs: Date.now(),
          peerConnections: (observation?.peerConnections ?? []).slice(0, 16) };
      }).catch(() => ({ unavailable: true } as any)), { unavailable: true, sampleTimedOut: true } as any));
    },
    async snapshot() {
      const begin = Date.now();
      const facts = await bounded(page.evaluate(async () => {
        const d = (window as any).__VRATA_DEBUG__, observation = (window as any).__functionalObservation;
        const peers = await Promise.all((observation?.peers ?? []).map(async (peer: RTCPeerConnection) => {
          const counters: any[] = [];
          try { (await peer.getStats()).forEach(value => {
            if (!["inbound-rtp", "outbound-rtp", "transport"].includes(value.type)) return;
            counters.push({ type: value.type, kind: value.kind, track: value.trackIdentifier, packetsReceived: value.packetsReceived, bytesReceived: value.bytesReceived,
              framesDecoded: value.framesDecoded, bytesSent: value.bytesSent, dtlsState: value.dtlsState });
          }); } catch { /* Closed native peer. */ }
          return { connection: peer.connectionState, ice: peer.iceConnectionState, signaling: peer.signalingState,
            receivers: peer.getReceivers().map(receiver => ({ track: receiver.track?.id, kind: receiver.track?.kind, ready: receiver.track?.readyState, muted: receiver.track?.muted })), counters };
        }));
        const performanceState = (window as any).__meetingPerformance;
        return { browserNowMs: performance.now(), browserWallTimeMs: Date.now(), scene: d?.sceneBundleState, connected: d?.roomStateConnected, role: d?.access?.role,
          access: { lastDeniedPermission: d?.access?.lastDeniedPermission, lastSurfaceCommandAccepted: d?.access?.lastSurfaceCommandAccepted,
            canStartScreenShare: d?.access?.canStartScreenShare },
          controls: { selectedSurface: document.querySelector<HTMLSelectElement>("#media-surface-select")?.value,
            stickyDisabled: document.querySelector<HTMLButtonElement>("#add-sticky-note")?.disabled,
            consentOpen: document.querySelector<HTMLDialogElement>("#meeting-replace-dialog")?.open },
          audioState: d?.audioState, shareState: d?.screenShareState, issue: d?.issueCode,
          // Projection to safe fields is completed outside this browser call.
          media: { surfaces: d?.mediaObjects?.surfaces, objects: (d?.mediaObjects?.objects ?? []).map((o: any) => ({
            objectId: o.objectId, surfaceId: o.surfaceId, type: o.type, revision: o.revision, ownerParticipantId: o.ownerParticipantId, status: o.status,
            state: { status: o.state?.status, mediaTrackSid: o.state?.mediaTrackSid, notes: o.state?.notes?.map(() => null), strokes: o.state?.strokes?.map(() => null) } })) },
          share: { publishing: d?.screenShare?.localPublishing, subscribed: d?.screenShare?.remoteSubscribedTrackCount,
            track: d?.screenShare?.publishedTrackSid, error: d?.screenShare?.errorCode },
          plugins: d?.plugins, peers, events: observation?.events, peerConnections: observation?.peerConnections,
          audio: { joined: d?.media?.audioJoined, source: d?.media?.audioSource, subscribed: d?.media?.subscribedAudioCount },
          proxy: { resets: d?.mediaObjects?.runtimeResetCount, missingPhysical: d?.mediaObjects?.logicalSurfaceIdsWithoutPhysicalView,
            missingLogical: d?.mediaObjects?.physicalSurfaceIdsWithoutLogicalState, unrenderedCount: d?.mediaObjects?.unrenderedObjectIds?.length },
          performance: performanceState ? { longTasks: performanceState.longTasks, statsPending: performanceState.statsPending,
            statsMaxMs: performanceState.statsMaxMs, frameAgeMs: performanceState.frames.length ? performance.now() - performanceState.frames.at(-1) : null } : null,
          capabilities: { secure: isSecureContext, mediaDevices: !!navigator.mediaDevices,
            displayCapture: typeof navigator.mediaDevices?.getDisplayMedia === "function", userCapture: typeof navigator.mediaDevices?.getUserMedia === "function" },
          videos: [...document.querySelectorAll("video")].map(video => ({ width: video.videoWidth, height: video.videoHeight,
            ready: video.readyState, paused: video.paused, frames: video.getVideoPlaybackQuality().totalVideoFrames,
            tracks: video.srcObject instanceof MediaStream ? video.srcObject.getTracks().map(track => track.id) : [] })) };
      }).catch(() => ({ unavailable: true } as any)), { unavailable: true, sampleTimedOut: true } as any);
      const media = mediaFacts(facts.media); delete facts.media;
      if (facts.share) facts.share.track = ref(facts.share.track);
      for (const peer of facts.peers ?? []) {
        for (const value of [...peer.receivers, ...peer.counters]) value.track = ref(value.track);
      }
      for (const video of facts.videos ?? []) video.tracks = video.tracks.map(ref);
      // Runtime plugin diagnostics contain no source/config/status text; retain only scalar phases and timings.
      const p = facts.plugins;
      facts.plugins = p ? Object.fromEntries(["state", "revision", "fetchPending", "instances", "running", "failed", "remainingLeaseMs", "lastFailure", "lastInstanceFailure", "lastHostPhase", "hostFailed", "startupTiming", "retirements"].map(key => [key, p[key]])) : null;
      return { ...facts, media, observationStartedAtMs: started, sampleMs: Date.now() - begin, events: [...events], browserEvents: facts.events };
    },
    async close() {
      const polls = [...guestPolls]; guestPolls.clear();
      page.off("request", request); page.off("response", response); page.off("requestfailed", failedRequest);
      cdp.off("Network.webSocketCreated", created); cdp.off("Network.webSocketClosed", closed);
      cdp.off("Network.webSocketFrameSent", sent); cdp.off("Network.webSocketFrameReceived", received);
      await bounded(Promise.allSettled([...pending]), [], 1000); if (!page.isClosed()) await cdp.detach();
      await Promise.all(polls.map(poll => poll.flush()));
    }
  };
}
export type FunctionalObservation = Awaited<ReturnType<typeof observeFunctionalClient>>;
