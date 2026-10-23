import type { RoomRole } from "@vrata/shared-types";
import type { RoomRecord, RoomSessionControlState } from "./storage.js";

import { isHostControlsEnabled } from "./feature-flags.js";

export function isRoomDisabled(room: RoomRecord | null | undefined): boolean {
  return room?.status === "disabled" || Boolean(room?.disabledAt);
}

export function defaultSessionControlState(input?: RoomSessionControlState | null): Required<RoomSessionControlState> {
  return {
    hostParticipantId: input?.hostParticipantId ?? null,
    presenterParticipantId: input?.presenterParticipantId ?? null,
    presenterGrantedAt: input?.presenterGrantedAt ?? null,
    presenterGrantedBy: input?.presenterGrantedBy ?? null,
    presenterRevokedAt: input?.presenterRevokedAt ?? null,
    presenterRevokedBy: input?.presenterRevokedBy ?? null,
    lockedAt: input?.lockedAt ?? null,
    lockedBy: input?.lockedBy ?? null,
    endedAt: input?.endedAt ?? null,
    endedBy: input?.endedBy ?? null,
    removedParticipants: input?.removedParticipants ?? {}
  };
}

export function sanitizeSessionControlState(input?: RoomSessionControlState | null): Required<RoomSessionControlState> {
  const state = defaultSessionControlState(input);
  return {
    ...state,
    removedParticipants: { ...state.removedParticipants }
  };
}

export function getRemovedParticipant(room: RoomRecord, participantId: string | null | undefined): Required<RoomSessionControlState>["removedParticipants"][string] | null {
  if (!participantId) {
    return null;
  }
  return defaultSessionControlState(room.sessionControl).removedParticipants[participantId] ?? null;
}

export function resolveEffectiveRoomRole(room: RoomRecord | null, participantId: string, role: RoomRole): RoomRole {
  const control = room ? defaultSessionControlState(room.sessionControl) : null;
  if (role === "admin") {
    return "admin";
  }
  if (!control?.hostParticipantId) {
    if (participantId === control?.presenterParticipantId) {
      return "presenter";
    }
    return role === "presenter" ? "member" : role;
  }
  if (participantId === control?.hostParticipantId) {
    return "host";
  }
  if (participantId === control?.presenterParticipantId) {
    return "presenter";
  }
  return role === "host" || role === "presenter" ? "member" : role;
}

function canJoinLockedRoom(role: RoomRole): boolean {
  return role === "host" || role === "admin";
}

export function getSessionControlBlockReason(room: RoomRecord | null, participantId: string, role: RoomRole, hasExistingSession: boolean,
  hostControlsEnabled: boolean = isHostControlsEnabled()): string | null {
  if (!room) {
    return null;
  }
  if (isRoomDisabled(room)) {
    return "room_disabled";
  }
  const managedReason = getManagedAccessBlockReason(room);
  if (managedReason) {
    return managedReason;
  }
  if (!hostControlsEnabled) {
    return null;
  }
  const control = defaultSessionControlState(room.sessionControl);
  if (control.endedAt) {
    return "session_ended";
  }
  if (getRemovedParticipant(room, participantId)) {
    return "participant_removed";
  }
  if (control.lockedAt && !hasExistingSession && !canJoinLockedRoom(role)) {
    return "room_locked";
  }
  return null;
}

// effectiveCutoff = accessUntil + graceSeconds of a portal-managed room; null for other rooms.
export function managedRoomCutoffMs(room: RoomRecord | null | undefined): number | null {
  if (!room?.managed) return null;
  return Date.parse(room.managed.accessUntil) + room.managed.graceSeconds * 1000;
}

export function getManagedAccessBlockReason(room: RoomRecord | null | undefined, nowMs = Date.now()): "access_expired" | "room_paused" | null {
  const cutoffMs = managedRoomCutoffMs(room);
  if (cutoffMs === null) return null;
  if (nowMs >= cutoffMs) return "access_expired";
  return room?.managed?.status === "paused" ? "room_paused" : null;
}

// A token issued for a managed room never outlives its effective cutoff.
export function capTokenTtlSeconds(room: RoomRecord | null | undefined, ttlSeconds: number, nowSeconds: number): number {
  const cutoffMs = managedRoomCutoffMs(room);
  if (cutoffMs === null) return ttlSeconds;
  return Math.max(0, Math.min(ttlSeconds, Math.floor(cutoffMs / 1000) - nowSeconds));
}

export function sessionBlockStatusCode(reason: string): 403 | 410 | 423 {
  return reason === "access_expired" ? 410 : reason === "room_paused" ? 423 : 403;
}
