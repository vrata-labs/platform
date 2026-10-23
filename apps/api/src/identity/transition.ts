import { activeIdentity, assertActorSession, assertRoomActive, bumpAuthority, checkRevision, fail, validCounter, validId } from "./authority.js";
import type { IdentityTransaction, RoomIdentityActor, RoomIdentityCommand } from "./contracts.js";

/** Runs under the same parent-room lock as admission, recovery and revocation. */
export function transitionIdentityAuthority(state: IdentityTransaction, actor: RoomIdentityActor, expectedRevision: number, command: RoomIdentityCommand, now: string): void {
  assertRoomActive(state);
  assertActorSession(actor, Date.parse(now));
  checkRevision(state, expectedRevision);
  const admin = actor?.actorType === "admin-token" && actor.role === "admin" && validId(actor.actorId);
  const identity = actor?.actorType === "room-session" ? activeIdentity(state, actor.proof) : null;
  if (!admin && !identity) fail("identity_forbidden");
  if (!command || !["lock", "unlock", "end", "grant-presenter", "revoke-presenter", "transfer-host", "transfer-owner", "remove"].includes(command.type)) fail("invalid_identity_input");
  const slot = command.type === "transfer-owner" ? state.authority.ownerIdentityId : state.authority.hostIdentityId;
  const personalOwner = state.room.roomType === "personal" && identity?.identityId === state.authority.ownerIdentityId;
  if (!admin && identity?.identityId !== slot && !personalOwner) fail("identity_forbidden");
  if (command.type === "end" && state.room.roomType === "personal" && !admin && !personalOwner) fail("identity_forbidden");
  const actorId = identity?.participantId ?? (actor as { actorId: string }).actorId;
  const control = state.authority.lifecycle;
  const revokePresenter = () => {
    state.authority.presenterIdentityId = null;
    control.presenterRevokedAt = now;
    control.presenterRevokedBy = actorId;
  };
  if (command.type === "lock") {
    control.lockedAt = now; control.lockedBy = actorId;
  } else if (command.type === "unlock") {
    control.lockedAt = null; control.lockedBy = null;
  } else if (command.type === "end") {
    control.endedAt = now; control.endedBy = actorId; revokePresenter();
  } else {
    if (!("targetParticipantId" in command)) fail("invalid_identity_input");
    if (!validId(command.targetParticipantId)) fail("invalid_identity_input");
    const target = [...state.identities.values()].find(value => value.participantId === command.targetParticipantId);
    if (!target) fail("identity_not_active");
    activeIdentity(state, target);
    switch (command.type) {
      case "grant-presenter":
        if (target.identityId === state.authority.hostIdentityId) fail("identity_forbidden");
        state.authority.presenterIdentityId = target.identityId;
        control.presenterGrantedAt = now; control.presenterGrantedBy = actorId;
        control.presenterRevokedAt = null; control.presenterRevokedBy = null;
        break;
      case "revoke-presenter":
        if (target.identityId !== state.authority.presenterIdentityId) fail("authority_conflict");
        revokePresenter();
        break;
      case "transfer-host":
        if (target.identityId === state.authority.hostIdentityId) fail("invalid_identity_input");
        state.authority.hostIdentityId = target.identityId;
        if (target.identityId === state.authority.presenterIdentityId) revokePresenter();
        break;
      case "transfer-owner":
        if (state.room.roomType !== "personal" || target.identityId === state.authority.ownerIdentityId) fail("identity_forbidden");
        state.authority.ownerIdentityId = target.identityId;
        break;
      case "remove":
        if (target.identityId === identity?.identityId || target.identityId === state.authority.ownerIdentityId) fail("identity_forbidden");
        if (command.reason !== undefined && typeof command.reason !== "string") fail("invalid_identity_input");
        if (!validCounter(target.authEpoch) || target.authEpoch === 2_147_483_647) fail("identity_not_active");
        target.authEpoch++; target.revokedAt = now;
        control.removedParticipants = { ...control.removedParticipants,
          [target.participantId]: { removedAt: now, removedBy: actorId, reason: command.reason?.trim().slice(0, 120) || null } };
        if (target.identityId === state.authority.presenterIdentityId) revokePresenter();
        for (const key of ["hostIdentityId", "ownerIdentityId"] as const) if (state.authority[key] === target.identityId) state.authority[key] = null;
        break;
    }
  }
  bumpAuthority(state);
}
