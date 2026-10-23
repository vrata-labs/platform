/** An unguessable activation namespace isolates newly issued media grants from
 * LiveKit JWTs minted for arbitrary v1 room IDs before the cutover. */
export function roomMediaGrantName(roomId: string, prefix: string, mediaNamespace: string | null): string {
  if (!roomId || typeof roomId !== "string" || typeof prefix !== "string") throw new Error("invalid_media_room_scope");
  if (mediaNamespace === null) return `${prefix}${roomId}`;
  if (!/^[a-f0-9]{32}$/.test(mediaNamespace)) throw new Error("identity_protocol_namespace_invalid");
  return `${prefix}v2:${mediaNamespace}:${roomId}`;
}
