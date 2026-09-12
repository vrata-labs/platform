export interface XrTelemetryRecord {
  participantId: string;
  roomId: string;
  updatedAt: string;
  kind?: string | null;
  kinds?: string[];
  statusLine?: string | null;
  currentSeatId?: string | null;
  xrAxes?: {
    moveX?: number;
    moveY?: number;
    turnX?: number;
    turnY?: number;
  };
  interactionRay?: {
    active?: boolean;
    mode?: string | null;
    targetKind?: string | null;
    seatId?: string | null;
    origin?: { x?: number; y?: number; z?: number } | null;
    direction?: { x?: number; y?: number; z?: number } | null;
    source?: { index?: number; handedness?: string | null } | null;
  };
  xrAvatarDebug?: {
    profile?: string | null;
    rightGrip?: { x?: number; y?: number; z?: number } | null;
    rightController?: { x?: number; y?: number; z?: number } | null;
    rightResolved?: { x?: number; y?: number; z?: number } | null;
    rightHandWorld?: { x?: number; y?: number; z?: number } | null;
    rightControllerWorld?: { x?: number; y?: number; z?: number } | null;
  };
  xrRawInputs?: Array<{
    index: number;
    handedness?: string | null;
    targetRayMode?: string | null;
    profiles?: string[];
    button0Pressed?: boolean;
    button1Pressed?: boolean;
    axes?: number[];
  }>;
  xrTurnCandidates?: {
    rightPrimaryX?: number;
    rightPrimaryY?: number;
    rightSecondaryX?: number;
    rightSecondaryY?: number;
    mappedTurnX?: number;
    mappedTurnY?: number;
    snapTurnFired?: boolean;
    playerYaw?: number;
    selectEventCount?: number;
  };
}

export interface XrTelemetryParticipantBuffer {
  latest: XrTelemetryRecord;
  history: XrTelemetryRecord[];
}

const xrTelemetryHistoryLimit = 80;

function shouldStoreXrTelemetryHistory(record: XrTelemetryRecord, previous?: XrTelemetryRecord | null): boolean {
  const xrAxes = record.xrAxes;
  const rawInputs = record.xrRawInputs ?? [];
  return Boolean(
    record.kind
    || record.currentSeatId !== (previous?.currentSeatId ?? null)
    || record.interactionRay?.active
    || (xrAxes && (Math.abs(xrAxes.moveX ?? 0) > 0.01 || Math.abs(xrAxes.moveY ?? 0) > 0.01 || Math.abs(xrAxes.turnX ?? 0) > 0.01 || Math.abs(xrAxes.turnY ?? 0) > 0.01))
    || rawInputs.some((input) => input.button0Pressed || input.button1Pressed || (input.axes ?? []).some((value) => Math.abs(value) > 0.01))
    || record.xrAvatarDebug?.profile === "dual"
    || record.xrAvatarDebug?.profile === "right-only"
    || record.xrAvatarDebug?.profile === "left-only"
  );
}

export function createXrTelemetryRecord(roomId: string, participantId: string, payload: XrTelemetryRecord): XrTelemetryRecord {
  return {
    ...payload,
    roomId,
    participantId,
    updatedAt: payload.updatedAt || new Date().toISOString()
  };
}

export function appendXrTelemetryRecord(roomTelemetry: Map<string, XrTelemetryParticipantBuffer>, nextRecord: XrTelemetryRecord): boolean {
  const existing = roomTelemetry.get(nextRecord.participantId);
  const shouldStoreHistory = shouldStoreXrTelemetryHistory(nextRecord, existing?.latest ?? null);
  const history = shouldStoreHistory
    ? [...(existing?.history ?? []), nextRecord].slice(-xrTelemetryHistoryLimit)
    : (existing?.history ?? []);
  roomTelemetry.set(nextRecord.participantId, {
    latest: nextRecord,
    history
  });
  return shouldStoreHistory;
}

export function cloneXrTelemetryBuffer(buffer: XrTelemetryParticipantBuffer): XrTelemetryParticipantBuffer {
  return {
    latest: structuredClone(buffer.latest),
    history: structuredClone(buffer.history)
  };
}

function compareXrTelemetryUpdatedAt(left: XrTelemetryRecord, right: XrTelemetryRecord): number {
  return left.updatedAt.localeCompare(right.updatedAt);
}

function mergeXrTelemetryHistories(...histories: XrTelemetryRecord[][]): XrTelemetryRecord[] {
  const merged = [...histories.flat()].sort(compareXrTelemetryUpdatedAt);
  const deduped = new Map<string, XrTelemetryRecord>();
  for (const record of merged) {
    const key = JSON.stringify(record);
    if (!deduped.has(key)) {
      deduped.set(key, structuredClone(record));
    }
  }
  return Array.from(deduped.values()).slice(-xrTelemetryHistoryLimit);
}

export function mergeXrTelemetryBuffers(left: XrTelemetryParticipantBuffer, right: XrTelemetryParticipantBuffer): XrTelemetryParticipantBuffer {
  return {
    latest: compareXrTelemetryUpdatedAt(left.latest, right.latest) >= 0 ? structuredClone(left.latest) : structuredClone(right.latest),
    history: mergeXrTelemetryHistories(left.history, right.history)
  };
}
