import { IdentityStorageError } from "./identity/contracts.js";
import { v2RoomSessionLifetimeSeconds } from "./identity/http-admission.js";
import { completeGrantRevocation } from "./grant-revocation.js";
import { createRoomIdentityService } from "./identity/service.js";
import { managedRoomCutoffMs } from "./room-session-control.js";
import { grantCodeHash, isGrantCode } from "./room-grants.js";
import type { Storage } from "./storage-contracts.js";

const ROOM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTITY_LIFETIME_SECONDS = 86_400;

type ExchangeCode = "invalid_request" | "room_not_found" | "grant_invalid" | "grant_revoked" | "room_closed" | "access_expired" | "room_paused"
  | "capacity_full" | "rate_limited" | "dependency_unavailable";

const STATUS: Record<ExchangeCode, number> = {
  invalid_request: 400, room_not_found: 404, grant_invalid: 409, grant_revoked: 410, room_closed: 410, access_expired: 410,
  room_paused: 423, capacity_full: 503, rate_limited: 429, dependency_unavailable: 503
};

export interface ExchangeResult {
  status: number;
  body: Record<string, unknown>;
  retryAfterSeconds?: number;
}

function failure(code: ExchangeCode, message: string, requestId: string, retryAfterSeconds?: number): ExchangeResult {
  const retryable = code === "rate_limited" || code === "capacity_full" || code === "dependency_unavailable";
  return {
    status: STATUS[code],
    body: { error: { code, message, requestId, retryable, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) } },
    ...(retryAfterSeconds ? { retryAfterSeconds } : {})
  };
}

/**
 * POST /api/room-grants/exchange (contract section 7): the runtime trades the one-time code from the URL
 * fragment for a v2 identity of a portal-managed room. The grant use is consumed under the room lock first;
 * if the identity cannot be created afterwards, the use is given back.
 */
export async function exchangeRoomGrant(input: {
  storage: Storage;
  payload: unknown;
  secret: string;
  requestId: string;
  reserveAdmission(): Promise<boolean>;
  now?: () => number;
}): Promise<ExchangeResult> {
  const { storage, requestId } = input;
  const now = input.now ?? Date.now;
  const payload = input.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return failure("invalid_request", "Request body must be a JSON object", requestId);
  const { roomId, code, displayName: rawDisplayName, ...rest } = payload as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return failure("invalid_request", `Unexpected fields: ${Object.keys(rest).join(", ")}`, requestId);
  if (typeof roomId !== "string" || !ROOM_ID_PATTERN.test(roomId)) return failure("invalid_request", "roomId must be a room UUID", requestId);
  if (!isGrantCode(code)) return failure("invalid_request", "code is not a grant code", requestId);
  const displayName = typeof rawDisplayName === "string" ? rawDisplayName.trim().replace(/\s+/g, " ").slice(0, 40) : "";
  if (rawDisplayName !== undefined && (typeof rawDisplayName !== "string" || !displayName)) return failure("invalid_request", "displayName must have 1 to 40 characters", requestId);

  if (await storage.identityProtocol.minimum() < 2) return failure("dependency_unavailable", "Room identity v2 is not active on this platform", requestId, 30);
  const room = await storage.getRoom(roomId);
  if (!room?.managed) return failure("room_not_found", "Room not found", requestId);
  if (!await input.reserveAdmission()) return failure("rate_limited", "Too many entries from this network", requestId, 60);

  const consumed = await storage.consumeManagedRoomGrant(roomId, grantCodeHash(input.secret, code));
  if (!consumed.ok) {
    const messages: Record<typeof consumed.code, string> = {
      grant_invalid: "The invitation is used up or not valid for this room",
      grant_revoked: "The invitation was withdrawn",
      capacity_full: "The room is full",
      room_closed: "The room is closed",
      access_expired: "Room access has expired",
      room_paused: "The room is paused"
    };
    return failure(consumed.code, messages[consumed.code], requestId, consumed.code === "capacity_full" ? 60 : undefined);
  }
  const { grant } = consumed;
  const cutoffMs = managedRoomCutoffMs(consumed.room)!;
  if (v2RoomSessionLifetimeSeconds(consumed.room, now()) <= 0) {
    await storage.releaseManagedRoomGrantUse(grant.grantId);
    return failure("access_expired", "Room access has expired", requestId);
  }
  const scope = { tenantId: consumed.room.tenantId, roomId };
  const service = createRoomIdentityService(storage.roomIdentities, input.secret, now,
    { identityLifetimeSeconds: IDENTITY_LIFETIME_SECONDS, sessionLifetimeSeconds: 900, sessionDeadlineSeconds: Math.floor(cutoffMs / 1000) });
  const account = grant.subject && grant.role !== "guest" ? { subject: grant.subject, role: grant.role } : null;
  // A revoke of this account that has not reached its identities yet is finished first, so this entry never resumes
  // a generation the portal already ended (and a late finisher never ends this entry).
  if (account) {
    for (const revoked of await storage.listIncompleteManagedAccountRevocations(roomId, account.subject)) await completeGrantRevocation(storage, revoked);
  }
  let issued: Awaited<ReturnType<typeof service.admitGrant>> & { resumed?: boolean };
  try {
    // An account grant resumes the account's current generation in this room (the same participant on every
    // device) or starts the next one; a guest grant always creates a new guest.
    issued = account
      ? await service.admitAccountGrant({ ...scope, displayName: displayName || grant.displayName || "Participant", grantId: grant.grantId, role: account.role, subject: account.subject,
        owner: consumed.room.roomType === "personal" && consumed.room.managed?.ownerSubject === account.subject })
      : await service.admitGrant({ ...scope, displayName: displayName || grant.displayName || "Guest", grantId: grant.grantId });
  } catch (error) {
    await storage.releaseManagedRoomGrantUse(grant.grantId).catch(() => undefined);
    if (error instanceof IdentityStorageError && error.code === "room_blocked") return failure("room_closed", "The room does not admit new participants", requestId);
    throw error;
  }
  const withdraw = () => storage.roomIdentities.revoke(scope, issued.identity.identityId, issued.identity.authEpoch).catch(() => undefined);
  try {
    await storage.recordManagedRoomGrantIdentity(grant.grantId, issued.identity.identityId);
  } catch (error) {
    // A guest identity the grant cannot revoke later must not stay usable. An account generation needs no link: a
    // revoke finds it by the account and the grant that created it, and another device may already use it.
    if (!account) await withdraw();
    await storage.releaseManagedRoomGrantUse(grant.grantId).catch(() => undefined);
    throw error;
  }
  // A revoke reads the identities of the grant after it marked the grant revoked. Reading the grant after the
  // identity is recorded closes the gap: either the revoke lists this identity, or this exchange sees the revoke.
  const current = await storage.getManagedRoomGrant(grant.grantId);
  if (!current || current.revokedAt) {
    // Only what this exchange created: a resumed generation belongs to another entry, which the revoke judges itself.
    if (!issued.resumed) await withdraw();
    return failure("grant_revoked", "The invitation was withdrawn", requestId);
  }
  let session: Awaited<ReturnType<typeof service.issueSession>>;
  try {
    session = await service.issueSession(issued.credential, scope);
  } catch (error) {
    if (error instanceof IdentityStorageError && error.code === "identity_session_expired") return failure("access_expired", "Room access has expired", requestId);
    throw error;
  }
  return {
    status: 200,
    body: {
      roomId,
      participantId: issued.identity.participantId,
      // The role the room gives now: a host grant makes only the first host (identity v2 rules).
      role: session.role,
      sessionToken: session.sessionToken,
      sessionExpiresAt: new Date(session.expiresAtSeconds * 1000).toISOString(),
      cutoff: new Date(cutoffMs).toISOString(),
      identityProtocolVersion: 2,
      identityCredential: issued.credential,
      ...(grant.returnContext ? { returnContext: grant.returnContext } : {})
    }
  };
}
