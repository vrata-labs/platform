import type { RoomPluginRoomSnapshot } from "@vrata/room-plugin-sdk";

/** Binding-scoped alias, not a raw participant identity or credential. */
function offset(alias: string, length: number): number {
  let hash = 2166136261;
  for (let i = 0; i < alias.length; i++) hash = Math.imul(hash ^ alias.charCodeAt(i), 16777619) >>> 0;
  return hash % length;
}

export function nextCandidate(snapshot: RoomPluginRoomSnapshot, attempted: ReadonlySet<string>): string | undefined {
  const seats = [...snapshot.seats].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (!seats.length) return undefined;
  const start = offset(snapshot.ownParticipantAlias, seats.length);
  for (let i = 0; i < seats.length; i++) {
    const seat = seats[(start + i) % seats.length]!;
    if (seat.occupantAlias === null && !attempted.has(seat.id)) return seat.id;
  }
  return undefined;
}
