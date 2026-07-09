export type WebRtcTransportRole = "publisher" | "subscriber";

export interface WebRtcStatsTransport {
  role: WebRtcTransportRole;
  getStats: () => Promise<RTCStatsReport>;
  getConnectionState?: () => RTCPeerConnectionState | null | undefined;
  getIceConnectionState?: () => RTCIceConnectionState | null | undefined;
  getSignalingState?: () => RTCSignalingState | null | undefined;
}

export interface WebRtcCandidateDiagnostics {
  candidateType: string | null;
  protocol: string | null;
  relayProtocol: string | null;
  networkType: string | null;
  urlProtocol: string | null;
}

export interface WebRtcCandidatePairDiagnostics {
  state: string | null;
  nominated: boolean | null;
  currentRoundTripTime: number | null;
  availableOutgoingBitrate: number | null;
  bytesSent: number | null;
  bytesReceived: number | null;
  localCandidate: WebRtcCandidateDiagnostics | null;
  remoteCandidate: WebRtcCandidateDiagnostics | null;
}

export interface WebRtcTransportDiagnostics {
  role: WebRtcTransportRole;
  connectionState: RTCPeerConnectionState | null;
  iceConnectionState: RTCIceConnectionState | null;
  signalingState: RTCSignalingState | null;
  selectedCandidatePair: WebRtcCandidatePairDiagnostics | null;
  candidatePairCount: number;
  localCandidateTypes: string[];
  remoteCandidateTypes: string[];
  relayCandidateAvailable: boolean;
  relaySelected: boolean;
  turnUrlAvailable: boolean;
  errorCode: string | null;
}

export interface WebRtcDiagnosticsSnapshot {
  available: boolean;
  capturedAtMs: number;
  relayCandidateAvailable: boolean;
  relaySelected: boolean;
  turnUrlAvailable: boolean;
  transports: WebRtcTransportDiagnostics[];
  unavailableReason: string | null;
}

type StatsRecord = RTCStats & Record<string, unknown>;

function safeCall<T>(callback: (() => T | null | undefined) | undefined): T | null {
  if (!callback) {
    return null;
  }
  try {
    return callback() ?? null;
  } catch {
    return null;
  }
}

function getString(record: StatsRecord | null | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getNumber(record: StatsRecord | null | undefined, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getBoolean(record: StatsRecord | null | undefined, key: string): boolean | null {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

function sanitizeErrorCode(error: unknown): string {
  if (error instanceof Error && error.name) {
    return `get_stats_failed:${error.name}`;
  }
  return "get_stats_failed:unknown";
}

function normalizeUrlProtocol(url: string | null): string | null {
  if (!url) {
    return null;
  }
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  return match ? match[1]!.toLowerCase() : null;
}

function statsEntries(report: RTCStatsReport): Array<[string, StatsRecord]> {
  const entries: Array<[string, StatsRecord]> = [];
  report.forEach((value, key) => {
    entries.push([key, value as StatsRecord]);
  });
  return entries;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function createCandidateSnapshot(record: StatsRecord | null | undefined): WebRtcCandidateDiagnostics | null {
  if (!record) {
    return null;
  }
  return {
    candidateType: getString(record, "candidateType"),
    protocol: getString(record, "protocol"),
    relayProtocol: getString(record, "relayProtocol"),
    networkType: getString(record, "networkType"),
    urlProtocol: normalizeUrlProtocol(getString(record, "url"))
  };
}

function candidateUsesRelay(candidate: WebRtcCandidateDiagnostics | null): boolean {
  return candidate?.candidateType === "relay"
    || Boolean(candidate?.relayProtocol)
    || candidate?.urlProtocol === "turn"
    || candidate?.urlProtocol === "turns";
}

function candidateHasTurnUrl(candidate: WebRtcCandidateDiagnostics | null): boolean {
  return candidate?.urlProtocol === "turn" || candidate?.urlProtocol === "turns";
}

function createCandidatePairSnapshot(pair: StatsRecord, statsById: Map<string, StatsRecord>): WebRtcCandidatePairDiagnostics {
  const localCandidateId = getString(pair, "localCandidateId");
  const remoteCandidateId = getString(pair, "remoteCandidateId");
  return {
    state: getString(pair, "state"),
    nominated: getBoolean(pair, "nominated"),
    currentRoundTripTime: getNumber(pair, "currentRoundTripTime"),
    availableOutgoingBitrate: getNumber(pair, "availableOutgoingBitrate"),
    bytesSent: getNumber(pair, "bytesSent"),
    bytesReceived: getNumber(pair, "bytesReceived"),
    localCandidate: createCandidateSnapshot(localCandidateId ? statsById.get(localCandidateId) : null),
    remoteCandidate: createCandidateSnapshot(remoteCandidateId ? statsById.get(remoteCandidateId) : null)
  };
}

function findSelectedCandidatePair(entries: Array<[string, StatsRecord]>): [string, StatsRecord] | null {
  const transportSelectedPairId = entries
    .filter(([, record]) => record.type === "transport")
    .map(([, record]) => getString(record, "selectedCandidatePairId"))
    .find((id): id is string => Boolean(id));
  const candidatePairs = entries.filter(([, record]) => record.type === "candidate-pair");
  return candidatePairs.find(([id]) => id === transportSelectedPairId)
    ?? candidatePairs.find(([, record]) => getBoolean(record, "selected") === true)
    ?? candidatePairs.find(([, record]) => getBoolean(record, "nominated") === true && getString(record, "state") === "succeeded")
    ?? candidatePairs.find(([, record]) => getString(record, "state") === "succeeded")
    ?? null;
}

function summarizeTransportStats(transport: WebRtcStatsTransport, report: RTCStatsReport): WebRtcTransportDiagnostics {
  const entries = statsEntries(report);
  const statsById = new Map(entries);
  const candidatePairs = entries.filter(([, record]) => record.type === "candidate-pair");
  const localCandidates = entries.filter(([, record]) => record.type === "local-candidate");
  const remoteCandidates = entries.filter(([, record]) => record.type === "remote-candidate");
  const selectedPair = findSelectedCandidatePair(entries);
  const selectedCandidatePair = selectedPair
    ? createCandidatePairSnapshot(selectedPair[1], statsById)
    : null;
  const candidateSnapshots = [...localCandidates, ...remoteCandidates]
    .map(([, record]) => createCandidateSnapshot(record))
    .filter((candidate): candidate is WebRtcCandidateDiagnostics => Boolean(candidate));

  return {
    role: transport.role,
    connectionState: safeCall(transport.getConnectionState),
    iceConnectionState: safeCall(transport.getIceConnectionState),
    signalingState: safeCall(transport.getSignalingState),
    selectedCandidatePair,
    candidatePairCount: candidatePairs.length,
    localCandidateTypes: uniqueSorted(localCandidates.map(([, record]) => getString(record, "candidateType")).filter((value): value is string => Boolean(value))),
    remoteCandidateTypes: uniqueSorted(remoteCandidates.map(([, record]) => getString(record, "candidateType")).filter((value): value is string => Boolean(value))),
    relayCandidateAvailable: candidateSnapshots.some(candidateUsesRelay),
    relaySelected: candidateUsesRelay(selectedCandidatePair?.localCandidate ?? null) || candidateUsesRelay(selectedCandidatePair?.remoteCandidate ?? null),
    turnUrlAvailable: candidateSnapshots.some(candidateHasTurnUrl),
    errorCode: null
  };
}

function createErroredTransportSnapshot(transport: WebRtcStatsTransport, error: unknown): WebRtcTransportDiagnostics {
  return {
    role: transport.role,
    connectionState: safeCall(transport.getConnectionState),
    iceConnectionState: safeCall(transport.getIceConnectionState),
    signalingState: safeCall(transport.getSignalingState),
    selectedCandidatePair: null,
    candidatePairCount: 0,
    localCandidateTypes: [],
    remoteCandidateTypes: [],
    relayCandidateAvailable: false,
    relaySelected: false,
    turnUrlAvailable: false,
    errorCode: sanitizeErrorCode(error)
  };
}

export function createUnavailableWebRtcDiagnostics(reason = "no_livekit_transport", now = Date.now): WebRtcDiagnosticsSnapshot {
  return {
    available: false,
    capturedAtMs: now(),
    relayCandidateAvailable: false,
    relaySelected: false,
    turnUrlAvailable: false,
    transports: [],
    unavailableReason: reason
  };
}

export async function collectWebRtcDiagnostics(
  transports: WebRtcStatsTransport[],
  options: { now?: () => number } = {}
): Promise<WebRtcDiagnosticsSnapshot> {
  const now = options.now ?? Date.now;
  if (transports.length === 0) {
    return createUnavailableWebRtcDiagnostics("no_livekit_transport", now);
  }

  const snapshots = await Promise.all(transports.map(async (transport) => {
    try {
      return summarizeTransportStats(transport, await transport.getStats());
    } catch (error) {
      return createErroredTransportSnapshot(transport, error);
    }
  }));

  return {
    available: snapshots.some((snapshot) => snapshot.errorCode === null),
    capturedAtMs: now(),
    relayCandidateAvailable: snapshots.some((snapshot) => snapshot.relayCandidateAvailable),
    relaySelected: snapshots.some((snapshot) => snapshot.relaySelected),
    turnUrlAvailable: snapshots.some((snapshot) => snapshot.turnUrlAvailable),
    transports: snapshots,
    unavailableReason: snapshots.some((snapshot) => snapshot.errorCode === null) ? null : "get_stats_failed"
  };
}
