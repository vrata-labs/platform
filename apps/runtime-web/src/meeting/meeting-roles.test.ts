import test from "node:test";
import assert from "node:assert/strict";
import { buildMeetingPeople, meetingDisplayName, meetingPersonRole, meetingRoleLabel, type MeetingPeopleAuthority } from "./meeting-people.js";

const authority = (): MeetingPeopleAuthority => ({ identityProtocolVersion: 2, stateKnown: true, selfRole: "member",
  hostParticipantId: "host", presenterParticipantId: "speaker", ownerParticipantId: "owner" });

test("current authority slots override stale privileged presence labels", () => {
  const view = authority();
  assert.equal(meetingPersonRole({ participantId: "speaker", role: "guest" }, "self", view), "presenter");
  assert.equal(meetingPersonRole({ participantId: "host", role: "member" }, "self", view), "host");
  assert.equal(meetingPersonRole({ participantId: "old-speaker", role: "presenter" }, "self", view), null);
  assert.equal(meetingPersonRole({ participantId: "not-the-host", role: "host" }, "self", view), null);
  assert.equal(meetingPersonRole({ participantId: "member", role: "member" }, "self", view), "member");
});

test("legacy trusted Hosts without an assigned slot remain visible, without guessing a v2 Host", () => {
  const legacy = { ...authority(), identityProtocolVersion: null, hostParticipantId: null, presenterParticipantId: null } as MeetingPeopleAuthority;
  assert.equal(meetingPersonRole({ participantId: "self", role: "host" }, "self", { ...legacy, selfRole: "host" }), "host");
  assert.equal(meetingPersonRole({ participantId: "peer", role: "host" }, "self", legacy), "host");
  assert.equal(meetingPersonRole({ participantId: "peer", role: "host" }, "self", { ...legacy, identityProtocolVersion: 2 }), null);
});

test("owner and microphone annotations never invent a Host role and names stay plain bounded text", () => {
  const view = { ...authority(), slots: { host: null, presenter: null, owner: { participantId: "owner", displayName: "Canonical\nOwner" } } };
  const model = buildMeetingPeople([{ participantId: "owner", displayName: "untrusted replacement", role: "member", audioJoined: true, muted: true },
    { participantId: "opaque-private-id", displayName: "", role: "guest", audioJoined: false }], "self", 64, view);
  const owner = model.people.find(person => person.key === "owner")!;
  assert.equal(owner.name, "Canonical Owner"); assert.equal(owner.role, "member"); assert.equal(owner.owner, true); assert.equal(owner.audio, "Muted");
  assert.equal(meetingRoleLabel(owner.role, owner.owner), "Member, Owner");
  assert.equal(model.people.find(person => person.key === "opaque-private-id")!.name, "Participant");
  assert.equal(meetingDisplayName("x".repeat(1000))!.length, 80); assert.equal(meetingDisplayName(" \n"), null);
  assert.equal(meetingDisplayName("\u202eBob\u2069\u0085"), "Bob");
});
