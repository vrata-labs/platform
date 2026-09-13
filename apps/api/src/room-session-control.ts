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

export function getSessionControlBlockReason(room: RoomRecord | null, participantId: string, role: RoomRole, hasExistingSession: boolean): string | null {
  if (!room) {
    return null;
  }
  if (isRoomDisabled(room)) {
    return "room_disabled";
  }
  if (!isHostControlsEnabled()) {
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
