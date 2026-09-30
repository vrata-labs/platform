import type { RuntimeAccessError } from "./index.js";

export function describeRoomAccessError(error: Pick<RuntimeAccessError, "reason">): string {
  switch (error.reason) {
    case "invite_expired":
      return "Access denied: invite link expired";
    case "invite_revoked":
      return "Access denied: invite link revoked";
    case "room_disabled":
      return "Access denied: room disabled";
    case "waiting_room_pending":
      return "Waiting for host approval";
    case "waiting_room_rejected":
      return "Access denied: host rejected the request";
    case "invite_required":
      return "Access denied: private invite required";
    case "room_locked":
      return "Access denied: room is locked";
    case "participant_removed":
      return "Access denied: removed by host";
    case "session_ended":
      return "Session ended by host";
    default:
      return "Access denied";
  }
}

export function describeSessionControlReason(reason: string): string {
  switch (reason) {
    case "room_locked":
      return "Access denied: room is locked";
    case "participant_removed":
      return "Access denied: removed by host";
    case "session_ended":
      return "Session ended by host";
    default:
      return "Access denied";
  }
}
