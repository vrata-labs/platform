import type { RoomRecord, RoomPersonalState } from "./storage.js";

export function isPersonalRoom(room: RoomRecord | null | undefined): boolean {
  return room?.roomType === "personal";
}

export function isPersonalRoomOwner(room: RoomRecord, participantId: string | null | undefined): boolean {
  return isPersonalRoom(room) && Boolean(participantId) && room.ownerParticipantId === participantId;
}

export function normalizeDisplayName(input: unknown, participantId: string): string {
  if (typeof input !== "string") {
    return `Guest-${participantId.slice(0, 4)}`;
  }
  const value = input.trim().replace(/\s+/g, " ").slice(0, 40);
  return value || `Guest-${participantId.slice(0, 4)}`;
}

export function personalRoomName(displayName: string): string {
  const ownerName = displayName.replace(/[<>]/g, "").trim().slice(0, 48);
  return ownerName ? `${ownerName} Personal Room` : "Personal Room";
}

function numberFromRecord(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizePersonalState(input: unknown, updatedBy: string | null): RoomPersonalState | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const payload = input as Record<string, unknown>;
  const posePayload = payload.lastPose;
  if (!posePayload || typeof posePayload !== "object") {
    return {};
  }
  const pose = posePayload as Record<string, unknown>;
  const positionPayload = pose.position;
  if (!positionPayload || typeof positionPayload !== "object") {
    return null;
  }
  const position = positionPayload as Record<string, unknown>;
  const x = numberFromRecord(position, "x");
  const y = numberFromRecord(position, "y");
  const z = numberFromRecord(position, "z");
  const yaw = numberFromRecord(pose, "yaw");
  const pitch = numberFromRecord(pose, "pitch");
  if (x === null || y === null || z === null || yaw === null || pitch === null) {
    return null;
  }
  return {
    lastPose: {
      position: {
        x: Math.max(-1000, Math.min(1000, x)),
        y: Math.max(-100, Math.min(100, y)),
        z: Math.max(-1000, Math.min(1000, z))
      },
      yaw: Math.max(-Math.PI * 4, Math.min(Math.PI * 4, yaw)),
      pitch: Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch)),
      updatedAt: new Date().toISOString(),
      updatedBy
    }
  };
}
