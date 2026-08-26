import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  REMOTE_BROWSER_VR_KEYBOARD_LAYOUTS,
  mountRemoteBrowserVrKeyboard,
  planRemoteBrowserVrKeyboardInput,
  type RemoteBrowserVrKeyboardHit,
  type RemoteBrowserVrKeyboardKey,
  type RemoteBrowserVrKeyboardLayoutId
} from "./remote-browser-vr-keyboard.js";

function keyById(layoutId: RemoteBrowserVrKeyboardLayoutId, id: string): RemoteBrowserVrKeyboardKey {
  const key = REMOTE_BROWSER_VR_KEYBOARD_LAYOUTS[layoutId].rows.flat().find((candidate) => candidate.id === id);
  assert.ok(key, `missing key ${id}`);
  return key;
}

function keyHit(key: RemoteBrowserVrKeyboardKey): RemoteBrowserVrKeyboardHit {
  return {
    kind: "key",
    key,
    point: new THREE.Vector3(),
    distanceM: 1
  };
}

const toggleHit: RemoteBrowserVrKeyboardHit = {
  kind: "toggle",
  point: new THREE.Vector3(),
  distanceM: 1
};

test("remote browser VR keyboard emits English text key input on confirm", () => {
  assert.deepEqual(planRemoteBrowserVrKeyboardInput({
    keyboardActive: true,
    confirmInteraction: true,
    hit: keyHit(keyById("en-US", "key-h"))
  }), {
    keyId: "key-h",
    key: "h",
    text: "h"
  });
});

test("remote browser VR keyboard emits Russian text independent from system layout", () => {
  assert.deepEqual(planRemoteBrowserVrKeyboardInput({
    keyboardActive: true,
    confirmInteraction: true,
    hit: keyHit(keyById("ru-RU", "key-ru-ef"))
  }), {
    keyId: "key-ru-ef",
    key: "ф",
    text: "ф"
  });
});

test("remote browser VR keyboard emits browser control keys", () => {
  assert.deepEqual(planRemoteBrowserVrKeyboardInput({
    keyboardActive: true,
    confirmInteraction: true,
    hit: keyHit(keyById("en-US", "key-backspace"))
  }), {
    keyId: "key-backspace",
    key: "Backspace"
  });

  assert.deepEqual(planRemoteBrowserVrKeyboardInput({
    keyboardActive: true,
    confirmInteraction: true,
    hit: keyHit(keyById("en-US", "key-enter"))
  }), {
    keyId: "key-enter",
    key: "Enter"
  });
});

test("remote browser VR keyboard supports URL shortcuts and layout switching", () => {
  assert.deepEqual(planRemoteBrowserVrKeyboardInput({
    keyboardActive: true,
    confirmInteraction: true,
    hit: keyHit(keyById("en-US", "key-dotcom"))
  }), {
    keyId: "key-dotcom",
    text: ".com"
  });

  assert.deepEqual(planRemoteBrowserVrKeyboardInput({
    keyboardActive: true,
    confirmInteraction: true,
    hit: keyHit(keyById("en-US", "key-layout-next"))
  }), {
    keyId: "key-layout-next",
    layoutNext: true
  });
});

test("remote browser VR keyboard toggle is a separate command target", () => {
  assert.deepEqual(planRemoteBrowserVrKeyboardInput({
    keyboardActive: true,
    confirmInteraction: true,
    hit: toggleHit
  }), {
    keyId: null,
    toggleKeyboard: true
  });
});

test("remote browser VR keyboard stays idle without active confirm target", () => {
  assert.deepEqual(planRemoteBrowserVrKeyboardInput({
    keyboardActive: false,
    confirmInteraction: true,
    hit: keyHit(keyById("en-US", "key-h"))
  }), { keyId: null });

  assert.deepEqual(planRemoteBrowserVrKeyboardInput({
    keyboardActive: true,
    confirmInteraction: false,
    hit: keyHit(keyById("en-US", "key-h"))
  }), { keyId: null });

  assert.deepEqual(planRemoteBrowserVrKeyboardInput({
    keyboardActive: true,
    confirmInteraction: true,
    hit: null
  }), { keyId: null });
});

test("remote browser VR keyboard follows the active physical surface", () => {
  const firstSurface = new THREE.Group();
  const secondSurface = new THREE.Group();
  const root = new THREE.Group();
  const view = { root } as Parameters<typeof mountRemoteBrowserVrKeyboard>[0];

  mountRemoteBrowserVrKeyboard(view, firstSurface);
  assert.equal(root.parent, firstSurface);
  mountRemoteBrowserVrKeyboard(view, secondSurface);
  assert.equal(root.parent, secondSurface);
  assert.equal(firstSurface.children.includes(root), false);
});
