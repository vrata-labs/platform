import type { RuntimeAccessError } from "./index.js";
import { describeIdentityRequirement } from "./session-upgrade.js";
import { t } from "./i18n/i18n.js";

export function describeRoomAccessError(error: Pick<RuntimeAccessError, "reason">): string {
  switch (error.reason) {
    case "invite_expired":
      return t("access.inviteExpired");
    case "invite_revoked":
      return t("access.inviteRevoked");
    case "room_disabled":
      return t("access.roomDisabled");
    case "waiting_room_pending":
      return t("access.waitingPending");
    case "waiting_room_rejected":
      return t("access.waitingRejected");
    case "invite_required":
      return t("access.inviteRequired");
    case "room_locked":
      return t("access.roomLocked");
    case "participant_removed":
      return t("access.participantRemoved");
    case "session_ended":
      return t("access.sessionEnded");
    case "identity_rate_limited":
      return t("access.identityRateLimited");
    case "room_identity_full":
      return t("access.identityFull");
    case "grant_required":
      return t("access.grantRequired");
    case "grant_invalid":
      return t("access.grantInvalid");
    case "grant_revoked":
      return t("access.grantRevoked");
    case "capacity_full":
      return t("access.capacityFull");
    case "rate_limited":
      return t("access.identityRateLimited");
    case "room_closed":
    case "access_expired":
      return t("access.roomEnded");
    case "room_paused":
      return t("access.roomPaused");
    default:
      return t("access.denied");
  }
}

export function describeSessionControlReason(reason: string): string {
  switch (reason) {
    case "identity_upgrade_required":
    case "identity_recovery_required":
      return describeIdentityRequirement(reason);
    case "room_locked":
      return t("access.roomLocked");
    case "participant_removed":
      return t("access.participantRemoved");
    case "session_ended":
      return t("access.sessionEnded");
    case "room_closed":
    case "access_expired":
      return t("access.roomEnded");
    case "room_paused":
      return t("access.roomPaused");
    default:
      return t("access.denied");
  }
}
