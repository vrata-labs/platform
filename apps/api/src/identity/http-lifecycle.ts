import type { RoomRecord, Storage } from "../storage-contracts.js";
import { IdentityStorageError, type RoomIdentityActor, type RoomIdentityCommand } from "./contracts.js";
import { currentSessionControlV2 } from "./http-authority.js";

export interface RoomLifecycleActorV2 {
  actorType: "admin-token" | "room-session";
  actorId: string;
  identityId?: string;
  participantId?: string;
  authEpoch?: number;
}

export async function applyRoomLifecycleV2(input: {
  storage: Storage;
  room: RoomRecord;
  actor: RoomLifecycleActorV2;
  command: RoomIdentityCommand;
  expectedRevision?: number;
}) {
  const scope = { tenantId: input.room.tenantId, roomId: input.room.roomId };
  const authority = await input.storage.roomIdentities.authority(scope);
  if (!authority) throw new IdentityStorageError("room_not_found");
  if (input.expectedRevision !== undefined && (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0)) {
    throw new IdentityStorageError("invalid_identity_input");
  }
  const actor: RoomIdentityActor = input.actor.actorType === "admin-token"
    ? { actorType: "admin-token", actorId: input.actor.actorId, role: "admin" }
    : { actorType: "room-session", proof: {
      ...scope, identityId: input.actor.identityId ?? "", participantId: input.actor.participantId ?? "",
      authEpoch: input.actor.authEpoch ?? 0
    } };
  const updated = await input.storage.roomIdentities.transition(scope, actor, input.expectedRevision ?? authority.revision, input.command);
  return { revision: updated.revision, state: await currentSessionControlV2(input.storage, input.room) };
}

export function lifecycleV2Error(error: unknown): { status: 400 | 403 | 404 | 409; error: string } | null {
  if (!(error instanceof IdentityStorageError)) return null;
  if (error.code === "invalid_identity_input") return { status: 400, error: error.code };
  if (error.code === "identity_forbidden" || error.code === "identity_not_active" || error.code === "room_blocked") {
    return { status: 403, error: error.code };
  }
  if (error.code === "room_not_found") return { status: 404, error: error.code };
  return { status: 409, error: error.code };
}
