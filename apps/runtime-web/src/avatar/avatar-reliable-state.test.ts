import test from "node:test";
import assert from "node:assert/strict";

import { isAvatarReliableState, parseAvatarReliableState } from "./avatar-reliable-state.js";

test("parseAvatarReliableState accepts valid payload", () => {
  const state = parseAvatarReliableState({
    participantId: "p-1",
    avatarId: "preset-01",
    recipeVersion: 1,
    inputMode: "desktop",
    seated: false,
    muted: true,
    audioActive: false,
    updatedAt: new Date(0).toISOString()
  });
  assert.equal(state.avatarId, "preset-01");
});

test("isAvatarReliableState rejects invalid payload", () => {
  assert.equal(isAvatarReliableState({ participantId: "p-1" }), false);
});
