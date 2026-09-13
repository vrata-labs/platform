import type { RoomPermission, RoomRole } from "@vrata/shared-types";

export interface PresenceRecord {
  participantId: string;
  displayName: string;
  role?: RoomRole;
  permissions?: RoomPermission[];
  mode: "desktop" | "mobile" | "vr";
  rootTransform: { x: number; y: number; z: number; yaw?: number; pitch?: number; roll?: number };
  headTransform?: { x: number; y: number; z: number; yaw?: number; pitch?: number; roll?: number };
  bodyTransform?: { x: number; y: number; z: number; yaw?: number; pitch?: number; roll?: number };
  audioJoined?: boolean;
  muted: boolean;
  speaking?: boolean;
  activeMedia: { audio: boolean; screenShare: boolean };
  seq?: number;
  clientTimeMs?: number;
  serverTimeMs?: number;
  updatedAt: string;
}

export function createRoomPresence(presenceByRoom: Map<string, Map<string, PresenceRecord>>, presenceTtlMs: number) {
  function cleanupPresence(roomId: string): void {
    const roomPresence = presenceByRoom.get(roomId);
    if (!roomPresence) return;
    const now = Date.now();
    for (const [participantId, state] of roomPresence.entries()) {
      if (now - Date.parse(state.updatedAt) > presenceTtlMs) roomPresence.delete(participantId);
    }
    if (roomPresence.size === 0) presenceByRoom.delete(roomId);
  }

  function getPresence(roomId: string): PresenceRecord[] {
    cleanupPresence(roomId);
    return Array.from(presenceByRoom.get(roomId)?.values() ?? []);
  }

  function upsertPresence(roomId: string, participantId: string, payload: PresenceRecord): void {
    cleanupPresence(roomId);
    const roomPresence = presenceByRoom.get(roomId) ?? new Map<string, PresenceRecord>();
    roomPresence.set(participantId, payload);
    presenceByRoom.set(roomId, roomPresence);
  }

  function deletePresence(roomId: string, participantId: string): void {
    presenceByRoom.get(roomId)?.delete(participantId);
  }

  function cleanupAllPresence(): void {
    for (const roomId of Array.from(presenceByRoom.keys())) {
      cleanupPresence(roomId);
    }
  }

  function activeParticipantCount(): number {
    cleanupAllPresence();
    let total = 0;
    for (const roomPresence of presenceByRoom.values()) {
      total += roomPresence.size;
    }
    return total;
  }

  return { getPresence, upsertPresence, deletePresence, cleanupAllPresence, activeParticipantCount };
}
