import test from "node:test";
import assert from "node:assert/strict";

import { createAvatarLipsyncDriver, updateAvatarLipsyncDriver } from "./avatar-lipsync.js";

test("avatar lipsync opens mouth on active signal", () => {
  const driver = createAvatarLipsyncDriver();

  const state = updateAvatarLipsyncDriver(driver, {
    deltaSeconds: 0.1,
    level: 0.5,
    sourceState: "active"
  });

  assert.equal(state.mouthAmount > 0, true);
  assert.equal(state.speakingActive, true);
  assert.equal(state.sourceState, "active");
});

test("avatar lipsync ignores silence under threshold", () => {
  const driver = createAvatarLipsyncDriver();

  const state = updateAvatarLipsyncDriver(driver, {
    deltaSeconds: 0.1,
    level: 0.01,
    sourceState: "active"
  });

  assert.equal(state.mouthAmount, 0);
  assert.equal(state.speakingActive, false);
});

test("avatar lipsync returns to neutral when muted", () => {
  const driver = createAvatarLipsyncDriver();

  updateAvatarLipsyncDriver(driver, {
    deltaSeconds: 0.1,
    level: 0.7,
    sourceState: "active"
  });
  const muted = updateAvatarLipsyncDriver(driver, {
    deltaSeconds: 0.5,
    level: 0,
    sourceState: "muted"
  });

  assert.equal(muted.mouthAmount < 0.01, true);
  assert.equal(muted.speakingActive, false);
  assert.equal(muted.sourceState, "muted");
});
