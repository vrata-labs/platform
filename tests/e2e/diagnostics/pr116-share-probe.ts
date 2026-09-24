import { test, type Page } from "@playwright/test";

type Peer = "publisher" | "viewer";
type RecordValue = Record<string, unknown>;
const outgoing = new Set(["surface_create_object", "surface_patch_object_state", "surface_stop_object"]);
const phases = ["idle", "selecting", "publishing", "active", "stopped", "failed"];
function code(value: unknown, allowed: string[]): string | null {
  return typeof value === "string" ? allowed.includes(value) ? value : "other" : null;
}

// Branch-only diagnosis. No tokens, URLs, SDP, raw IDs or screen pixels are retained.
export function observeScreenShare(clients: ReadonlyArray<readonly [Page, Peer]>) {
  const started = performance.now();
  const events: RecordValue[] = [];
  const ids = new Map<string, number>();
  const lastStates = new Map<Peer, string>();
  let dropped = 0;
  let active = true;
  let pending: Promise<void> | null = null;
  function id(value: unknown): number | null {
    if (typeof value !== "string" || !value) return null;
    if (!ids.has(value)) ids.set(value, ids.size + 1);
    return ids.get(value)!;
  }
  function record(peer: Peer | "test", kind: string, fields: RecordValue = {}) {
    if (!active) return;
    if (events.length >= 1600) { dropped++; return; }
    events.push({ ms: Math.round(performance.now() - started), peer, kind, ...fields });
  }
  function frame(peer: Peer, direction: "sent" | "received", payload: string | Buffer) {
    if (typeof payload !== "string" || payload.length > 262144) return;
    let value: any;
    try { value = JSON.parse(payload); } catch { return; }
    if (!value || typeof value !== "object") return;
    if (direction === "sent" && outgoing.has(value.type)) {
      record(peer, "command", {
        command: id(value.commandId), object: id(value.objectId), type: value.type,
        revision: typeof value.expectedRevision === "number" ? value.expectedRevision : null,
        patch: code(value.patch?.type, ["mark-selecting", "mark-publishing", "mark-active", "mark-failed"]),
        hasTrackSid: Boolean(value.patch?.mediaTrackSid)
      });
    } else if (direction === "received" && ["surface_command_result", "access_denied"].includes(value.type)) {
      const r = value.result ?? {};
      record(peer, "command-result", {
        command: id(r.commandId), object: id(r.objectId), accepted: r.accepted === true,
        revision: typeof r.revision === "number" ? r.revision : null,
        reason: code(r.blockedReason, ["stale-revision", "surface-occupied", "missing-object", "missing-surface", "object-surface-mismatch", "permission-denied", "invalid-patch"])
      });
    } else if (direction === "received" && value.type === "room_state") {
      const objects = Object.values(value.room?.mediaObjects?.objects ?? {})
        .filter((o: any) => o?.type === "screen-share").map((o: any) => ({
          object: id(o.objectId), revision: typeof o.revision === "number" ? o.revision : null, status: code(o.state?.status, phases),
          hasTrackSid: Boolean(o.state?.mediaTrackSid), hasError: Boolean(o.state?.errorCode)
        }));
      const key = JSON.stringify(objects);
      if (lastStates.get(peer) !== key) { lastStates.set(peer, key); record(peer, "room-share-state", { objects }); }
    }
  }
  for (const [page, peer] of clients) {
    page.on("websocket", socket => {
      record(peer, "websocket-open");
      socket.on("framesent", event => frame(peer, "sent", event.payload));
      socket.on("framereceived", event => frame(peer, "received", event.payload));
      socket.on("close", () => record(peer, "websocket-close"));
      socket.on("socketerror", () => record(peer, "websocket-error"));
    });
    page.on("pageerror", () => record(peer, "page-error"));
  }
  async function sample() {
    await Promise.all(clients.map(async ([page, peer]) => {
      if (page.isClosed()) return;
      try {
        const snapshot = await page.evaluate(() => {
          const d = (window as any).__VRATA_DEBUG__;
          if (!d) return null;
          const safe = (value: any, values: string[]) => typeof value === "string" ? values.includes(value) ? value : "other" : null;
          return {
            scene: safe(d.sceneBundleState, ["loaded", "loading", "fallback", "failed"]),
            connected: d.roomStateConnected === true,
            phase: safe(d.screenShareState, ["idle", "starting", "sharing", "receiving", "stopped", "error", "unsupported"]),
            active: d.screenShare?.active === true, local: d.screenShare?.localPublishing === true,
            hasSid: Boolean(d.screenShare?.publishedTrackSid), hasError: Boolean(d.screenShare?.errorCode),
            subscriptionCount: d.screenShare?.remoteSubscribedTrackCount ?? null,
            source: (window as any).__referenceCaptureProbe?.() ?? null,
            videos: Array.from(document.querySelectorAll("video")).slice(0, 4).map(v => ({
              width: v.videoWidth, height: v.videoHeight, ready: v.readyState, paused: v.paused,
              frames: v.getVideoPlaybackQuality().totalVideoFrames
            })),
            transports: (d.media?.webrtc?.transports ?? []).slice(0, 4).map((t: any) => ({
              role: safe(t.role, ["publisher", "subscriber"]),
              connection: safe(t.connectionState, ["new", "connecting", "connected", "disconnected", "failed", "closed"]),
              ice: safe(t.iceConnectionState, ["new", "checking", "connected", "completed", "disconnected", "failed", "closed"]),
              signaling: safe(t.signalingState, ["stable", "have-local-offer", "have-remote-offer", "have-local-pranswer", "have-remote-pranswer", "closed"]),
              pair: safe(t.selectedCandidatePair?.state, ["frozen", "waiting", "in-progress", "failed", "succeeded"]),
              bytesSent: t.selectedCandidatePair?.bytesSent ?? null,
              bytesReceived: t.selectedCandidatePair?.bytesReceived ?? null
            }))
          };
        });
        if (snapshot) record(peer, "snapshot", snapshot);
      } catch { record(peer, "sample-unavailable"); }
    }));
  }
  const timer = setInterval(() => {
    if (!active || pending) return;
    pending = sample().finally(() => { pending = null; });
  }, 1000);
  return {
    mark(phase: string) { record("test", phase); },
    async stop() {
      clearInterval(timer);
      if (pending) await Promise.race([pending, new Promise<void>(resolve => setTimeout(resolve, 2000))]);
      active = false;
      await test.info().attach("share-phase-timeline", {
        body: JSON.stringify({ version: 1, deployedSha: process.env.EXPECTED_STAGING_SHA, sourceSha: process.env.DIAGNOSTIC_SOURCE_SHA, dropped, events }),
        contentType: "application/json"
      });
    }
  };
}
