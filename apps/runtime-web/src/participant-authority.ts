import { createRoomAccessFromPermissions, getRoomPermissions, isRoomPermission, isRoomRole,
  type RoomAccessDebugState, type RoomPermission } from "@vrata/shared-types";

export interface AuthorityParticipantLabel { participantId: string; displayName: string }
export interface AuthoritySlots {
  host: AuthorityParticipantLabel | null;
  presenter: AuthorityParticipantLabel | null;
  owner: AuthorityParticipantLabel | null;
}
export interface ParticipantAuthorityProjection {
  revision: number;
  participantId: string;
  access: RoomAccessDebugState;
  isOwner: boolean;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const participantId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;

export function parseAuthorityRevision(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

/** Explicit permissions from the authenticated API are the only source of UI
 * capabilities. Role labels and precomputed boolean flags grant nothing. */
export function parseParticipantAuthority(value: unknown, revision: unknown, expectedParticipantId: string): ParticipantAuthorityProjection | null {
  const version = parseAuthorityRevision(revision);
  if (version === null || !record(value) || value.participantId !== expectedParticipantId || !participantId(value.participantId)
    || value.status !== "active" || !isRoomRole(value.role) || typeof value.isOwner !== "boolean"
    || !Array.isArray(value.permissions) || value.permissions.length > 32) return null;
  const ceiling = new Set(getRoomPermissions(value.role));
  if (!value.permissions.includes("room.join") || new Set(value.permissions).size !== value.permissions.length
    || value.permissions.some(permission => !isRoomPermission(permission) || !ceiling.has(permission))) return null;
  return { revision: version, participantId: value.participantId, isOwner: value.isOwner,
    access: createRoomAccessFromPermissions(value.role, value.permissions as RoomPermission[]) };
}

/** Undefined is an older server/command response; null is a malformed view. */
export function parseAuthoritySlots(value: unknown): AuthoritySlots | null | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) return null;
  const slots: AuthoritySlots = { host: null, presenter: null, owner: null };
  for (const key of ["host", "presenter", "owner"] as const) {
    const slot = value[key];
    if (slot === null) continue;
    if (!record(slot) || !participantId(slot.participantId) || typeof slot.displayName !== "string" || slot.displayName.length > 80) return null;
    slots[key] = { participantId: slot.participantId, displayName: slot.displayName };
  }
  return slots;
}

/** Observation-cache key only, never an authority or an admission proof. */
export function participantAuthorityKey(projection: ParticipantAuthorityProjection): string {
  return JSON.stringify([projection.participantId, projection.access.role, [...projection.access.permissions].sort(), projection.isOwner]);
}
