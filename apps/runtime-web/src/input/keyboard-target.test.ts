import assert from "node:assert/strict";
import test from "node:test";
import { clearRuntimeKeyboardState, collectRuntimeKeyboardSample, isRuntimeUiKeyboardTarget } from "./keyboard-target.js";
import { resolveDesktopTouchInputIntents } from "./input-intents.js";

const target = (ui: boolean) => ({ closest: () => ui ? {} : null }) as unknown as EventTarget;
const buttonTarget = { closest: (selector: string) => selector.includes(".hud") ? {} : null } as unknown as EventTarget;
const intent = (keys: Record<string, boolean>) => resolveDesktopTouchInputIntents({ keys, touchActive: false, touchVector: { x: 0, z: 0 } });

test("scene keyboard samples retain standing movement and key-release semantics", () => {
  const keys: Record<string, boolean> = {};
  assert.equal(collectRuntimeKeyboardSample(keys, { code: "KeyW", target: target(false) }, true), true);
  assert.notEqual(intent(keys).move.z, 0);
  assert.equal(collectRuntimeKeyboardSample(keys, { code: "KeyW", target: target(false) }, false), true);
  assert.deepEqual(intent(keys).move, { x: 0, z: 0 });
});

test("typing or keyboard navigation in the HUD cannot move the player or forward media-surface input", () => {
  const keys: Record<string, boolean> = { KeyW: true, ShiftLeft: true };
  assert.equal(collectRuntimeKeyboardSample(keys, { code: "KeyD", target: target(true) }, true), false);
  assert.deepEqual(intent(keys).move, { x: 0, z: 0 }); assert.equal(keys.ShiftLeft, false);
  assert.equal(collectRuntimeKeyboardSample(keys, { code: "Enter", target: target(true) }, false), false);
  assert.deepEqual(intent(keys).move, { x: 0, z: 0 });
});

test("focus transfer releases held keys and missing/non-element targets stay safe", () => {
  assert.equal(isRuntimeUiKeyboardTarget(null), false);
  assert.equal(isRuntimeUiKeyboardTarget({} as EventTarget), false);
  assert.equal(isRuntimeUiKeyboardTarget(target(true)), true);
  const keys = { KeyA: true, ArrowLeft: true }; clearRuntimeKeyboardState(keys);
  assert.deepEqual(keys, { KeyA: false, ArrowLeft: false });
  assert.equal(collectRuntimeKeyboardSample(keys, { code: "", target: null }, false), true);
  assert.equal(Object.hasOwn(keys, ""), false);
});

test("HUD buttons preserve legacy WASD/Shift movement without forwarding UI activation or scrolling to a surface", () => {
  const keys: Record<string, boolean> = {};
  assert.equal(collectRuntimeKeyboardSample(keys, { code: "KeyW", target: buttonTarget }, true), false);
  assert.notEqual(intent(keys).move.z, 0);
  collectRuntimeKeyboardSample(keys, { code: "ShiftLeft", target: buttonTarget }, true); assert.equal(keys.ShiftLeft, true);
  collectRuntimeKeyboardSample(keys, { code: "KeyW", target: buttonTarget }, false); assert.deepEqual(intent(keys).move, { x: 0, z: 0 });
  for (const code of ["Enter", "Space", "Tab", "Escape", "ArrowUp", "ArrowLeft", "ArrowRight", "ArrowDown"]) {
    assert.equal(collectRuntimeKeyboardSample(keys, { code, target: buttonTarget }, true), false); assert.equal(keys[code], false);
  }
});
