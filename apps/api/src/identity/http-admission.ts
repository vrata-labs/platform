import { createRoomAccessDebugState } from "@vrata/shared-types";
import type { RoomRecord, Storage } from "../storage-contracts.js";
import { IdentityStorageError } from "./contracts.js";
import { createRoomIdentityService } from "./service.js";

export interface V2AdmissionRequest {
  identityProtocolVersion?: unknown;
  roomId?: unknown;
  participantId?: unknown;
  displayName?: unknown;
  requestedRole?: unknown;
  inviteToken?: unknown;
  identityCredential?: unknown;
  waitingCredential?: unknown;
  recoveryCredential?: unknown;
  sessionToken?: unknown;
}

export type V2AdmissionResult = { status: 200 | 202 | 400 | 401 | 403 | 404 | 409 | 426 | 429; body: Record<string, unknown> };
const deny = (status: V2AdmissionResult["status"], reason: string): V2AdmissionResult => ({ status, body: { error: "identity_required", reason } });

/** At floor 2 every credential here is a possession proof, never a public participant ID. */
export async function admitV2RoomSession(input: {
  storage: Storage;
  room: RoomRecord | null;
  payload: V2AdmissionRequest | null;
  bearer?: string | null;
  secret: string;
  hashInvite(token: string): string;
  now?: () => number;
}): Promise<V2AdmissionResult> {
  const payload = input.payload;
  if (payload?.identityProtocolVersion !== 2) return deny(426, "identity_upgrade_required");
  if (!input.room || typeof payload.roomId !== "string" || payload.roomId !== input.room.roomId) return { status: 404, body: { error: "room_not_found" } };
  const scope = { tenantId: input.room.tenantId, roomId: input.room.roomId };
  if (input.bearer || payload.sessionToken) return deny(426, "identity_upgrade_required");
  const rawDisplayName = typeof payload.displayName === "string" ? payload.displayName : "";
  const displayName = rawDisplayName.trim().replace(/\s+/g, " ").slice(0, 80);
  if (rawDisplayName && !displayName) return { status: 400, body: { error: "invalid_display_name" } };
  const service = createRoomIdentityService(input.storage.roomIdentities, input.secret, input.now ?? Date.now,
    { identityLifetimeSeconds: 86_400, sessionLifetimeSeconds: 900 });
  try {
    let issued: Awaited<ReturnType<typeof service.admit>>;
    if (payload.identityCredential !== undefined) {
      issued = await service.renewCredential(payload.identityCredential, scope);
    } else if (payload.waitingCredential !== undefined) {
      issued = await service.redeemWaiting(payload.waitingCredential, scope);
    } else if (payload.recoveryCredential !== undefined) {
      issued = await service.redeemRecovery(payload.recoveryCredential, scope);
    } else {
      if (typeof payload.inviteToken !== "undefined"
        && (typeof payload.inviteToken !== "string" || !/^[A-Za-z0-9_-]{20,200}$/.test(payload.inviteToken))) {
        return { status: 400, body: { error: "invalid_invite" } };
      }
      const inviteTokenHash = payload.inviteToken ? input.hashInvite(payload.inviteToken) : undefined;
      try {
        issued = await service.admit({ ...scope, displayName, inviteTokenHash });
      } catch (error) {
        if (!(error instanceof IdentityStorageError) || error.code !== "waiting_room_pending" || !inviteTokenHash) throw error;
        const pending = await service.beginWaiting({ ...scope, inviteTokenHash, displayName,
          expiresAt: new Date((input.now ?? Date.now)() + 900_000).toISOString() });
        return { status: 202, body: { error: "room_access_denied", reason: "waiting_room_pending",
          accessRequestId: pending.requestId, waitingCredential: pending.credential, expiresAt: pending.expiresAt } };
      }
    }
    const session = await service.issueSession(issued.credential, scope);
    return { status: 200, body: {
      identityProtocolVersion: 2, participantId: issued.identity.participantId,
      identityCredential: issued.credential, token: session.sessionToken, sessionId: session.sessionId,
      expiresInSeconds: 900, role: session.role, permissions: session.permissions, access: createRoomAccessDebugState(session.role)
    } };
  } catch (error) {
    if (!(error instanceof IdentityStorageError)) throw error;
    if (error.code === "waiting_room_pending") return { status: 202, body: { error: "room_access_denied", reason: "waiting_room_pending" } };
    if (error.code === "waiting_room_rejected") return { status: 403, body: { error: "room_access_denied", reason: "waiting_room_rejected" } };
    if (error.code === "waiting_room_capacity_reached") return { status: 429, body: { error: "room_access_denied", reason: "waiting_room_full" } };
    if (error.code === "room_blocked") return { status: 403, body: { error: "room_access_denied", reason: "room_locked" } };
    if (error.code === "room_not_found") return { status: 404, body: { error: "room_not_found" } };
    return deny(error.code === "identity_forbidden" ? 403 : 409,
      error.code === "identity_forbidden" ? "invite_required" : "identity_recovery_required");
  }
}
