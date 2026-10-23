import { ROOM_PLUGIN_BROKER_ERROR_CODES, ROOM_PLUGIN_LIMITS, ROOM_PLUGIN_SDK_API_VERSION, type RoomPluginEvent, type RoomPluginInstanceIdentity, type RoomPluginRequest, type RoomPluginResponse } from "./contracts.js";
import { parseRoomPluginJson, roomPluginFields, roomPluginRecord, roomPluginUtf8ByteLength, validateRoomPluginData, type RoomPluginJson } from "./data.js";
import { fail, type RoomPluginValidationErrorCode } from "./errors.js";
import { isRoomPluginPlainText } from "./text.js";

function identifier(value: unknown, path: string, code: RoomPluginValidationErrorCode): void {
  if (!isRoomPluginPlainText(value) || !value.trim() || roomPluginUtf8ByteLength(value) > ROOM_PLUGIN_LIMITS.identifierBytes) fail(code, path);
}

/** Validates host metadata shape, not authority. Never accept this from VM request data. */
export function validateRoomPluginInstanceIdentity(value: unknown): Readonly<RoomPluginInstanceIdentity> {
  const identity = roomPluginRecord(validateRoomPluginData(value), "$", "invalid_instance_identity");
  roomPluginFields(identity, ["bindingId", "generation", "bindingRevision"], [], "$");
  identifier(identity.bindingId, "$.bindingId", "invalid_instance_identity");
  for (const field of ["generation", "bindingRevision"] as const) {
    const counter = identity[field];
    if (typeof counter !== "number" || !Number.isSafeInteger(counter) || counter < 0) fail("invalid_instance_identity", `$.${field}`);
  }
  return identity as unknown as Readonly<RoomPluginInstanceIdentity>;
}

function checkRequest(value: RoomPluginJson): RoomPluginRequest {
  const request = roomPluginRecord(value, "$", "invalid_request");
  roomPluginFields(request, ["sdkApiVersion", "requestId", "operation", "payload"], [], "$");
  if (request.sdkApiVersion !== ROOM_PLUGIN_SDK_API_VERSION) fail("unsupported_sdk_api_version", "$.sdkApiVersion");
  identifier(request.requestId, "$.requestId", "invalid_request");
  const payload = roomPluginRecord(request.payload, "$.payload", "invalid_request");
  switch (request.operation) {
    case "seating.claimSelfOnEntry":
      roomPluginFields(payload, ["seatId"], [], "$.payload");
      identifier(payload.seatId, "$.payload.seatId", "invalid_request");
      break;
    case "seating.cancelPendingOwnClaim":
      roomPluginFields(payload, [], [], "$.payload");
      break;
    case "status.set":
      roomPluginFields(payload, ["text"], [], "$.payload");
      if (!isRoomPluginPlainText(payload.text) || roomPluginUtf8ByteLength(payload.text) > ROOM_PLUGIN_LIMITS.statusTextBytes) fail("invalid_request", "$.payload.text");
      break;
    default: fail("unknown_capability", "$.operation");
  }
  return request as unknown as RoomPluginRequest;
}

export function validateRoomPluginRequest(value: unknown): RoomPluginRequest {
  return checkRequest(validateRoomPluginData(value));
}

export function parseRoomPluginRequest(input: string | Uint8Array): RoomPluginRequest {
  return checkRequest(parseRoomPluginJson(input));
}

function snapshot(value: RoomPluginJson | undefined): void {
  const data = roomPluginRecord(value, "$.snapshot", "invalid_event");
  roomPluginFields(data, ["ownParticipantAlias", "arrivalAllowed", "seats"], [], "$.snapshot");
  identifier(data.ownParticipantAlias, "$.snapshot.ownParticipantAlias", "invalid_event");
  if (typeof data.arrivalAllowed !== "boolean" || !Array.isArray(data.seats)) fail("invalid_event", "$.snapshot");
  const seen = new Set<string>();
  for (const raw of data.seats) {
    const seat = roomPluginRecord(raw, "$.snapshot.seats[]", "invalid_event");
    roomPluginFields(seat, ["id", "yaw", "occupantAlias"], [], "$.snapshot.seats[]");
    identifier(seat.id, "$.snapshot.seats[].id", "invalid_event");
    if (typeof seat.yaw !== "number" || seen.has(seat.id as string)) fail("invalid_event", "$.snapshot.seats[]");
    if (seat.occupantAlias !== null) identifier(seat.occupantAlias, "$.snapshot.seats[].occupantAlias", "invalid_event");
    seen.add(seat.id as string);
  }
}

function checkEvent(value: RoomPluginJson): RoomPluginEvent {
  const event = roomPluginRecord(value, "$", "invalid_event");
  if (event.sdkApiVersion !== ROOM_PLUGIN_SDK_API_VERSION) fail("unsupported_sdk_api_version", "$.sdkApiVersion");
  switch (event.type) {
    case "room.ready":
    case "seating.snapshot":
      roomPluginFields(event, ["sdkApiVersion", "type", "snapshot"], [], "$");
      snapshot(event.snapshot);
      break;
    case "room.connection":
      roomPluginFields(event, ["sdkApiVersion", "type", "state"], [], "$");
      if (!["connected", "reconnecting", "disconnected"].includes(event.state as string)) fail("invalid_event", "$.state");
      break;
    case "lifecycle.dispose":
      roomPluginFields(event, ["sdkApiVersion", "type", "reason"], [], "$");
      if (!["disabled", "updated", "session-ended", "lease-expired"].includes(event.reason as string)) fail("invalid_event", "$.reason");
      break;
    default: fail("invalid_event", "$.type");
  }
  return event as unknown as RoomPluginEvent;
}

export function validateRoomPluginEvent(value: unknown): RoomPluginEvent {
  return checkEvent(validateRoomPluginData(value));
}

export function parseRoomPluginEvent(input: string | Uint8Array): RoomPluginEvent {
  return checkEvent(parseRoomPluginJson(input));
}

function checkResponse(value: RoomPluginJson): RoomPluginResponse {
  const response = roomPluginRecord(value, "$", "invalid_response");
  if (response.sdkApiVersion !== ROOM_PLUGIN_SDK_API_VERSION) fail("unsupported_sdk_api_version", "$.sdkApiVersion");
  identifier(response.requestId, "$.requestId", "invalid_response");
  if (response.ok === true) {
    roomPluginFields(response, ["sdkApiVersion", "requestId", "ok", "result"], [], "$");
    if (response.result !== null && !["accepted", "busy", "cancelled", "offline"].includes(response.result as string)) fail("invalid_response", "$.result");
  } else if (response.ok === false) {
    roomPluginFields(response, ["sdkApiVersion", "requestId", "ok", "error"], [], "$");
    if (!(ROOM_PLUGIN_BROKER_ERROR_CODES as readonly string[]).includes(response.error as string)) fail("invalid_response", "$.error");
  } else fail("invalid_response", "$.ok");
  return response as unknown as RoomPluginResponse;
}

export function validateRoomPluginResponse(value: unknown): RoomPluginResponse {
  return checkResponse(validateRoomPluginData(value));
}

export function parseRoomPluginResponse(input: string | Uint8Array): RoomPluginResponse {
  return checkResponse(parseRoomPluginJson(input));
}
