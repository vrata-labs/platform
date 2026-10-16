export interface MeetingPersonInput {
  participantId: string;
  displayName?: string;
  audioJoined?: boolean;
  muted?: boolean;
  activeMedia?: { audio?: boolean };
}
export interface MeetingPerson {
  key: string;
  name: string;
  self: boolean;
  audio: "Mic on" | "Muted" | "Audio connected" | "Not in audio";
}

/** Display names are untrusted plain text, not role or account authority. */
export function buildMeetingPeople(input: readonly MeetingPersonInput[], localParticipantId: string, limit = 64): { people: MeetingPerson[]; truncated: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error("invalid_meeting_people_limit");
  const unique = new Map<string, MeetingPerson>();
  for (const person of input.slice(0, 256)) {
    if (!person || typeof person.participantId !== "string" || !person.participantId.length || person.participantId.length > 200) continue;
    const name = typeof person.displayName === "string"
      ? person.displayName.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) : "";
    const audio = person.audioJoined === false ? "Not in audio" : person.muted === true ? "Muted"
      : person.activeMedia?.audio === true ? "Mic on" : person.audioJoined === true ? "Audio connected" : "Not in audio";
    unique.set(person.participantId, { key: person.participantId, name: name || "Participant", self: person.participantId === localParticipantId, audio });
  }
  const people = [...unique.values()].sort((left, right) => Number(right.self) - Number(left.self)
    || left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
  return { people: people.slice(0, limit), truncated: people.length > limit || input.length > 256 };
}
