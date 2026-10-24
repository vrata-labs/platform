import { roomMediaGrantName } from "./identity/media-room.js";
import type { RoomRecord } from "./storage-contracts.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const EPOCH_SUFFIX = new RegExp(`^(.+):(${UUID})$`);

// A portal-managed room has one LiveKit room per access epoch (contract section 9): the v2 media name plus
// ":<epoch>". Room ids never contain ":", so the suffix is unambiguous. Rotating the epoch and deleting the
// old LiveKit room ends every connection of it, and a JWT minted for the old name cannot join the new one.
export function managedMediaRoomName(roomId: string, accessEpoch: string, prefix: string, mediaNamespace: string): string {
  if (!new RegExp(`^${UUID}$`).test(accessEpoch)) throw new Error("managed_media_epoch_invalid");
  return `${roomMediaGrantName(roomId, prefix, mediaNamespace)}:${accessEpoch}`;
}

/** The LiveKit room a participant of this room joins now. */
export function currentMediaRoomName(room: RoomRecord | null, roomId: string, prefix: string, mediaNamespace: string | null): string {
  if (room?.managed && mediaNamespace) return managedMediaRoomName(roomId, room.managed.accessEpoch, prefix, mediaNamespace);
  return roomMediaGrantName(roomId, prefix, mediaNamespace);
}

/** The platform room id behind a v2 media room name, with its epoch for managed rooms; null for foreign names. */
export function parseMediaRoomName(name: string, prefix: string, mediaNamespace: string): { roomId: string; epoch: string | null } | null {
  const base = `${prefix}v2:${mediaNamespace}:`;
  if (!name.startsWith(base)) return null;
  const rest = name.slice(base.length);
  const epoch = EPOCH_SUFFIX.exec(rest);
  const roomId = epoch ? epoch[1]! : rest;
  if (!roomId || roomId.includes(":")) return null;
  return { roomId, epoch: epoch ? epoch[2]! : null };
}
