import { isRoomRole, type RoomRole } from "@vrata/shared-types";
import type { AuthoritySlots } from "../participant-authority.js";

export interface MeetingPersonInput {
  participantId: string;
  displayName?: string;
  audioJoined?: boolean;
  muted?: boolean;
  activeMedia?: { audio?: boolean };
  role?: RoomRole;
}
export interface MeetingPerson {
  key: string;
  name: string;
  self: boolean;
  audio: "Mic on" | "Muted" | "Audio connected" | "Not in audio";
  role?: RoomRole | null;
  owner?: boolean;
}

export interface MeetingPeopleAuthority {
  identityProtocolVersion: 2 | null;
  stateKnown: boolean;
  selfRole: RoomRole | null;
  hostParticipantId: string | null;
  presenterParticipantId: string | null;
  ownerParticipantId: string | null;
  slots?: AuthoritySlots;
}

export function meetingDisplayName(value: unknown): string | null {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").trim().slice(0, 80) || null : null;
}

export function meetingPersonRole(person: MeetingPersonInput, localParticipantId: string, authority: MeetingPeopleAuthority): RoomRole | null {
  if (person.participantId === authority.hostParticipantId) return "host";
  if (person.participantId === authority.presenterParticipantId) return "presenter";
  const role = person.participantId === localParticipantId ? authority.selfRole : person.role;
  if (!isRoomRole(role)) return null;
  if (role === "host" || role === "presenter") {
    if (!authority.stateKnown && person.participantId === localParticipantId) return role;
    if (authority.identityProtocolVersion !== 2 && role === "host" && !authority.hostParticipantId) return role;
    return null;
  }
  return role;
}

export function meetingRoleLabel(role: RoomRole | null | undefined, owner = false): string {
  const title = role ? role[0].toUpperCase() + role.slice(1) : "Updating role";
  return owner ? `${title}, Owner` : title;
}

/** Display names are untrusted plain text, not role or account authority. */
export function buildMeetingPeople(input: readonly MeetingPersonInput[], localParticipantId: string, limit = 64, authority?: MeetingPeopleAuthority): { people: MeetingPerson[]; truncated: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error("invalid_meeting_people_limit");
  const unique = new Map<string, MeetingPerson>();
  for (const person of input.slice(0, 256)) {
    if (!person || typeof person.participantId !== "string" || !person.participantId.length || person.participantId.length > 200) continue;
    const slot = authority?.slots && Object.values(authority.slots).find(slot => slot?.participantId === person.participantId);
    const name = meetingDisplayName(slot?.displayName) ?? meetingDisplayName(person.displayName);
    const audio = person.audioJoined === false ? "Not in audio" : person.muted === true ? "Muted"
      : person.activeMedia?.audio === true ? "Mic on" : person.audioJoined === true ? "Audio connected" : "Not in audio";
    unique.set(person.participantId, { key: person.participantId, name: name || "Participant", self: person.participantId === localParticipantId, audio,
      ...(authority ? { role: meetingPersonRole(person, localParticipantId, authority), owner: authority.identityProtocolVersion === 2 && authority.ownerParticipantId === person.participantId } : {}) });
  }
  const people = [...unique.values()].sort((left, right) => Number(right.self) - Number(left.self)
    || left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
  return { people: people.slice(0, limit), truncated: people.length > limit || input.length > 256 };
}
