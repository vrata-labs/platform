import assert from "node:assert/strict";
import test from "node:test";

import {
  REMOTE_BROWSER_VR_KEYBOARD_ROWS,
  planRemoteBrowserVrKeyboardInput,
  type RemoteBrowserVrKeyboardKey
} from "./remote-browser-vr-keyboard.js";

function keyById(id: string): RemoteBrowserVrKeyboardKey {
  const key = REMOTE_BROWSER_VR_KEYBOARD_ROWS.flat().find((candidate) => candidate.id === id);
  assert.ok(key, `missing key ${id}`);
  return key;
}

test("remote browser VR keyboard emits text key input on confirm", () => {
  assert.deepEqual(planRemoteBrowserVrKeyboardInput({
    keyboardActive: true,
    confirmInteraction: true,
    hoveredKey: keyById("key-h")
  }), {
    keyId: "key-h",
    key: "h",
    text: "h"
  });
});

test("remote browser VR keyboard emits browser control keys", () => {
  assert.deepEqual(planRemoteBrowserVrKeyboardInput({
    keyboardActive: true,
    confirmInteraction: true,
    hoveredKey: keyById("key-backspace")
  }), {
    keyId: "key-backspace",
    key: "Backspace"
  });

  assert.deepEqual(planRemoteBrowserVrKeyboardInput({
    keyboardActive: true,
    confirmInteraction: true,
    hoveredKey: keyById("key-enter")
  }), {
    keyId: "key-enter",
    key: "Enter"
  });
});

test("remote browser VR keyboard supports common URL text shortcuts", () => {
  assert.deepEqual(planRemoteBrowserVrKeyboardInput({
    keyboardActive: true,
    confirmInteraction: true,
    hoveredKey: keyById("key-dotcom")
  }), {
    keyId: "key-dotcom",
    text: ".com"
  });
});

test("remote browser VR keyboard stays idle without active confirm target", () => {
  assert.deepEqual(planRemoteBrowserVrKeyboardInput({
    keyboardActive: false,
    confirmInteraction: true,
    hoveredKey: keyById("key-h")
  }), { keyId: null });

  assert.deepEqual(planRemoteBrowserVrKeyboardInput({
    keyboardActive: true,
    confirmInteraction: false,
    hoveredKey: keyById("key-h")
  }), { keyId: null });

  assert.deepEqual(planRemoteBrowserVrKeyboardInput({
    keyboardActive: true,
    confirmInteraction: true,
    hoveredKey: null
  }), { keyId: null });
});
