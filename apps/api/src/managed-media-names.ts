import { roomMediaGrantName } from "./identity/media-room.js";
import type { RoomRecord } from "./storage-contracts.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const EPOCH_SUFFIX = new RegExp(`^(.+):(${UUID})$`);
const INCARNATION = /^[a-f0-9]{32}$/;

// A portal-managed room has one LiveKit room per access epoch (contract section 9): the media name plus
// ":<epoch>". Room ids never contain ":", so the suffix is unambiguous. Rotating the epoch and deleting the
// old LiveKit room ends every connection of it, and a JWT minted for the old name cannot join the new one.
// Past the codec-3 boundary the base name also carries the room record's incarnation.
export function managedMediaRoomName(roomId: string, accessEpoch: string, prefix: string, mediaNamespace: string,
  incarnation?: string): string {
  if (!new RegExp(`^${UUID}$`).test(accessEpoch)) throw new Error("managed_media_epoch_invalid");
  return `${roomMediaGrantName(roomId, prefix, mediaNamespace, incarnation)}:${accessEpoch}`;
}

/** The LiveKit room a participant of this room joins now; `incarnation` only past the codec-3 boundary. */
export function currentMediaRoomName(room: RoomRecord | null, roomId: string, prefix: string, mediaNamespace: string | null,
  incarnation?: string): string {
  if (room?.managed && mediaNamespace) return managedMediaRoomName(roomId, room.managed.accessEpoch, prefix, mediaNamespace, incarnation);
  return roomMediaGrantName(roomId, prefix, mediaNamespace, incarnation);
}

export interface ParsedMediaRoom {
  readonly codec: 2 | 3;
  readonly roomId: string;
  /** Codec 3 only: the room record generation the name was issued for. */
  readonly incarnation: string | null;
  /** Portal-managed rooms only: the access epoch the name was issued for. */
  readonly epoch: string | null;
}

/** The platform room behind an owned codec-2 or codec-3 media room name, with its generation and managed
 * epoch; null for foreign or non-canonical names. Only an exact round trip is owned. */
export function parseMediaRoomName(name: string, prefix: string, mediaNamespace: string): ParsedMediaRoom | null {
  if (typeof name !== "string" || !INCARNATION.test(mediaNamespace)) return null;
  const v2 = `${prefix}v2:${mediaNamespace}:`, v3 = `${prefix}v3:${mediaNamespace}:`;
  let codec: 2 | 3, incarnation: string | null = null, rest: string;
  if (name.startsWith(v2)) { codec = 2; rest = name.slice(v2.length); }
  else if (name.startsWith(v3)) {
    codec = 3; rest = name.slice(v3.length); incarnation = rest.slice(0, 32);
    if (!INCARNATION.test(incarnation) || rest[32] !== ":") return null;
    rest = rest.slice(33);
  } else return null;
  const suffix = EPOCH_SUFFIX.exec(rest);
  const roomId = suffix ? suffix[1]! : rest, epoch = suffix ? suffix[2]! : null;
  if (!roomId || roomId.includes(":") || roomId.length > 200 || /[\u0000-\u001f]/.test(roomId)) return null;
  const canonical = epoch ? managedMediaRoomName(roomId, epoch, prefix, mediaNamespace, incarnation ?? undefined)
    : roomMediaGrantName(roomId, prefix, mediaNamespace, incarnation ?? undefined);
  return canonical === name ? Object.freeze({ codec, roomId, incarnation, epoch }) : null;
}
