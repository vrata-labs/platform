import assert from "node:assert/strict";
import test from "node:test";
import { applyRoomTemplateContext } from "./template-context.js";
import { createRoomState, joinRoom, createMediaObject } from "./state.js";

const context = { templateId: "personal-room-basic", templateVersion: "2.0.0", contentHash: "a".repeat(64), surfaces: [{ surfaceId: "workspace-main", label: "Workspace", allowedObjectTypes: ["markdown-board"] }] };

test("reference room initializes exactly the signed surfaces and preserves state across reconnect", () => {
  const original = createRoomState("reference");
  const configured = applyRoomTemplateContext(original, context);
  assert.deepEqual(Object.keys(configured.mediaObjects.surfaces), ["workspace-main"]);
  assert.equal(Object.hasOwn(original.mediaObjects.surfaces, "workspace-main"), false);
  const joined = joinRoom(configured, "host", { role: "host", roomTemplate: context });
  assert.equal(applyRoomTemplateContext(joined, context), joined);
  assert.throws(() => applyRoomTemplateContext(joined), /room_template_context_required/);
  assert.throws(() => applyRoomTemplateContext(joined, { ...context, contentHash: "b".repeat(64) }), /room_template_context_mismatch/);
});

test("reference allowlists reject objects and surfaces outside the signed policy", () => {
  const room = joinRoom(applyRoomTemplateContext(createRoomState("reference"), context), "host", { role: "host" });
  const disallowed = createMediaObject(room, "host", { commandId: "deny", surfaceId: "workspace-main", objectType: "screen-share", objectId: "forbidden", nowMs: 1 });
  assert.equal(disallowed.result.accepted, false);
  const unknown = createMediaObject(room, "host", { commandId: "missing", surfaceId: "debug-main", objectType: "markdown-board", objectId: "missing", nowMs: 1 });
  assert.equal(unknown.result.accepted, false);
  const accepted = createMediaObject(room, "host", { commandId: "allowed", surfaceId: "workspace-main", objectType: "markdown-board", objectId: "board", nowMs: 1 });
  assert.equal(accepted.result.accepted, true);
  assert.equal(applyRoomTemplateContext(accepted.room, context), accepted.room);
});

test("a signed context cannot reset an occupied legacy room", () => {
  const legacy = joinRoom(createRoomState("legacy"), "member");
  assert.throws(() => applyRoomTemplateContext(legacy, context), /room_template_context_mismatch/);
  assert.equal(applyRoomTemplateContext(legacy), legacy);
});
