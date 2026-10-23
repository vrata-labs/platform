import test from "node:test";
import assert from "node:assert/strict";
import {
  isRoomPluginPlainText, parseRoomPluginEvent, parseRoomPluginRequest, parseRoomPluginResponse,
  validateRoomPluginEvent, validateRoomPluginInstanceIdentity, validateRoomPluginRequest, validateRoomPluginResponse,
  RoomPluginValidationError, type RoomPluginValidationErrorCode
} from "../index.js";
import { createRoomPluginArtifact } from "../artifact.js";

const forbiddenCodePoints = [
  0x0000, 0x0009, 0x000a, 0x007f, 0x0085,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069,
  0x200e, 0x200f, 0x061c, 0x2028, 0x2029, 0xfeff,
  0x200b, 0x200c, 0x200d, 0x00ad
];
const moduleSource = "export function dispose() {}";
const manifest = {
  schemaVersion: 1, sdkApiVersion: 1, id: "welcome-status", version: "1.0.0",
  displayName: "Приветствие", requestedCapabilities: ["status.set"], configSchema: {}
} as const;
const status = (text: string) => ({ sdkApiVersion: 1, requestId: "request-1", operation: "status.set", payload: { text } });
const ready = (alias: string) => ({
  sdkApiVersion: 1, type: "room.ready",
  snapshot: { ownParticipantAlias: alias, arrivalAllowed: true, seats: [{ id: "seat-1", yaw: 0, occupantAlias: null }] }
});

function rejected(action: () => unknown, code: RoomPluginValidationErrorCode, label: string): void {
  assert.throws(action, (cause: unknown) => cause instanceof RoomPluginValidationError && cause.code === code, label);
}

test("Unicode controls, directional formatting and separators fail plain-text policy and status validation", () => {
  for (const codePoint of forbiddenCodePoints) {
    const label = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
    const text = `Обычный${String.fromCodePoint(codePoint)}статус`;
    assert.equal(isRoomPluginPlainText(text), false, label);
    assert.equal(isRoomPluginPlainText(text), false, `${label}: repeated check`);
    rejected(() => validateRoomPluginRequest(status(text)), "invalid_request", label);
    rejected(() => parseRoomPluginRequest(JSON.stringify(status(text))), "invalid_request", `${label}: JSON path`);
    rejected(() => createRoomPluginArtifact({ ...manifest, displayName: text }, moduleSource), "invalid_manifest", `${label}: displayName`);
  }
});

test("same Unicode policy protects request/response IDs, host binding IDs and seat/occupancy aliases", () => {
  for (const codePoint of forbiddenCodePoints) {
    const label = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
    const id = `Участник${String.fromCodePoint(codePoint)}1`;
    rejected(() => validateRoomPluginRequest({ ...status("Готово"), requestId: id }), "invalid_request", `${label}: requestId`);
    rejected(() => validateRoomPluginResponse({ sdkApiVersion: 1, requestId: id, ok: true, result: null }), "invalid_response", `${label}: response requestId`);
    rejected(() => parseRoomPluginResponse(JSON.stringify({ sdkApiVersion: 1, requestId: id, ok: true, result: null })), "invalid_response", `${label}: response JSON path`);
    rejected(() => validateRoomPluginInstanceIdentity({ bindingId: id, generation: 1, bindingRevision: 1 }), "invalid_instance_identity", `${label}: bindingId`);
    rejected(() => validateRoomPluginRequest({ sdkApiVersion: 1, requestId: "r", operation: "seating.claimSelfOnEntry", payload: { seatId: id } }), "invalid_request", `${label}: claim seatId`);
    rejected(() => validateRoomPluginEvent(ready(id)), "invalid_event", `${label}: own alias`);
    rejected(() => parseRoomPluginEvent(JSON.stringify(ready(id))), "invalid_event", `${label}: event JSON path`);
    for (const field of ["id", "occupantAlias"]) {
      const event = ready("own-alias");
      rejected(() => validateRoomPluginEvent({ ...event, snapshot: { ...event.snapshot, seats: [{ ...event.snapshot.seats[0], [field]: id }] } }), "invalid_event", `${label}: seat ${field}`);
    }
  }
});

test("ordinary multilingual text and combining marks remain unchanged and public IDs stay ASCII", () => {
  for (const text of ["Добро пожаловать", "欢迎参加会议", "مرحبا", "שלום", "नमस्ते", "こんにちは", "e\u0301", "🙂"]) {
    assert.equal(isRoomPluginPlainText(text), true, text);
    const request = validateRoomPluginRequest(status(text));
    assert.equal(request.operation, "status.set");
    if (request.operation === "status.set") assert.equal(request.payload.text, text, "no stripping or Unicode normalization");
    assert.equal(validateRoomPluginInstanceIdentity({ bindingId: text, generation: 1, bindingRevision: 1 }).bindingId, text);
    validateRoomPluginEvent(ready(text));
    assert.equal(createRoomPluginArtifact({ ...manifest, displayName: text }, moduleSource).artifact.manifest.displayName, text);
  }
  assert.equal(isRoomPluginPlainText(""), true, "empty status still clears text");
  validateRoomPluginRequest(status(""));
  assert.equal(isRoomPluginPlainText(null), false);
  assert.equal(isRoomPluginPlainText(1), false);
  rejected(() => createRoomPluginArtifact({ ...manifest, id: "приветствие" }, moduleSource), "invalid_manifest", "plugin id remains ASCII-only");
});

test("plain-text policy preserves explicit UTF-8 status, identifier and multilingual displayName limits", () => {
  validateRoomPluginRequest(status("Я".repeat(256)));
  rejected(() => validateRoomPluginRequest(status("Я".repeat(257))), "invalid_request", "status exceeds 512 UTF-8 bytes");
  validateRoomPluginInstanceIdentity({ bindingId: "К".repeat(64), generation: 1, bindingRevision: 1 });
  rejected(() => validateRoomPluginInstanceIdentity({ bindingId: "К".repeat(65), generation: 1, bindingRevision: 1 }), "invalid_instance_identity", "identifier exceeds 128 UTF-8 bytes");
  createRoomPluginArtifact({ ...manifest, displayName: "Я".repeat(64) }, moduleSource);
  rejected(() => createRoomPluginArtifact({ ...manifest, displayName: "Я".repeat(65) }, moduleSource), "invalid_manifest", "displayName exceeds 128 UTF-8 bytes");
});
