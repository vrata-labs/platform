import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import type { RuntimeFrameContext } from "../input/runtime-frame-context.js";
import { createXrMenuState, stepXrMenu, withoutLocomotionInput, XR_LEAVE_CONFIRM_MS, xrMenuButtonLabel, type XrMenuStepInput } from "./xr-menu.js";
import { resolveXrMenuHit, resolveXrMenuPlacement } from "./xr-menu-view.js";

const idle: XrMenuStepInput = { presenting: true, menuPressed: false, confirm: false, hoveredAction: null, nowMs: 1000 };

function run(steps: Array<Partial<XrMenuStepInput>>) {
  let state = createXrMenuState();
  const commands: string[] = [];
  const opened: boolean[] = [];
  for (const step of steps) {
    const result = stepXrMenu(state, { ...idle, ...step });
    state = result.state;
    if (result.command) commands.push(result.command.type);
    opened.push(result.opened);
  }
  return { state, commands, opened };
}

test("B or Y opens and closes the menu on the press, not while held", () => {
  const held = run([{ menuPressed: true }, { menuPressed: true }, { menuPressed: true }]);
  assert.deepEqual([held.state.open, held.opened], [true, [true, false, false]]);
  assert.equal(run([{ menuPressed: true }, {}, { menuPressed: true }]).state.open, false);
  assert.deepEqual(run([{ menuPressed: true }, { presenting: false }]).state, createXrMenuState(), "leaving XR closes it");
  assert.equal(run([{ presenting: false, menuPressed: true }]).state.open, false, "outside XR there is no menu");
});

test("the trigger on a button acts; back to screen ends only XR, close only closes", () => {
  const open = [{ menuPressed: true }, {}];
  assert.deepEqual(run([...open, { confirm: true, hoveredAction: "to_screen" }]), { state: createXrMenuState(), commands: ["end_xr_session"], opened: [true, false, false] });
  const mic = run([...open, { confirm: true, hoveredAction: "microphone" }]);
  assert.deepEqual([mic.state.open, mic.commands], [true, ["toggle_microphone"]], "the menu stays open after the microphone");
  assert.deepEqual(run([...open, { confirm: true, hoveredAction: "close" }]).commands, []);
  assert.equal(run([...open, { confirm: true, hoveredAction: "close" }]).state.open, false);
  assert.deepEqual(run([...open, { confirm: true }]).commands, [], "a trigger past the buttons does nothing");
  assert.deepEqual(run([{ menuPressed: true, confirm: true, hoveredAction: "leave" }]).commands, [], "the opening frame takes no action");
});

test("leaving the space takes a second press within the confirmation time", () => {
  const open = [{ menuPressed: true }, {}];
  const armed = run([...open, { confirm: true, hoveredAction: "leave", nowMs: 2000 }]);
  assert.deepEqual([armed.commands, armed.state.leaveArmedUntilMs], [[], 2000 + XR_LEAVE_CONFIRM_MS]);
  assert.equal(xrMenuButtonLabel("leave", armed.state, { available: true, joined: false, microphoneEnabled: false }), "leave.confirm");
  assert.deepEqual(run([...open, { confirm: true, hoveredAction: "leave", nowMs: 2000 }, { confirm: true, hoveredAction: "leave", nowMs: 3000 }]).commands, ["leave_space"]);
  const late = run([...open, { confirm: true, hoveredAction: "leave", nowMs: 2000 }, { confirm: true, hoveredAction: "leave", nowMs: 2001 + XR_LEAVE_CONFIRM_MS }]);
  assert.deepEqual([late.commands, late.state.leaveArmedUntilMs !== null], [[], true], "a late second press arms again instead of leaving");
  const reopened = run([...open, { confirm: true, hoveredAction: "leave", nowMs: 2000 }, { menuPressed: true, nowMs: 2100 }, { nowMs: 2200 }, { menuPressed: true, nowMs: 2300 }]);
  assert.equal(reopened.state.leaveArmedUntilMs, null, "closing the menu disarms leaving");
});

test("labels follow the microphone state", () => {
  const state = createXrMenuState();
  assert.equal(xrMenuButtonLabel("microphone", state, { available: true, joined: false, microphoneEnabled: false }), "audio.unmute");
  assert.equal(xrMenuButtonLabel("microphone", state, { available: true, joined: true, microphoneEnabled: true }), "audio.mute");
  assert.equal(xrMenuButtonLabel("microphone", state, { available: false, joined: false, microphoneEnabled: false }), "audio.unsupported");
  assert.equal(xrMenuButtonLabel("to_screen", state, { available: true, joined: false, microphoneEnabled: false }), "leave.toScreen");
});

test("while the menu is open locomotion gets a resting sample with the real trigger state", () => {
  const frame: RuntimeFrameContext = {
    deltaSeconds: 0.016, nowMs: 1, source: "xr",
    intents: { move: { x: 0.5, z: -1 }, snapTurn: { axis: 1 }, aimRay: true, confirmInteraction: true, source: "xr" },
    xr: { referenceSpace: null, inputSources: [], profile: "p", sanitizedAxes: { moveX: 0.5, moveY: -1, turnX: 1, turnY: -1 }, rawAxes: { moveX: 0.5, moveY: -1, turnX: 1, turnY: -1 },
      triggerPressed: true, menuPressed: false, rayVisibleLatched: true }
  };
  const rest = withoutLocomotionInput(frame);
  assert.deepEqual(rest.intents, { move: { x: 0, z: 0 }, snapTurn: { axis: 0 }, aimRay: false, confirmInteraction: false, source: "xr" });
  assert.deepEqual([rest.xr?.sanitizedAxes, rest.xr?.triggerPressed, rest.xr?.rayVisibleLatched], [{ moveX: 0, moveY: 0, turnX: 0, turnY: 0 }, true, false]);
  assert.equal(frame.intents.confirmInteraction, true, "the sample itself is not changed");
});

test("the menu opens in front of the head, upright, and the ray finds a button without changing it", () => {
  const placement = resolveXrMenuPlacement(new THREE.Vector3(1, 1.6, 2), new THREE.Vector3(0, -0.5, -1));
  assert.ok(placement.position.distanceTo(new THREE.Vector3(1, 1.48, 1.35)) < 1e-6);
  assert.ok(Math.abs(placement.yaw) < 1e-9);
  const button = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.1));
  button.userData.xrMenuAction = "leave";
  button.position.set(0, 1.5, -0.7);
  button.updateMatrixWorld(true);
  const other = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.1));
  other.position.set(0, 1.5, -0.5);
  other.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster();
  const ray = new THREE.Ray(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(0, 0, -1));
  const hit = resolveXrMenuHit(ray, raycaster, [other, button]);
  assert.equal(hit?.action, "leave", "an object without a menu action is passed through");
  assert.ok(Math.abs((hit?.distance ?? 0) - 0.7) < 1e-6);
  assert.equal(resolveXrMenuHit(new THREE.Ray(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(0, 0, 1)), raycaster, [button]), null);
  assert.deepEqual(button.position.toArray(), [0, 1.5, -0.7]);
});
