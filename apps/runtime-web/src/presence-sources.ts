import type { PresenceState } from "./index.js";

export function mergePresenceSources(realtimeParticipants: PresenceState[], fallbackParticipants: PresenceState[]): PresenceState[] {
  const participants = new Map<string, PresenceState>();
  for (const participant of fallbackParticipants) {
    participants.set(participant.participantId, participant);
  }
  for (const participant of realtimeParticipants) {
    participants.set(participant.participantId, participant);
  }
  return Array.from(participants.values());
}
