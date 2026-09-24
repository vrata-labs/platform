import { test, type Page, type CDPSession } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { cpus, freemem, totalmem, loadavg } from "node:os";
import { createHash } from "node:crypto";

type Peer = "publisher" | "viewer";
type RecordValue = Record<string, unknown>;
const outgoing = new Set(["surface_create_object", "surface_patch_object_state", "surface_stop_object"]);
const phases = ["idle", "selecting", "publishing", "active", "stopped", "failed"];
function code(value: unknown, allowed: string[]): string | null {
  return typeof value === "string" ? allowed.includes(value) ? value : "other" : null;
}

// Branch-only diagnosis. No tokens, URLs, SDP, raw IDs or screen pixels are retained.
export async function observeScreenShare(clients: ReadonlyArray<readonly [Page, Peer]>) {
  const variant = ["direct-baseline", "baseline", "candidate", "direct-baseline"][test.info().repeatEachIndex];
  if (!variant) throw new Error("invalid_diagnostic_observation");
  const bundleVariant = variant === "candidate" ? "candidate" : "baseline";
  const bundle = readFileSync(`diagnostic-bundles/${bundleVariant}.js`);
  const bundleSha256 = createHash("sha256").update(bundle).digest("hex");
  const expectedHash = bundleVariant === "baseline" ? "6685a20d20277c5930b8e1c7e106ab6bb7f77454e559c64d265f85f5581e2615" : "596f0a89cf0b4dbc3b9676fed6f99798f7e27cf12f8797890fc1c5027d90a5db";
  if (bundleSha256 !== expectedHash) throw new Error("diagnostic_bundle_hash_mismatch");
  const clientSourceSha = bundleVariant === "baseline" ? "54e13fec4ee14134597c6520a3cfa9b0db291032" : "4ba3fc6d8e0d667bd69143e749d0dc94f0846997";
  const served = new Map<Peer, number>();
  const observedHashes = new Map<Peer, string>();
  const bodyChecks: Promise<void>[] = [];
  const cdpClients: Array<readonly [Peer, CDPSession]> = [];
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
    if (variant !== "direct-baseline") {
      await page.route(url => url.pathname === "/assets/main-DX4Wj_52.js", async route => {
        record(peer, "client-bundle-route", { variant, bundleSha256 });
        await route.fulfill({ status: 200, contentType: "application/javascript", body: bundle, headers: { "cache-control": "no-store" } });
      });
    }
    // The direct controls do not install a route or alter request/cache behavior.
    page.on("response", response => {
      if (new URL(response.url()).pathname !== "/assets/main-DX4Wj_52.js") return;
      const check = response.body().then(bytes => {
        const actual = createHash("sha256").update(bytes).digest("hex");
        observedHashes.set(peer, actual);
        served.set(peer, (served.get(peer) ?? 0) + 1);
        record(peer, "client-bundle-observed", { matchesExpected: actual === expectedHash });
      }).catch(() => { record(peer, "client-bundle-unavailable"); });
      bodyChecks.push(check);
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    cdpClients.push([peer, cdp]);
    page.on("websocket", socket => {
      record(peer, "websocket-open");
      socket.on("framesent", event => frame(peer, "sent", event.payload));
      socket.on("framereceived", event => frame(peer, "received", event.payload));
      socket.on("close", () => record(peer, "websocket-close"));
      socket.on("socketerror", () => record(peer, "websocket-error"));
    });
    page.on("pageerror", () => record(peer, "page-error"));
  }
  function hostResources() {
    try {
      const cpu = readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
      let chromeProcesses = 0, summedRssKiB = 0, chromeCpuTicks = 0;
      for (const pid of readdirSync("/proc")) {
        if (!/^\d+$/.test(pid)) continue;
        try {
          const name = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
          if (!/^(chrome|chromium|headless_shell)/.test(name)) continue;
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
          const status = readFileSync(`/proc/${pid}/status`, "utf8");
          chromeProcesses++;
          chromeCpuTicks += Number(fields[11]) + Number(fields[12]);
          summedRssKiB += Number(status.match(/^VmRSS:\s+(\d+) kB/m)?.[1] ?? 0);
        } catch { /* A process may exit between observations. */ }
      }
      return { logicalCpus: cpus().length, freeMiB: Math.round(freemem()/1048576), totalMiB: Math.round(totalmem()/1048576), load: loadavg(), hostCpuTicks: cpu.slice(0, 8).reduce((a,b) => a+b, 0), hostIdleTicks: cpu[3]+cpu[4], chromeProcesses, summedRssKiB, chromeCpuTicks };
    } catch { return { unavailable: true }; }
  }
  async function sample() {
    record("test", "host-resources", hostResources());
    for (const [peer, cdp] of cdpClients) {
      try {
        const { metrics } = await cdp.send("Performance.getMetrics");
        const allowed = new Set(["Timestamp", "TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "JSHeapUsedSize", "JSHeapTotalSize", "Nodes", "Frames"]);
        record(peer, "page-performance", Object.fromEntries(metrics.filter((m: {name:string;value:number}) => allowed.has(m.name) && Number.isFinite(m.value)).map((m: {name:string;value:number}) => [m.name, m.value])));
      } catch { record(peer, "performance-unavailable"); }
    }
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
            visibility: safe(document.visibilityState, ["visible", "hidden"]),
            pageClockMs: Math.round(performance.now()),
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
      await Promise.race([Promise.all(bodyChecks), new Promise(resolve => setTimeout(resolve, 2000))]);
      active = false;
      await test.info().attach("share-phase-timeline", {
        body: JSON.stringify({ version: 3, observedBundleHashes: Object.fromEntries(observedHashes), variant, clientSourceSha, bundleSha256, bundleRequests: Object.fromEntries(served), deployedSha: process.env.EXPECTED_STAGING_SHA, sourceSha: process.env.DIAGNOSTIC_SOURCE_SHA, dropped, events }),
        contentType: "application/json"
      });
    }
  };
}
