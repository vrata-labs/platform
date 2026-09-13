import assert from "node:assert/strict";
import test from "node:test";
import type { RoomRole } from "@vrata/shared-types";
import type { RoomRecord, RoomSessionControlState } from "./storage.js";

import {
  isRoomDisabled,
  defaultSessionControlState,
  sanitizeSessionControlState,
  getRemovedParticipant,
  resolveEffectiveRoomRole,
  getSessionControlBlockReason
} from "./room-session-control.js";

const roles: RoomRole[] = ["guest", "member", "presenter", "host", "admin"];
const fields = [
  "hostParticipantId", "presenterParticipantId", "presenterGrantedAt", "presenterGrantedBy",
  "presenterRevokedAt", "presenterRevokedBy", "lockedAt", "lockedBy", "endedAt", "endedBy"
] as const;
const removed = { removedAt: "2026-01-01T00:00:00Z", removedBy: "host-1", reason: "test" };

function room(sessionControl?: RoomSessionControlState, overrides: Partial<RoomRecord> = {}): RoomRecord {
  const features = { voice: true, spatialAudio: true, screenShare: true };
  const theme = { primaryColor: "#000000", accentColor: "#ffffff" };
  return {
    roomId: "room-1", tenantId: "tenant-1", templateId: "meeting-room-basic", templateVersion: "0.1.0",
    templateSnapshot: {
      schemaVersion: 1, templateId: "meeting-room-basic", version: "0.1.0", label: "Test", assetSlots: [],
      roomConfig: {
        roomType: "standard", visibility: "public", guestAllowed: true, sceneBundleUrl: null, features, theme,
        avatarConfig: { avatarsEnabled: true, avatarQualityProfile: "desktop-standard", avatarFallbackCapsulesEnabled: true }
      }
    },
    name: "Room", features, assetIds: [], sessionControl, ...overrides
  };
}

// Synchronous checks restore both variables, including previously absent values.
function withFlags(primary: string | undefined, fallback: string | undefined, check: () => void): void {
  const keys = ["HOST_CONTROLS_ENABLED", "FEATURE_HOST_CONTROLS"] as const;
  const previous = keys.map((key) => process.env[key]);
  try {
    for (const [index, key] of keys.entries()) {
      const value = [primary, fallback][index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    check();
  } finally {
    for (const [index, key] of keys.entries()) {
      const value = previous[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function assertDefaults(state: Required<RoomSessionControlState>): void {
  assert.deepEqual(Object.keys(state), [...fields, "removedParticipants"]);
  for (const field of fields) assert.equal(state[field], null, field);
  assert.deepEqual(state.removedParticipants, {});
}

test("missing, null and empty control state produce the complete ordered defaults", () => {
  for (const input of [undefined, null, {}]) assertDefaults(defaultSessionControlState(input));
});

test("default fields use nullish fallback without trimming or interpreting timestamps", () => {
  for (const field of fields) {
    for (const value of [undefined, null, "", " ", "not-a-date", "participant-1"]) {
      assert.equal(defaultSessionControlState({ [field]: value })[field], value ?? null, field);
    }
  }
});

test("defaults discard unknown fields and retain the existing removed map reference", () => {
  const input = { lockedAt: "locked", removedParticipants: { participant: removed }, extra: "discard" };
  const before = structuredClone(input);
  const result = defaultSessionControlState(input);
  assert.equal(Object.hasOwn(result, "extra"), false);
  assert.equal(result.removedParticipants, input.removedParticipants);
  assert.deepEqual(input, before);
  assert.notEqual(result, input);
});

test("each default call allocates an independent empty map", () => {
  const first = defaultSessionControlState();
  const second = defaultSessionControlState();
  assert.notEqual(first.removedParticipants, second.removedParticipants);
  first.removedParticipants.participant = removed;
  assert.deepEqual(second.removedParticipants, {});
});

test("sanitization copies the map shallowly and preserves individual removal records", () => {
  const input = { removedParticipants: { participant: removed } };
  const result = sanitizeSessionControlState(input);
  assert.deepEqual(result, defaultSessionControlState(input));
  assert.notEqual(result.removedParticipants, input.removedParticipants);
  assert.equal(result.removedParticipants.participant, removed);
  delete result.removedParticipants.participant;
  assert.equal(input.removedParticipants.participant, removed);
  assertDefaults(sanitizeSessionControlState(null));
});

test("default lookup retains inherited entries while sanitization copies own entries only", () => {
  const map: NonNullable<RoomSessionControlState["removedParticipants"]> = Object.create({ inherited: removed });
  map.own = removed;
  const record = room({ removedParticipants: map });
  assert.equal(getRemovedParticipant(record, "inherited"), removed);
  assert.deepEqual(Object.keys(sanitizeSessionControlState(record.sessionControl).removedParticipants), ["own"]);
});

test("removal lookup rejects absent identities and returns the original record", () => {
  const record = room({ removedParticipants: { participant: removed } });
  for (const id of [undefined, null, "", "missing", " participant", "PARTICIPANT"]) {
    assert.equal(getRemovedParticipant(record, id), null);
  }
  assert.equal(getRemovedParticipant(record, "participant"), removed);
  assert.equal(getRemovedParticipant(room(), "missing"), null);
});

test("disabled rooms use exact status or a truthy disabled timestamp", () => {
  assert.equal(isRoomDisabled(null), false);
  assert.equal(isRoomDisabled(undefined), false);
  for (const status of [undefined, "active", "disabled"] as const) {
    for (const disabledAt of [undefined, null, "", " ", "not-a-date"]) {
      assert.equal(isRoomDisabled(room(undefined, { status, disabledAt })), status === "disabled" || Boolean(disabledAt));
    }
  }
});

for (const role of roles) {
  test(`effective role preserves no-host behavior for ${role}`, () => {
    const expected = role === "presenter" ? "member" : role;
    assert.equal(resolveEffectiveRoomRole(null, "participant", role), expected);
    assert.equal(resolveEffectiveRoomRole(room(), "participant", role), expected);
    assert.equal(resolveEffectiveRoomRole(room({ hostParticipantId: "" }), "participant", role), expected);
  });

  test(`effective role resolves assigned host and presenter before stale ${role}`, () => {
    const record = room({ hostParticipantId: "host", presenterParticipantId: "presenter" });
    assert.equal(resolveEffectiveRoomRole(record, "host", role), role === "admin" ? "admin" : "host");
    assert.equal(resolveEffectiveRoomRole(record, "presenter", role), role === "admin" ? "admin" : "presenter");
    assert.equal(resolveEffectiveRoomRole(record, "other", role), role === "host" || role === "presenter" ? "member" : role);
    assert.equal(resolveEffectiveRoomRole(room({ presenterParticipantId: "presenter" }), "presenter", role), role === "admin" ? "admin" : "presenter");
  });
}

test("host wins an assignment collision and IDs are compared without normalization", () => {
  const record = room({ hostParticipantId: "same", presenterParticipantId: "same" });
  assert.equal(resolveEffectiveRoomRole(record, "same", "guest"), "host");
  assert.equal(resolveEffectiveRoomRole(record, "same", "admin"), "admin");
  assert.equal(resolveEffectiveRoomRole(record, " same", "host"), "member");
  assert.equal(resolveEffectiveRoomRole(record, "SAME", "presenter"), "member");
  assert.equal(resolveEffectiveRoomRole(room({ presenterParticipantId: "" }), "", "guest"), "presenter");
});

test("role resolution does not mutate state or apply access blocks or feature flags", () => withFlags("false", "false", () => {
  const record = room({ hostParticipantId: "host", endedAt: "ended", lockedAt: "locked" }, { status: "disabled" });
  const before = structuredClone(record);
  assert.equal(resolveEffectiveRoomRole(record, "host", "guest"), "host");
  assert.deepEqual(record, before);
}));

test("missing rooms are never blocked by session control", () => withFlags(undefined, undefined, () => {
  assert.equal(getSessionControlBlockReason(null, "participant", "guest", false), null);
}));

test("disabled room precedes disabled host controls and every session restriction", () => withFlags("false", "false", () => {
  const record = room({ endedAt: "ended", lockedAt: "locked", removedParticipants: { participant: removed } }, { status: "disabled" });
  for (const role of roles) {
    assert.equal(getSessionControlBlockReason(record, "participant", role, true), "room_disabled");
  }
  assert.equal(getSessionControlBlockReason(room(undefined, { disabledAt: "invalid-date" }), "p", "admin", false), "room_disabled");
}));

test("ended then removed then locked is the unchanged block precedence", () => withFlags(undefined, undefined, () => {
  const record = room({ endedAt: "ended", lockedAt: "locked", removedParticipants: { participant: removed } });
  for (const role of roles) {
    assert.equal(getSessionControlBlockReason(record, "participant", role, true), "session_ended");
  }
  record.sessionControl!.endedAt = null;
  for (const role of roles) {
    assert.equal(getSessionControlBlockReason(record, "participant", role, true), "participant_removed");
  }
  record.sessionControl!.removedParticipants = {};
  assert.equal(getSessionControlBlockReason(record, "participant", "guest", false), "room_locked");
}));

test("locked rooms admit existing sessions and only host or admin for new sessions", () => withFlags(undefined, undefined, () => {
  const record = room({ lockedAt: "locked", hostParticipantId: "assigned-host" });
  for (const role of roles) {
    assert.equal(getSessionControlBlockReason(record, "participant", role, true), null);
    assert.equal(getSessionControlBlockReason(record, "participant", role, false), role === "host" || role === "admin" ? null : "room_locked");
  }
  // This helper consumes the supplied role; the caller resolves assignments separately.
  assert.equal(getSessionControlBlockReason(record, "assigned-host", "guest", false), "room_locked");
}));

test("empty timestamps are inactive but nonempty timestamps are not date-validated", () => withFlags(undefined, undefined, () => {
  assert.equal(getSessionControlBlockReason(room({ endedAt: "", lockedAt: "" }), "p", "guest", false), null);
  assert.equal(getSessionControlBlockReason(room({ endedAt: "not-a-date" }), "p", "guest", false), "session_ended");
  assert.equal(getSessionControlBlockReason(room({ lockedAt: " " }), "p", "guest", false), "room_locked");
}));

for (const [primary, fallback, expected] of [
  [undefined, undefined, "session_ended"], ["off", "true", null], ["true", "false", "session_ended"],
  ["", "false", null], ["invalid", "false", null], [undefined, "no", null]
] as const) {
  test(`host controls retain environment precedence for ${primary}/${fallback}`, () => withFlags(primary, fallback, () => {
    const record = room({ endedAt: "ended", lockedAt: "locked", removedParticipants: { participant: removed } });
    assert.equal(getSessionControlBlockReason(record, "participant", "guest", false), expected);
  }));
}

test("host control environment is read per call rather than captured on import", () => withFlags("false", undefined, () => {
  const record = room({ endedAt: "ended" });
  assert.equal(getSessionControlBlockReason(record, "p", "guest", false), null);
  process.env.HOST_CONTROLS_ENABLED = "true";
  assert.equal(getSessionControlBlockReason(record, "p", "guest", false), "session_ended");
}));
