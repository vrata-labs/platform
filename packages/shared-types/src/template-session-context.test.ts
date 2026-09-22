import assert from "node:assert/strict";
import test from "node:test";
import { parseRoomTemplateSessionContext } from "./template-session-context.js";
import { signRoomSessionToken, verifyRoomSessionToken } from "./session-token.js";
import type { RoomSessionTokenPayload } from "./session-token.js";

const context = { templateId: "personal-room-basic", templateVersion: "2.0.0", contentHash: "a".repeat(64), surfaces: [{ surfaceId: "workspace-main", label: "Workspace", allowedObjectTypes: ["markdown-board"] }] };

test("signed reference context carries only explicit logical surfaces and immutable identity", () => {
  const parsed = parseRoomTemplateSessionContext({ ...context, surfaces: [{ ...context.surfaces[0], transform: { x: 999 }, widthM: 100 }] });
  assert.deepEqual(parsed, context);
  parsed.surfaces[0]!.allowedObjectTypes.push("screen-share");
  assert.deepEqual(context.surfaces[0]!.allowedObjectTypes, ["markdown-board"]);
  const payload: RoomSessionTokenPayload = { tenantId: "tenant", roomId: "room", participantId: "guest", displayName: "Guest", role: "guest", permissions: ["room.join"], sessionId: "session", iat: 1, exp: 100, jti: "token", roomTemplate: context };
  const verified = verifyRoomSessionToken(signRoomSessionToken(payload, "test-template-secret"), "test-template-secret", { nowSeconds: 2 });
  assert(verified.ok);
  assert.deepEqual(verified.payload.roomTemplate, context);
});

test("reference contexts reject incomplete allowlists, unknown types, duplicates and malformed hashes", () => {
  for (const value of [
    { ...context, contentHash: "wrong" },
    { ...context, surfaces: [] },
    { ...context, surfaces: [{ surfaceId: "workspace-main", label: "Workspace" }] },
    { ...context, surfaces: [{ ...context.surfaces[0], allowedObjectTypes: ["missing-type"] }] },
    { ...context, surfaces: [context.surfaces[0], context.surfaces[0]] }
  ]) assert.throws(() => parseRoomTemplateSessionContext(value));
});
