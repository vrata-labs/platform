import test from "node:test";
import assert from "node:assert/strict";
import { getRoomPermissions } from "@vrata/shared-types";
import { parseAuthorityRevision, parseAuthoritySlots, parseParticipantAuthority, participantAuthorityKey } from "./participant-authority.js";

const self = () => ({ participantId: "self", status: "active", role: "presenter", permissions: getRoomPermissions("presenter"), isOwner: false });

test("participant access derives capabilities from explicit permissions, never a stronger role or flags", () => {
  const value = { ...self(), permissions: ["room.join", "document.view", "document.upload"], access: { canStartScreenShare: true, canManageRoomSession: true } };
  const parsed = parseParticipantAuthority(value, 4, "self")!;
  assert.equal(parsed.access.role, "presenter"); assert.equal(parsed.access.canStartScreenShare, false);
  assert.equal(parsed.access.canManageRoomSession, false); assert.equal(parsed.access.canPresentDocuments, false);
  value.permissions.push("screen-share.start"); assert.equal(parsed.access.permissions.includes("screen-share.start"), false);
});

test("v2 projection requires current subject, bounded revision, known role and a permission subset", () => {
  for (const value of [null, [], { ...self(), participantId: "other" }, { ...self(), status: "blocked" },
    { ...self(), role: "owner" }, { ...self(), isOwner: "true" }, { ...self(), permissions: [] }, { ...self(), permissions: ["unknown.permission"] },
    { ...self(), permissions: ["room.admin"] }, { ...self(), permissions: ["room.join", "room.join"] }]) {
    assert.equal(parseParticipantAuthority(value, 1, "self"), null);
  }
  for (const revision of [undefined, null, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    assert.equal(parseParticipantAuthority(self(), revision, "self"), null); assert.equal(parseAuthorityRevision(revision), null);
  }
  assert.equal(parseAuthorityRevision(0), 0);
});

test("personal ownership does not invent the Host capability set for a Member", () => {
  const parsed = parseParticipantAuthority({ ...self(), role: "member", permissions: getRoomPermissions("member"), isOwner: true }, 9, "self")!;
  assert.equal(parsed.isOwner, true); assert.equal(parsed.access.role, "member"); assert.equal(parsed.access.canManageRoomSession, false);
});

test("authority labels preserve opaque IDs without interpreting them as credentials or object keys", () => {
  const slots = parseAuthoritySlots({ host: { participantId: "__proto__", displayName: "<img src=x>" }, presenter: null, owner: null })!;
  assert.equal(slots.host?.participantId, "__proto__"); assert.equal(slots.host?.displayName, "<img src=x>");
  assert.equal(parseAuthoritySlots(undefined), undefined); assert.equal(parseAuthoritySlots({ host: null, presenter: null }), null);
  assert.equal(parseAuthoritySlots({ host: { participantId: "self", displayName: "x".repeat(81) }, presenter: null, owner: null }), null);
});

test("authority cache comparison is stable across revision and permission order, but not role or ownership", () => {
  const first = parseParticipantAuthority(self(), 1, "self")!;
  const second = parseParticipantAuthority({ ...self(), permissions: [...self().permissions].reverse() }, 2, "self")!;
  assert.equal(participantAuthorityKey(first), participantAuthorityKey(second));
  assert.notEqual(participantAuthorityKey(first), participantAuthorityKey({ ...second, isOwner: true }));
});
