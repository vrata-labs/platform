import type { IdentityRoomBinding } from "./contracts.js";
import { defaultSessionControl, stableJson } from "../storage-room-records.js";

export const IDENTITY_LIFECYCLE_REQUIRES_V2 = "room_identity_lifecycle_requires_v2";

export function identityLifecycleChanged(previous: IdentityRoomBinding, next: IdentityRoomBinding): boolean {
  return previous.tenantId !== next.tenantId
    || (previous.roomType ?? "standard") !== (next.roomType ?? "standard")
    || (previous.ownerParticipantId ?? null) !== (next.ownerParticipantId ?? null)
    || stableJson(defaultSessionControl(previous.sessionControl)) !== stableJson(defaultSessionControl(next.sessionControl));
}
