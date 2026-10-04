import test from "node:test";
import assert from "node:assert/strict";
import { parseRoomPluginEvent, parseRoomPluginRequest, parseRoomPluginResponse, validateRoomPluginEvent, validateRoomPluginInstanceIdentity, validateRoomPluginRequest, validateRoomPluginResponse } from "../messages.js";
import { ROOM_PLUGIN_LIMITS } from "../contracts.js";
import { RoomPluginValidationError, type RoomPluginValidationErrorCode } from "../errors.js";

function error(action: () => unknown, code: RoomPluginValidationErrorCode): void {
  assert.throws(action, (cause: unknown) => cause instanceof RoomPluginValidationError && cause.code === code);
}
const claim = { sdkApiVersion: 1, requestId: "r1", operation: "seating.claimSelfOnEntry", payload: { seatId: "seat-1" } };
const snapshot = { ownParticipantAlias: "local-alias", arrivalAllowed: true, seats: [{ id: "seat-1", yaw: 0, occupantAlias: null }] };

test("SDK requests expose only own seating operations and bounded plain status", () => {
  assert.equal(validateRoomPluginRequest(claim).operation, "seating.claimSelfOnEntry");
  const status = validateRoomPluginRequest({ sdkApiVersion: 1, requestId: "r2", operation: "status.set", payload: { text: "<b>Plain text</b>" } });
  assert.equal(status.operation, "status.set", "trusted UI must render this with textContent");
  validateRoomPluginRequest({ sdkApiVersion: 1, requestId: "r3", operation: "seating.cancelPendingOwnClaim", payload: {} });
  assert.equal(parseRoomPluginRequest(Buffer.from(JSON.stringify(claim))).requestId, "r1");
});

test("plugin cannot inject participant, generation, room, token or arbitrary pose commands", () => {
  for (const key of ["participantId", "roomId", "bindingRevision", "generation", "token"]) {
    error(() => validateRoomPluginRequest({ ...claim, [key]: "forged" }), "unknown_field");
    error(() => validateRoomPluginRequest({ ...claim, payload: { ...claim.payload, [key]: "forged" } }), "unknown_field");
  }
  error(() => validateRoomPluginRequest({ ...claim, operation: "pose.set", payload: { x: 1, y: 2, z: 3 } }), "unknown_capability");
  error(() => validateRoomPluginRequest({ ...claim, sdkApiVersion: 2 }), "unsupported_sdk_api_version");
  error(() => validateRoomPluginRequest({ ...claim, payload: null }), "invalid_request");
  error(() => validateRoomPluginRequest({ ...claim, payload: { seatId: 1 } }), "invalid_request");
  error(() => validateRoomPluginRequest({ ...claim, requestId: "" }), "invalid_request");
});

test("host-only identity is copied/frozen with exact fields and lossless generation counters", () => {
  const input = { bindingId: "binding-1", generation: 0, bindingRevision: Number.MAX_SAFE_INTEGER };
  const identity = validateRoomPluginInstanceIdentity(input);
  assert.equal(identity.generation, 0);
  assert.equal(identity.bindingRevision, Number.MAX_SAFE_INTEGER);
  assert.ok(Object.isFrozen(identity));
  input.generation = 1;
  assert.equal(identity.generation, 0, "host stamp must not change through input aliasing");
  for (const field of ["generation", "bindingRevision"]) {
    for (const value of [-1, 0.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
      error(() => validateRoomPluginInstanceIdentity({ ...input, [field]: value }), "invalid_instance_identity");
    }
    for (const value of [NaN, Infinity]) {
      error(() => validateRoomPluginInstanceIdentity({ ...input, [field]: value }), "invalid_data");
    }
  }
  error(() => validateRoomPluginInstanceIdentity({ ...input, token: "not-host-metadata" }), "unknown_field");
  error(() => validateRoomPluginInstanceIdentity({ ...input, bindingId: "" }), "invalid_instance_identity");
  error(() => validateRoomPluginInstanceIdentity(null), "invalid_instance_identity");
  for (const field of ["bindingId", "generation", "bindingRevision"]) {
    error(() => validateRoomPluginEvent({ sdkApiVersion: 1, type: "room.connection", state: "connected", [field]: input[field as keyof typeof input] }), "unknown_field");
    error(() => validateRoomPluginResponse({ sdkApiVersion: 1, requestId: "r", ok: true, result: null, [field]: input[field as keyof typeof input] }), "unknown_field");
  }
});

test("status text, DTO byte size and DTO depth are bounded", () => {
  const request = { sdkApiVersion: 1, requestId: "r", operation: "status.set", payload: { text: "é".repeat(256) } };
  validateRoomPluginRequest(request);
  error(() => validateRoomPluginRequest({ ...request, payload: { text: "é".repeat(257) } }), "invalid_request");
  error(() => validateRoomPluginRequest({ ...request, payload: { text: "Warning\nspoof" } }), "invalid_request");
  error(() => parseRoomPluginRequest(" ".repeat(ROOM_PLUGIN_LIMITS.messageBytes + 1)), "message_too_large");
  error(() => parseRoomPluginRequest("[".repeat(1000)), "nesting_too_deep");
});

test("room-ready and occupancy events accept only seats, yaw and binding aliases", () => {
  validateRoomPluginEvent({ sdkApiVersion: 1, type: "room.ready", snapshot });
  validateRoomPluginEvent({ sdkApiVersion: 1, type: "seating.snapshot", snapshot: { ...snapshot, seats: [{ id: "seat-1", yaw: 1, occupantAlias: "peer-alias" }] } });
  error(() => validateRoomPluginEvent({ sdkApiVersion: 1, type: "room.ready", snapshot: { ...snapshot, token: "private" } }), "unknown_field");
  error(() => validateRoomPluginEvent({ sdkApiVersion: 1, type: "room.ready", snapshot: { ...snapshot, seats: [{ ...snapshot.seats[0], displayName: "private" }] } }), "unknown_field");
  error(() => validateRoomPluginEvent({ sdkApiVersion: 1, type: "room.ready", snapshot: { ...snapshot, seats: [snapshot.seats[0], snapshot.seats[0]] } }), "invalid_event");
  error(() => validateRoomPluginEvent({ sdkApiVersion: 1, type: "room.ready", snapshot: { ...snapshot, seats: [{ ...snapshot.seats[0], yaw: NaN }] } }), "invalid_data");
});

test("connection and dispose events use stable enum values and reject extra fields", () => {
  validateRoomPluginEvent({ sdkApiVersion: 1, type: "room.connection", state: "reconnecting" });
  validateRoomPluginEvent({ sdkApiVersion: 1, type: "lifecycle.dispose", reason: "lease-expired" });
  error(() => validateRoomPluginEvent({ sdkApiVersion: 1, type: "room.connection", state: "anything" }), "invalid_event");
  error(() => validateRoomPluginEvent({ sdkApiVersion: 1, type: "lifecycle.dispose", reason: "updated", credentials: {} }), "unknown_field");
  error(() => validateRoomPluginEvent(null), "invalid_event");
  assert.equal(parseRoomPluginEvent('{"sdkApiVersion":1,"type":"room.connection","state":"connected"}').type, "room.connection");
  error(() => parseRoomPluginEvent(" ".repeat(ROOM_PLUGIN_LIMITS.messageBytes + 1)), "message_too_large");
});

test("responses are bounded DTOs with enum results/errors, never native error objects", () => {
  validateRoomPluginResponse({ sdkApiVersion: 1, requestId: "r", ok: true, result: "accepted" });
  validateRoomPluginResponse({ sdkApiVersion: 1, requestId: "r", ok: true, result: null });
  assert.equal(parseRoomPluginResponse('{"sdkApiVersion":1,"requestId":"r","ok":false,"error":"lease-expired"}').ok, false);
  error(() => validateRoomPluginResponse({ sdkApiVersion: 1, requestId: "r", ok: "true", result: null }), "invalid_response");
  error(() => validateRoomPluginResponse({ sdkApiVersion: 1, requestId: "r", ok: false, error: new Error("secret") }), "invalid_data");
  error(() => validateRoomPluginResponse({ sdkApiVersion: 1, requestId: "r", ok: false, error: "unbounded exception text" }), "invalid_response");
  error(() => validateRoomPluginResponse({ sdkApiVersion: 1, requestId: "r", ok: true, result: "accepted", participantId: "raw" }), "unknown_field");
  error(() => parseRoomPluginResponse(" ".repeat(ROOM_PLUGIN_LIMITS.messageBytes + 1)), "message_too_large");
});
