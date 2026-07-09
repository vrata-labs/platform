import { Room, Track } from "livekit-client";

import { createRoomStateUrl } from "./room-state-client.js";
import { detectBrowserMediaCapabilities, type BrowserMediaCapabilities } from "./media-capabilities.js";
import { collectWebRtcDiagnostics, createUnavailableWebRtcDiagnostics, type WebRtcDiagnosticsSnapshot, type WebRtcStatsTransport, type WebRtcTransportRole } from "./webrtc-diagnostics.js";

export type PublicDiagnosticStatus = "ok" | "failed" | "skipped";

export type PublicDiagnosticCode =
  | "api_ok"
  | "api_unreachable"
  | "api_http_error"
  | "admin_details_protected"
  | "admin_details_public"
  | "manifest_ok"
  | "manifest_unreachable"
  | "state_token_ok"
  | "state_token_failed"
  | "room_state_ws_ok"
  | "room_state_ws_failed"
  | "storage_ok"
  | "storage_skipped"
  | "storage_unreachable"
  | "microphone_ok"
  | "microphone_skipped"
  | "microphone_unsupported"
  | "microphone_permission_denied"
  | "microphone_not_found"
  | "microphone_check_failed"
  | "media_ok"
  | "media_skipped"
  | "media_token_failed"
  | "livekit_connect_failed"
  | "client_capabilities_ok"
  | "connectivity_check_timeout";

export interface PublicDiagnosticCheck {
  name: string;
  label: string;
  status: PublicDiagnosticStatus;
  code: PublicDiagnosticCode;
  durationMs: number;
  message: string;
  details?: unknown;
}

export interface PublicConnectivityReport {
  schemaVersion: 1;
  generatedAt: string;
  origin: string;
  roomId: string;
  summary: {
    ok: number;
    failed: number;
    skipped: number;
  };
  client: BrowserMediaCapabilities;
  checks: PublicDiagnosticCheck[];
}

interface RuntimeManifest {
  roomId: string;
  sceneBundle?: { url?: string };
  realtime?: { roomStateUrl?: string };
  assets?: Array<{ url?: string; processedUrl?: string }>;
}

interface StateTokenResponse {
  token: string;
}

interface MediaTokenResponse {
  token: string;
  livekitUrl: string;
}

type FetchLike = typeof fetch;
type WebSocketConstructorLike = typeof WebSocket;

export interface PublicConnectivityDiagnosticsOptions {
  apiBaseUrl: string;
  roomId: string;
  participantId?: string;
  displayName?: string;
  timeoutMs?: number;
  skipMicrophone?: boolean;
  skipMedia?: boolean;
  roomStateUrlOverride?: string;
  fetchImpl?: FetchLike;
  WebSocketImpl?: WebSocketConstructorLike;
  now?: () => number;
  onCheck?: (check: PublicDiagnosticCheck) => void;
}

interface DiagnosticsContext {
  apiBaseUrl: string;
  roomId: string;
  participantId: string;
  displayName: string;
  timeoutMs: number;
  fetchImpl: FetchLike;
  WebSocketImpl?: WebSocketConstructorLike;
  now: () => number;
}

type LiveKitTransportCandidate = {
  getStats?: () => Promise<RTCStatsReport>;
  getConnectionState?: () => RTCPeerConnectionState | null | undefined;
  getICEConnectionState?: () => RTCIceConnectionState | null | undefined;
  getSignallingState?: () => RTCSignalingState | null | undefined;
  getSignalingState?: () => RTCSignalingState | null | undefined;
};

type LiveKitEngineDiagnosticsSource = {
  pcManager?: {
    publisher?: unknown;
    subscriber?: unknown;
  };
};

const secretKeyPattern = /(authorization|cookie|password|secret|token|invite)/i;

function setDiagnosticsTimeout(callback: () => void, timeoutMs: number): ReturnType<typeof globalThis.setTimeout> {
  return globalThis.setTimeout(callback, timeoutMs);
}

function clearDiagnosticsTimeout(timer: ReturnType<typeof globalThis.setTimeout>): void {
  globalThis.clearTimeout(timer);
}

async function delay(timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => setDiagnosticsTimeout(() => resolve(), timeoutMs));
}

function createDiagnosticsParticipantId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `diag-${globalThis.crypto.randomUUID()}`;
  }
  return `diag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function elapsedMs(startedAt: number, now: () => number): number {
  return Math.max(0, Math.round(now() - startedAt));
}

function createCheck(input: Omit<PublicDiagnosticCheck, "durationMs"> & { startedAt: number; now: () => number }): PublicDiagnosticCheck {
  return {
    name: input.name,
    label: input.label,
    status: input.status,
    code: input.code,
    durationMs: elapsedMs(input.startedAt, input.now),
    message: input.message,
    details: input.details === undefined ? undefined : redactConnectivityReport(input.details)
  };
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message === "connectivity_check_timeout");
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name || "Error" : "unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchJsonWithTimeout<T>(context: DiagnosticsContext, path: string, init?: RequestInit): Promise<{ response: Response; payload: T }> {
  const controller = new AbortController();
  const timeout = setDiagnosticsTimeout(() => controller.abort(), context.timeoutMs);
  try {
    const response = await context.fetchImpl(new URL(path, context.apiBaseUrl), {
      ...init,
      signal: controller.signal
    });
    const payload = (await response.json().catch(() => ({}))) as T;
    return { response, payload };
  } finally {
    clearDiagnosticsTimeout(timeout);
  }
}

async function fetchOkWithTimeout(context: DiagnosticsContext, url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setDiagnosticsTimeout(() => controller.abort(), context.timeoutMs);
  try {
    return await context.fetchImpl(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal
    });
  } finally {
    clearDiagnosticsTimeout(timeout);
  }
}

async function runTimedCheck(
  context: DiagnosticsContext,
  name: string,
  callback: (startedAt: number) => Promise<PublicDiagnosticCheck>
): Promise<PublicDiagnosticCheck> {
  const startedAt = context.now();
  try {
    return await callback(startedAt);
  } catch (error) {
    return createCheck({
      name,
      label: name,
      status: "failed",
      code: isTimeoutError(error) ? "connectivity_check_timeout" : "api_unreachable",
      startedAt,
      now: context.now,
      message: isTimeoutError(error) ? "Check timed out" : "Check failed",
      details: { errorName: errorName(error), errorMessage: errorMessage(error) }
    });
  }
}

async function checkApi(context: DiagnosticsContext): Promise<PublicDiagnosticCheck> {
  return runTimedCheck(context, "api", async (startedAt) => {
    const { response, payload } = await fetchJsonWithTimeout<unknown>(context, "/health");
    if (!response.ok) {
      return createCheck({
        name: "api",
        label: "API",
        status: "failed",
        code: "api_http_error",
        startedAt,
        now: context.now,
        message: `API returned HTTP ${response.status}`,
        details: { status: response.status, payload }
      });
    }
    return createCheck({
      name: "api",
      label: "API",
      status: "ok",
      code: "api_ok",
      startedAt,
      now: context.now,
      message: "API reachable",
      details: payload
    });
  });
}

async function checkAdminDetailsProtected(context: DiagnosticsContext): Promise<PublicDiagnosticCheck> {
  return runTimedCheck(context, "adminDetails", async (startedAt) => {
    const response = await fetchOkWithTimeout(context, new URL(`/api/rooms/${encodeURIComponent(context.roomId)}/diagnostics`, context.apiBaseUrl).toString());
    if (response.status === 401 || response.status === 403) {
      return createCheck({
        name: "adminDetails",
        label: "Admin details",
        status: "ok",
        code: "admin_details_protected",
        startedAt,
        now: context.now,
        message: "Stored diagnostics require authorization",
        details: { status: response.status }
      });
    }
    return createCheck({
      name: "adminDetails",
      label: "Admin details",
      status: "failed",
      code: "admin_details_public",
      startedAt,
      now: context.now,
      message: "Stored diagnostics were readable without authorization",
      details: { status: response.status }
    });
  });
}

async function checkManifest(context: DiagnosticsContext): Promise<{ check: PublicDiagnosticCheck; manifest: RuntimeManifest | null }> {
  const startedAt = context.now();
  try {
    const { response, payload } = await fetchJsonWithTimeout<RuntimeManifest>(context, `/api/rooms/${encodeURIComponent(context.roomId)}/manifest`);
    if (!response.ok) {
      return {
        check: createCheck({
          name: "manifest",
          label: "Room manifest",
          status: "failed",
          code: "manifest_unreachable",
          startedAt,
          now: context.now,
          message: `Manifest returned HTTP ${response.status}`,
          details: { status: response.status, payload }
        }),
        manifest: null
      };
    }
    return {
      check: createCheck({
        name: "manifest",
        label: "Room manifest",
        status: "ok",
        code: "manifest_ok",
        startedAt,
        now: context.now,
        message: "Room manifest reachable",
        details: {
          roomId: payload.roomId,
          roomStateUrl: payload.realtime?.roomStateUrl,
          sceneBundleUrl: payload.sceneBundle?.url ?? null,
          assetCount: payload.assets?.length ?? 0
        }
      }),
      manifest: payload
    };
  } catch (error) {
    return {
      check: createCheck({
        name: "manifest",
        label: "Room manifest",
        status: "failed",
        code: isTimeoutError(error) ? "connectivity_check_timeout" : "manifest_unreachable",
        startedAt,
        now: context.now,
        message: isTimeoutError(error) ? "Manifest check timed out" : "Manifest unreachable",
        details: { errorName: errorName(error), errorMessage: errorMessage(error) }
      }),
      manifest: null
    };
  }
}

async function fetchStateTokenCheck(context: DiagnosticsContext): Promise<{ check: PublicDiagnosticCheck; token: string | null }> {
  const startedAt = context.now();
  try {
    const { response, payload } = await fetchJsonWithTimeout<StateTokenResponse>(context, "/api/tokens/state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        roomId: context.roomId,
        participantId: context.participantId,
        displayName: context.displayName
      })
    });
    if (!response.ok || typeof payload.token !== "string") {
      return {
        check: createCheck({
          name: "stateToken",
          label: "State token",
          status: "failed",
          code: "state_token_failed",
          startedAt,
          now: context.now,
          message: `State token failed with HTTP ${response.status}`,
          details: { status: response.status, payload }
        }),
        token: null
      };
    }
    return {
      check: createCheck({
        name: "stateToken",
        label: "State token",
        status: "ok",
        code: "state_token_ok",
        startedAt,
        now: context.now,
        message: "State token issued",
        details: { expires: "present" }
      }),
      token: payload.token
    };
  } catch (error) {
    return {
      check: createCheck({
        name: "stateToken",
        label: "State token",
        status: "failed",
        code: isTimeoutError(error) ? "connectivity_check_timeout" : "state_token_failed",
        startedAt,
        now: context.now,
        message: isTimeoutError(error) ? "State token check timed out" : "State token failed",
        details: { errorName: errorName(error), errorMessage: errorMessage(error) }
      }),
      token: null
    };
  }
}

async function checkRoomStateWebSocket(context: DiagnosticsContext, manifest: RuntimeManifest | null, stateToken: string | null, roomStateUrlOverride?: string): Promise<PublicDiagnosticCheck> {
  const startedAt = context.now();
  const roomStateUrl = roomStateUrlOverride ?? manifest?.realtime?.roomStateUrl;
  const WebSocketImpl = context.WebSocketImpl;
  if (!roomStateUrl || !stateToken || !WebSocketImpl) {
    return createCheck({
      name: "roomStateWebSocket",
      label: "Room-state WSS",
      status: "failed",
      code: "room_state_ws_failed",
      startedAt,
      now: context.now,
      message: "Room-state URL, token, or WebSocket API missing",
      details: { hasRoomStateUrl: Boolean(roomStateUrl), hasStateToken: Boolean(stateToken), hasWebSocket: Boolean(context.WebSocketImpl) }
    });
  }

  return await new Promise<PublicDiagnosticCheck>((resolve) => {
    const url = createRoomStateUrl(roomStateUrl, context.roomId, context.participantId, stateToken);
    let settled = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
    let socket: WebSocket | undefined;
    const finish = (check: PublicDiagnosticCheck): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearDiagnosticsTimeout(timer);
      }
      socket?.close();
      resolve(check);
    };
    timer = setDiagnosticsTimeout(() => {
      finish(createCheck({
        name: "roomStateWebSocket",
        label: "Room-state WSS",
        status: "failed",
        code: "room_state_ws_failed",
        startedAt,
        now: context.now,
        message: "Room-state WebSocket timed out",
        details: { reason: "timeout", url }
      }));
    }, context.timeoutMs);
    try {
      socket = new WebSocketImpl(url);
    } catch (error) {
      if (timer !== null) {
        clearDiagnosticsTimeout(timer);
      }
      resolve(createCheck({
        name: "roomStateWebSocket",
        label: "Room-state WSS",
        status: "failed",
        code: "room_state_ws_failed",
        startedAt,
        now: context.now,
        message: "Room-state WebSocket could not be created",
        details: { errorName: errorName(error), errorMessage: errorMessage(error), url }
      }));
      return;
    }
    socket.addEventListener("open", () => {
      finish(createCheck({
        name: "roomStateWebSocket",
        label: "Room-state WSS",
        status: "ok",
        code: "room_state_ws_ok",
        startedAt,
        now: context.now,
        message: "Room-state WebSocket connected",
        details: { url }
      }));
    }, { once: true });
    socket.addEventListener("error", () => {
      finish(createCheck({
        name: "roomStateWebSocket",
        label: "Room-state WSS",
        status: "failed",
        code: "room_state_ws_failed",
        startedAt,
        now: context.now,
        message: "Room-state WebSocket failed",
        details: { reason: "error", url }
      }));
    }, { once: true });
    socket.addEventListener("close", () => {
      finish(createCheck({
        name: "roomStateWebSocket",
        label: "Room-state WSS",
        status: "failed",
        code: "room_state_ws_failed",
        startedAt,
        now: context.now,
        message: "Room-state WebSocket closed before opening",
        details: { reason: "close", url }
      }));
    }, { once: true });
  });
}

async function checkStorage(context: DiagnosticsContext, manifest: RuntimeManifest | null): Promise<PublicDiagnosticCheck> {
  const startedAt = context.now();
  const targetUrl = manifest?.sceneBundle?.url ?? manifest?.assets?.map((asset) => asset.processedUrl ?? asset.url).find((url): url is string => Boolean(url));
  if (!targetUrl) {
    return createCheck({
      name: "storage",
      label: "Object storage",
      status: "skipped",
      code: "storage_skipped",
      startedAt,
      now: context.now,
      message: "No scene bundle or asset URL in manifest"
    });
  }
  try {
    const response = await fetchOkWithTimeout(context, targetUrl);
    return createCheck({
      name: "storage",
      label: "Object storage",
      status: response.ok ? "ok" : "failed",
      code: response.ok ? "storage_ok" : "storage_unreachable",
      startedAt,
      now: context.now,
      message: response.ok ? "Storage URL reachable" : `Storage URL returned HTTP ${response.status}`,
      details: { status: response.status, url: targetUrl }
    });
  } catch (error) {
    return createCheck({
      name: "storage",
      label: "Object storage",
      status: "failed",
      code: isTimeoutError(error) ? "connectivity_check_timeout" : "storage_unreachable",
      startedAt,
      now: context.now,
      message: isTimeoutError(error) ? "Storage check timed out" : "Storage URL unreachable",
      details: { errorName: errorName(error), errorMessage: errorMessage(error), url: targetUrl }
    });
  }
}

async function checkMicrophone(context: DiagnosticsContext, capabilities: BrowserMediaCapabilities, skipMicrophone: boolean): Promise<PublicDiagnosticCheck> {
  const startedAt = context.now();
  if (skipMicrophone) {
    return createCheck({
      name: "microphone",
      label: "Microphone",
      status: "skipped",
      code: "microphone_skipped",
      startedAt,
      now: context.now,
      message: "Microphone check skipped"
    });
  }
  if (!capabilities.audioInput.supported || !navigator.mediaDevices?.getUserMedia) {
    return createCheck({
      name: "microphone",
      label: "Microphone",
      status: "failed",
      code: "microphone_unsupported",
      startedAt,
      now: context.now,
      message: "Microphone capture is unsupported",
      details: { reason: capabilities.audioInput.reason }
    });
  }
  try {
    const stream = await withTimeout(navigator.mediaDevices.getUserMedia({ audio: true }), context.timeoutMs);
    stream.getTracks().forEach((track) => track.stop());
    return createCheck({
      name: "microphone",
      label: "Microphone",
      status: "ok",
      code: "microphone_ok",
      startedAt,
      now: context.now,
      message: "Microphone permission and device available"
    });
  } catch (error) {
    const name = errorName(error);
    const code: PublicDiagnosticCode = name === "NotAllowedError" || name === "SecurityError"
      ? "microphone_permission_denied"
      : name === "NotFoundError" || name === "DevicesNotFoundError"
        ? "microphone_not_found"
        : isTimeoutError(error)
          ? "connectivity_check_timeout"
          : "microphone_check_failed";
    return createCheck({
      name: "microphone",
      label: "Microphone",
      status: "failed",
      code,
      startedAt,
      now: context.now,
      message: code === "microphone_permission_denied" ? "Microphone permission denied" : "Microphone check failed",
      details: { errorName: name, errorMessage: errorMessage(error) }
    });
  }
}

function createWebRtcStatsTransport(role: WebRtcTransportRole, source: unknown): WebRtcStatsTransport | null {
  const candidate = source as LiveKitTransportCandidate | null | undefined;
  if (!candidate || typeof candidate.getStats !== "function") {
    return null;
  }
  return {
    role,
    getStats: () => candidate.getStats!(),
    getConnectionState: () => candidate.getConnectionState?.() ?? null,
    getIceConnectionState: () => candidate.getICEConnectionState?.() ?? null,
    getSignalingState: () => candidate.getSignalingState?.() ?? candidate.getSignallingState?.() ?? null
  };
}

function getLiveKitDiagnosticsTransports(room: Room): WebRtcStatsTransport[] {
  const engine = (room as { engine?: LiveKitEngineDiagnosticsSource }).engine;
  return [
    createWebRtcStatsTransport("publisher", engine?.pcManager?.publisher),
    createWebRtcStatsTransport("subscriber", engine?.pcManager?.subscriber)
  ].filter((transport): transport is WebRtcStatsTransport => Boolean(transport));
}

function createDiagnosticsAudioTrack(): { track: MediaStreamTrack; stop: () => void } {
  const AudioContextConstructor = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new Error("diagnostics_audio_context_missing");
  }
  const context = new AudioContextConstructor();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const destination = context.createMediaStreamDestination();
  oscillator.type = "sine";
  oscillator.frequency.value = 440;
  gain.gain.value = 0.03;
  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start();
  const track = destination.stream.getAudioTracks()[0];
  if (!track) {
    throw new Error("diagnostics_audio_track_missing");
  }
  return {
    track,
    stop: () => {
      oscillator.stop();
      oscillator.disconnect();
      gain.disconnect();
      track.stop();
      void context.close().catch(() => undefined);
    }
  };
}

async function waitForWebRtcDiagnostics(room: Room, timeoutMs: number): Promise<WebRtcDiagnosticsSnapshot> {
  const startedAt = Date.now();
  let lastSnapshot = createUnavailableWebRtcDiagnostics("no_livekit_transport");
  while (Date.now() - startedAt < timeoutMs) {
    const transports = getLiveKitDiagnosticsTransports(room);
    if (transports.length > 0) {
      lastSnapshot = await collectWebRtcDiagnostics(transports);
      const hasCandidatePair = lastSnapshot.transports.some((transport) => Boolean(transport.selectedCandidatePair));
      if (hasCandidatePair || lastSnapshot.relaySelected) {
        return lastSnapshot;
      }
    }
    await delay(500);
  }
  return lastSnapshot;
}

async function checkMedia(context: DiagnosticsContext, stateToken: string | null, skipMedia: boolean): Promise<PublicDiagnosticCheck> {
  const startedAt = context.now();
  if (skipMedia) {
    return createCheck({
      name: "media",
      label: "LiveKit media",
      status: "skipped",
      code: "media_skipped",
      startedAt,
      now: context.now,
      message: "Media check skipped"
    });
  }
  if (!stateToken) {
    return createCheck({
      name: "media",
      label: "LiveKit media",
      status: "failed",
      code: "media_token_failed",
      startedAt,
      now: context.now,
      message: "Media token skipped because state token failed"
    });
  }
  let room: Room | null = null;
  let audioTrack: { track: MediaStreamTrack; stop: () => void } | null = null;
  try {
    const { response, payload } = await fetchJsonWithTimeout<MediaTokenResponse>(context, "/api/tokens/media", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${stateToken}`
      },
      body: JSON.stringify({
        roomId: context.roomId,
        participantId: context.participantId,
        canPublishAudio: true,
        canPublishVideo: false
      })
    });
    if (!response.ok || typeof payload.token !== "string" || typeof payload.livekitUrl !== "string") {
      return createCheck({
        name: "media",
        label: "LiveKit media",
        status: "failed",
        code: "media_token_failed",
        startedAt,
        now: context.now,
        message: `Media token failed with HTTP ${response.status}`,
        details: { status: response.status, payload }
      });
    }

    room = new Room();
    await withTimeout(room.connect(payload.livekitUrl, payload.token), context.timeoutMs);
    audioTrack = createDiagnosticsAudioTrack();
    await withTimeout(Promise.resolve(room.localParticipant.publishTrack(audioTrack.track, {
      name: "vrata-connectivity-diagnostics",
      source: Track.Source.Microphone
    })), context.timeoutMs);
    const webrtc = await waitForWebRtcDiagnostics(room, context.timeoutMs);
    return createCheck({
      name: "media",
      label: "LiveKit media",
      status: "ok",
      code: "media_ok",
      startedAt,
      now: context.now,
      message: "LiveKit media connected",
      details: {
        livekitUrl: payload.livekitUrl,
        webrtc
      }
    });
  } catch (error) {
    return createCheck({
      name: "media",
      label: "LiveKit media",
      status: "failed",
      code: isTimeoutError(error) ? "connectivity_check_timeout" : "livekit_connect_failed",
      startedAt,
      now: context.now,
      message: isTimeoutError(error) ? "LiveKit check timed out" : "LiveKit media check failed",
      details: { errorName: errorName(error), errorMessage: errorMessage(error) }
    });
  } finally {
    audioTrack?.stop();
    room?.disconnect();
  }
}

function checkClientCapabilities(startedAt: number, now: () => number, capabilities: BrowserMediaCapabilities): PublicDiagnosticCheck {
  return createCheck({
    name: "clientCapabilities",
    label: "Client capabilities",
    status: "ok",
    code: "client_capabilities_ok",
    startedAt,
    now,
    message: "Client capabilities captured",
    details: capabilities
  });
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setDiagnosticsTimeout(() => reject(new Error("connectivity_check_timeout")), timeoutMs);
    promise.then((value) => {
      clearDiagnosticsTimeout(timer);
      resolve(value);
    }).catch((error) => {
      clearDiagnosticsTimeout(timer);
      reject(error);
    });
  });
}

export function redactString(value: string): string {
  return value.replace(/([?&][^=&]*(?:authorization|password|secret|token|invite)[^=&]*=)[^&]+/gi, `$1[redacted]`);
}

export function redactConnectivityReport(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    return secretKeyPattern.test(key) ? "[redacted]" : redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactConnectivityReport(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [entryKey, redactConnectivityReport(entryValue, entryKey)]));
  }
  return value;
}

export function createReportSummary(checks: PublicDiagnosticCheck[]): PublicConnectivityReport["summary"] {
  return {
    ok: checks.filter((check) => check.status === "ok").length,
    failed: checks.filter((check) => check.status === "failed").length,
    skipped: checks.filter((check) => check.status === "skipped").length
  };
}

export async function runPublicConnectivityDiagnostics(options: PublicConnectivityDiagnosticsOptions): Promise<PublicConnectivityReport> {
  const context: DiagnosticsContext = {
    apiBaseUrl: options.apiBaseUrl,
    roomId: options.roomId || "demo-room",
    participantId: options.participantId ?? createDiagnosticsParticipantId(),
    displayName: options.displayName ?? "Connectivity Diagnostics",
    timeoutMs: options.timeoutMs ?? 8000,
    fetchImpl: options.fetchImpl ?? fetch.bind(globalThis),
    WebSocketImpl: options.WebSocketImpl ?? globalThis.WebSocket,
    now: options.now ?? (() => globalThis.performance?.now() ?? Date.now())
  };
  const checks: PublicDiagnosticCheck[] = [];
  const emit = (check: PublicDiagnosticCheck): void => {
    checks.push(check);
    options.onCheck?.(check);
  };
  const capabilities = detectBrowserMediaCapabilities({
    isSecureContext: (globalThis as typeof globalThis & { isSecureContext?: boolean }).isSecureContext ?? false,
    mediaDevices: globalThis.navigator?.mediaDevices,
    rtcPeerConnection: globalThis.RTCPeerConnection
  });
  emit(checkClientCapabilities(context.now(), context.now, capabilities));
  emit(await checkApi(context));
  emit(await checkAdminDetailsProtected(context));
  const manifestResult = await checkManifest(context);
  emit(manifestResult.check);
  const stateTokenResult = await fetchStateTokenCheck(context);
  emit(stateTokenResult.check);
  emit(await checkRoomStateWebSocket(context, manifestResult.manifest, stateTokenResult.token, options.roomStateUrlOverride));
  emit(await checkStorage(context, manifestResult.manifest));
  emit(await checkMicrophone(context, capabilities, options.skipMicrophone ?? false));
  emit(await checkMedia(context, stateTokenResult.token, options.skipMedia ?? false));

  return redactConnectivityReport({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    origin: globalThis.location?.origin ?? options.apiBaseUrl,
    roomId: context.roomId,
    summary: createReportSummary(checks),
    client: capabilities,
    checks
  }) as PublicConnectivityReport;
}
