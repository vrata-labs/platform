import type { Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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

/** Passive observation of EXISTING transports. No new participant, socket, route or mocked transport. */
export async function observeFunctionalClient(page: Page) {
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
  const request = (request: any) => { requests.set(request, Date.now()); };
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
  await page.addInitScript(() => {
    const peers: RTCPeerConnection[] = [], events: any[] = [];
    const add = (event: object) => { events.push({ atMs: performance.now(), ...event }); if (events.length > 128) events.shift(); };
    (window as any).__functionalObservation = { peers, events };
    const Native = window.RTCPeerConnection;
    if (Native) window.RTCPeerConnection = new Proxy(Native, { construct(target, args) {
      const peer = Reflect.construct(target, args) as RTCPeerConnection, index = peers.length;
      if (peers.length < 16) peers.push(peer);
      for (const event of ["connectionstatechange", "iceconnectionstatechange", "signalingstatechange", "track"]) {
        peer.addEventListener(event, () => add({ kind: "rtc", index, event, connection: peer.connectionState, ice: peer.iceConnectionState, signaling: peer.signalingState }));
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
  });
  return {
    mark(label: string) { add({ kind: "checkpoint", label }); },
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
          plugins: d?.plugins, peers, events: observation?.events,
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
      page.off("request", request); page.off("response", response); page.off("requestfailed", failedRequest);
      cdp.off("Network.webSocketCreated", created); cdp.off("Network.webSocketClosed", closed);
      cdp.off("Network.webSocketFrameSent", sent); cdp.off("Network.webSocketFrameReceived", received);
      await bounded(Promise.allSettled([...pending]), [], 1000); if (!page.isClosed()) await cdp.detach();
    }
  };
}
export type FunctionalObservation = Awaited<ReturnType<typeof observeFunctionalClient>>;
