import type { RoomRecord, Storage } from "../storage-contracts.js";
import { IdentityStorageError, type RoomIdentityActor, type RoomIdentityCommand } from "./contracts.js";
import { currentSessionControlV2 } from "./http-authority.js";
import { validId } from "./authority.js";

export interface RoomLifecycleActorV2 {
  actorType: "admin-token" | "room-session";
  actorId: string;
  identityId?: string;
  participantId?: string;
  authEpoch?: number;
  identityProtocolVersion?: 2;
  expiresAtSeconds?: number;
}

/** Only verified HTTP context supplies this deadline, never the request body. */
export function roomIdentityActorFromHttp(actor: RoomLifecycleActorV2, room: Pick<RoomRecord, "tenantId" | "roomId">): RoomIdentityActor {
  if (actor.actorType === "admin-token") return { actorType: "admin-token", actorId: actor.actorId, role: "admin" };
  if (actor.identityProtocolVersion !== 2 || !validId(actor.identityId) || !validId(actor.participantId)
    || typeof actor.authEpoch !== "number" || !Number.isSafeInteger(actor.authEpoch) || actor.authEpoch < 1) throw new IdentityStorageError("identity_not_active");
  if (typeof actor.expiresAtSeconds !== "number" || !Number.isSafeInteger(actor.expiresAtSeconds) || actor.expiresAtSeconds <= 0) throw new IdentityStorageError("identity_session_expired");
  return { actorType: "room-session", proof: { tenantId: room.tenantId, roomId: room.roomId,
    identityId: actor.identityId, participantId: actor.participantId, authEpoch: actor.authEpoch }, expiresAtSeconds: actor.expiresAtSeconds };
}

export async function applyRoomLifecycleV2(input: {
  storage: Storage;
  room: RoomRecord;
  actor: RoomLifecycleActorV2;
  command: RoomIdentityCommand;
  expectedRevision?: number;
}) {
  const scope = { tenantId: input.room.tenantId, roomId: input.room.roomId };
  const actor = roomIdentityActorFromHttp(input.actor, input.room);
  const authority = await input.storage.roomIdentities.authority(scope);
  if (!authority) throw new IdentityStorageError("room_not_found");
  if (input.expectedRevision !== undefined && (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0)) {
    throw new IdentityStorageError("invalid_identity_input");
  }
  const updated = await input.storage.roomIdentities.transition(scope, actor, input.expectedRevision ?? authority.revision, input.command);
  return { revision: updated.revision, state: await currentSessionControlV2(input.storage, input.room) };
}

export function lifecycleV2Error(error: unknown): { status: 400 | 401 | 403 | 404 | 409; error: string } | null {
  if (!(error instanceof IdentityStorageError)) return null;
  if (error.code === "identity_session_expired") return { status: 401, error: error.code };
  if (error.code === "invalid_identity_input") return { status: 400, error: error.code };
  if (error.code === "identity_forbidden" || error.code === "identity_not_active" || error.code === "room_blocked") {
    return { status: 403, error: error.code };
  }
  if (error.code === "room_not_found") return { status: 404, error: error.code };
  return { status: 409, error: error.code };
}
