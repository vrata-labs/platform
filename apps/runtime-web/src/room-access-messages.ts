import type { RuntimeAccessError } from "./index.js";
import { describeIdentityRequirement } from "./session-upgrade.js";

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
    case "identity_rate_limited":
      return "Too many new room entries. Please try again later";
    case "room_identity_full":
      return "This room has reached its identity limit. Contact the administrator";
    case "grant_required":
      return "Access denied: open the room from your invitation link";
    case "grant_invalid":
      return "Access denied: the invitation is used up or not valid for this room";
    case "grant_revoked":
      return "Access denied: the invitation was withdrawn";
    case "capacity_full":
      return "The room is full";
    case "rate_limited":
      return "Too many new room entries. Please try again later";
    case "room_closed":
    case "access_expired":
      return "This room has ended";
    case "room_paused":
      return "The room is paused";
    default:
      return "Access denied";
  }
}

export function describeSessionControlReason(reason: string): string {
  switch (reason) {
    case "identity_upgrade_required":
    case "identity_recovery_required":
      return describeIdentityRequirement(reason);
    case "room_locked":
      return "Access denied: room is locked";
    case "participant_removed":
      return "Access denied: removed by host";
    case "session_ended":
      return "Session ended by host";
    case "room_closed":
    case "access_expired":
      return "This room has ended";
    case "room_paused":
      return "The room is paused";
    default:
      return "Access denied";
  }
}
