const hex32 = /^[a-f0-9]{32}$/;

/** An unguessable activation namespace isolates newly issued media grants from
 * LiveKit JWTs minted for arbitrary v1 room IDs before the cutover. A codec-3
 * name also carries the durable room incarnation, so a JWT for a deleted room
 * cannot join the native room of a recreated one with the same ID. */
export function roomMediaGrantName(roomId: string, prefix: string, mediaNamespace: string | null, incarnation?: string): string {
  if (!roomId || typeof roomId !== "string" || typeof prefix !== "string") throw new Error("invalid_media_room_scope");
  if (mediaNamespace === null) {
    if (incarnation !== undefined) throw new Error("invalid_media_room_scope");
    return `${prefix}${roomId}`;
  }
  if (!hex32.test(mediaNamespace)) throw new Error("identity_protocol_namespace_invalid");
  if (incarnation === undefined) return `${prefix}v2:${mediaNamespace}:${roomId}`;
  if (typeof incarnation !== "string" || !hex32.test(incarnation)) throw new Error("media_room_incarnation_invalid");
  return `${prefix}v3:${mediaNamespace}:${incarnation}:${roomId}`;
}
