import { REMOTE_BROWSER_PUBLIC_HTTPS_MAX_LEASE_MS, type RemoteBrowserRoomPolicy } from "@vrata/shared-types";
import { referenceTemplateContract } from "@vrata/templates";
import { isAdhocRoomsAllowed, isRemoteBrowserFeatureEnabled } from "./feature-flags.js";
import { effectiveRoomMediaPolicy } from "./room-media-policy.js";
import { getManagedAccessBlockReason, isRoomDisabled, managedRoomCutoffMs } from "./room-session-control.js";
import type { RemoteBrowserUrlPolicy, RoomRecord, Storage } from "./storage-contracts.js";

export function isRemoteBrowserUrlPolicy(value: unknown): value is RemoteBrowserUrlPolicy {
  return value === "allowlist" || value === "public-https";
}

export function roomSupportsRemoteBrowserUrlPolicy(
  room: Pick<RoomRecord, "visibility" | "managed" | "templateSnapshot">,
  visibility = room.visibility
): boolean {
  return visibility === "private"
    && (room.managed ? room.managed.kind === "custom" : !referenceTemplateContract(room.templateSnapshot));
}

export async function readRemoteBrowserRoomPolicy(
  storage: Pick<Storage, "getRoomForRemoteBrowser" | "roomIdentities" | "identityProtocol">,
  roomId: string,
  now = Date.now
): Promise<RemoteBrowserRoomPolicy | null> {
  if (!isRemoteBrowserFeatureEnabled()) return null;
  const minimum = await storage.identityProtocol.minimum();
  const record = await storage.getRoomForRemoteBrowser(roomId);
  if (!record) return minimum === 1 && isAdhocRoomsAllowed() ? { mode: "allowlist", roomId } : null;
  const { room, policyRevision } = record;
  if (effectiveRoomMediaPolicy(room)?.modes.remoteBrowser === false || isRoomDisabled(room) || room.sessionControl?.endedAt) return null;
  const authority = await storage.roomIdentities.authority({ roomId, tenantId: room.tenantId });
  if (authority?.lifecycle.endedAt || (minimum >= 2 && !authority)) return null;
  const checkedAt = now();
  if (getManagedAccessBlockReason(room, checkedAt)) return null;
  if (room.remoteBrowserUrlPolicy !== "public-https" || !roomSupportsRemoteBrowserUrlPolicy(room)) return { mode: "allowlist", roomId };
  const cutoff = managedRoomCutoffMs(room);
  const validForMs = Math.min(REMOTE_BROWSER_PUBLIC_HTTPS_MAX_LEASE_MS, cutoff === null ? Infinity : cutoff - checkedAt);
  if (!Number.isSafeInteger(validForMs) || validForMs <= 0) return null;
  return { mode: "public-https", roomId, tenantId: room.tenantId, policyRevision, validForMs };
}
