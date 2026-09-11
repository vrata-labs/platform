import { createHash } from "node:crypto";

const MAX_REQUESTS = 100;
const MAX_SAMPLES = 120;
const STAGES = new Set([
  "manifest_requested", "manifest_loaded", "asset_load_started", "asset_response_requested",
  "asset_response_received", "asset_buffer_loaded", "asset_parsed", "asset_loaded",
  "material_overrides_applied", "scene_added", "spawn_applied", "loaded"
]);
const finite = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const milliseconds = (seconds) => Math.round(seconds * 1000);

// Deliberately do not retain URLs, query strings, credentials, bodies or arbitrary headers.
export function sceneAssetIdentity(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!/^https?:$/.test(url.protocol) || !/^\/assets\/scenes\//.test(url.pathname)) return null;
    const kind = /\/scene\.json$/i.test(url.pathname) ? "manifest"
      : /\.glb$/i.test(url.pathname) ? "glb" : null;
    if (!kind) return null;
    const sceneId = url.pathname.split("/")[3];
    return {
      assetKey: createHash("sha256").update(url.origin + url.pathname).digest("hex").slice(0, 16),
      scene: sceneId === "sense-hall2-v1" ? "Hall"
        : sceneId === "sense-blueoffice-glb-v4" ? "BlueOffice" : "other",
      kind
    };
  } catch { return null; }
}

// CDP timestamps are monotonic seconds. Body bytes and total encoded transfer bytes differ.
export function createSceneNetworkRecorder(now = () => performance.now()) {
  const startedAt = now();
  const requests = [];
  const active = new Map();
  let droppedRequests = 0;
  let closed = false;
  let frozen = null;
  let runtime = null;
  let runtimeSamples = 0;
  const elapsed = () => Math.round(now() - startedAt);
  const offset = (record, timestamp) => finite(timestamp) === null ? null
    : Math.max(0, milliseconds(timestamp - record.timestamp));
  const header = (headers, name) => Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
  const sample = (record, timestamp, force = false) => {
    const atMs = offset(record, timestamp);
    if (atMs === null || (!force && atMs - (record.samples.at(-1)?.atMs ?? -1000) < 1000)) return;
    const point = { atMs, bodyBytes: record.bodyBytes, encodedBodyBytes: record.encodedBodyBytes };
    if (record.samples.length < MAX_SAMPLES) record.samples.push(point);
    else { record.samples[MAX_SAMPLES - 1] = point; record.truncatedSamples = true; }
  };
  return {
    event(name, event) {
      if (closed) return;
      if (name === "Network.requestWillBeSent") {
        const previous = active.get(event.requestId);
        if (previous) {
          previous.state = "redirected";
          previous.finishedMs = offset(previous, event.timestamp);
          active.delete(event.requestId);
        }
        const identity = sceneAssetIdentity(event.request?.url);
        if (!identity || finite(event.timestamp) === null) return;
        if (requests.length >= MAX_REQUESTS) { droppedRequests += 1; return; }
        const record = {
          ...identity, timestamp: event.timestamp, observedStartMs: elapsed(), state: "pending",
          status: null, protocol: null, expectedBodyBytes: null, compressed: false,
          bodyBytes: 0, encodedBodyBytes: 0, encodedTransferBytes: null,
          headersMs: null, firstDataMs: null, lastDataMs: null, finishedMs: null,
          fromCache: false, fromServiceWorker: false, errorCode: null, canceled: false,
          samples: [], truncatedSamples: false
        };
        requests.push(record);
        active.set(event.requestId, record);
        return;
      }
      const record = active.get(event.requestId);
      if (!record) return;
      if (name === "Network.responseReceived") {
        const response = event.response ?? {};
        record.headersMs = offset(record, event.timestamp);
        record.status = finite(response.status);
        record.protocol = ["h2", "h3", "http/1.1", "http/1.0"].includes(response.protocol) ? response.protocol : "other";
        const length = header(response.headers, "content-length");
        record.expectedBodyBytes = /^\d+$/.test(String(length)) && Number.isSafeInteger(Number(length)) ? Number(length) : null;
        record.compressed = !!header(response.headers, "content-encoding") && header(response.headers, "content-encoding") !== "identity";
        record.fromCache ||= !!(response.fromDiskCache || response.fromPrefetchCache);
        record.fromServiceWorker = !!response.fromServiceWorker;
      } else if (name === "Network.dataReceived") {
        const atMs = offset(record, event.timestamp);
        record.bodyBytes += Math.max(0, finite(event.dataLength) ?? 0);
        record.encodedBodyBytes += Math.max(0, finite(event.encodedDataLength) ?? 0);
        record.firstDataMs ??= atMs;
        record.lastDataMs = atMs;
        sample(record, event.timestamp);
      } else if (name === "Network.requestServedFromCache") {
        record.fromCache = true;
      } else if (name === "Network.loadingFinished" || name === "Network.loadingFailed") {
        record.state = name === "Network.loadingFinished" ? "finished" : "failed";
        record.finishedMs = offset(record, event.timestamp);
        record.encodedTransferBytes = finite(event.encodedDataLength);
        // Chromium error codes are useful; raw error text could contain a signed URL.
        record.errorCode = /^net::ERR_[A-Z0-9_]+$/.test(event.errorText ?? "") ? event.errorText : null;
        record.canceled = event.canceled === true;
        sample(record, event.timestamp, true);
        active.delete(event.requestId);
      }
    },
    runtimeSample(value) {
      if (closed || !value || typeof value !== "object") return;
      runtimeSamples += 1;
      runtime = {
        observedAtMs: elapsed(),
        state: ["fallback", "loaded", "failed"].includes(value.state) ? value.state : null,
        loadStage: STAGES.has(value.loadStage) ? value.loadStage : null,
        assetBytesLoaded: finite(value.assetBytesLoaded),
        assetBytesExpected: finite(value.assetBytesExpected),
        loadMs: finite(value.loadMs)
      };
    },
    snapshot() {
      if (frozen) return structuredClone(frozen);
      const observedAtMs = elapsed();
      return {
        schemaVersion: 1, observedAtMs, droppedRequests, runtimeSamples, runtime,
        requests: requests.map(({ timestamp, ...record }) => ({
          ...record, observedForMs: observedAtMs - record.observedStartMs,
          samples: record.samples.map((point) => ({ ...point }))
        }))
      };
    },
    freeze() {
      frozen ??= this.snapshot();
      closed = true;
      return this.snapshot();
    }
  };
}

const EVENTS = ["requestWillBeSent", "responseReceived", "dataReceived", "requestServedFromCache", "loadingFinished", "loadingFailed"];

export async function captureSceneNetwork(page) {
  const recorder = createSceneNetworkRecorder();
  let session;
  let timer;
  let sampling = false;
  let stopped = false;
  let availability = "ready";
  let stopReason = null;
  let detached = false;
  const listeners = [];
  const freeze = () => {
    stopReason ??= "page_closed";
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    recorder.freeze();
  };
  try {
    session = await page.context().newCDPSession(page);
    for (const event of EVENTS) {
      const name = `Network.${event}`;
      const listener = (payload) => recorder.event(name, payload);
      session.on(name, listener);
      listeners.push([name, listener]);
    }
    await session.send("Network.enable");
    page.on("close", freeze);
    // No request interception, cache override, extra asset fetch or response-body retention.
    timer = setInterval(async () => {
      if (sampling || stopped) return;
      sampling = true;
      try {
        const value = await page.evaluate(() => {
          const debug = window.__VRATA_DEBUG__;
          const scene = debug?.sceneDebug;
          return {
            state: debug?.sceneBundleState,
            loadStage: scene?.loadStage,
            assetBytesLoaded: scene?.assetBytesLoaded,
            assetBytesExpected: scene?.assetBytesExpected,
            loadMs: scene?.loadMs
          };
        });
        recorder.runtimeSample(value);
      } catch { /* Navigation/closed pages must not replace the original test result. */ }
      finally { sampling = false; }
    }, 1000);
    timer.unref();
  } catch {
    availability = "cdp_unavailable";
  }
  return {
    snapshot: () => ({ availability, stopReason, ...recorder.snapshot() }),
    stop() {
      stopReason ??= "test_end";
      freeze();
      if (detached) return;
      detached = true;
      page.off("close", freeze);
      for (const [name, listener] of listeners) session?.off(name, listener);
      // Never wait for a hung renderer during teardown; detach errors are diagnostic only.
      void session?.detach().catch(() => undefined);
    }
  };
}
