import assert from "node:assert/strict";
import { test } from "node:test";
import { createHeldPropContact, createHeldPropState, type PropGrip } from "./held-prop-state.js";

const at = (x: number) => ({ x, y: 0, z: 0 });
const grip = (x: number, pressed = true): PropGrip => ({ position: at(x), pressed });

test("only a fresh grip in reach holds the handle, until release, tracking loss or tether limit", () => {
  const hold = createHeldPropState(.35, 2);
  const step = (left: PropGrip | null, right: PropGrip | null, enabled = true) =>
    hold.update({ enabled, grips: { left, right }, restHandle: at(.75), tetherAnchor: at(0) });
  assert.equal(step(null, grip(1.2)), null, "outside pickup reach");
  assert.equal(step(null, grip(.8)), null, "moving a closed grip over the handle is not a grab");
  assert.equal(step(null, grip(.8, false)), null);
  assert.equal(step(grip(.6), grip(.8)), "right", "choose the closest fresh grip");
  assert.equal(step(grip(.6), grip(1.8)), "right");
  assert.equal(step(grip(.6), grip(2.1)), null, "do not drag the hookah past the tether");
  assert.equal(step(null, grip(.8)), null);
  assert.equal(step(null, { pressed: true, position: null }), null);
  assert.equal(step(null, grip(.8)), null, "regaining tracking does not replay the grip");
  assert.equal(step(null, null), null);
  assert.equal(step(grip(.7), null), "left");
  assert.equal(step(null, null), null);
  assert.equal(step(null, grip(.7), false), null);
  assert.equal(step(null, grip(.7)), null, "closing the VR menu must not replay its grip");
});

test("contact waits for a held tip and repeats only at the authored interval", () => {
  const contact = createHeldPropContact(.14, 6500);
  assert.deepEqual(contact.update(10, null, at(0)), { touching: false, pulse: false, stop: false });
  assert.deepEqual(contact.update(100, at(.28), at(0)), { touching: false, pulse: false, stop: false });
  assert.deepEqual(contact.update(200, at(.1), at(0)), { touching: true, pulse: true, stop: false });
  assert.deepEqual(contact.update(6699, at(.15), at(0)), { touching: true, pulse: false, stop: false });
  assert.deepEqual(contact.update(6700, at(.1), at(0)), { touching: true, pulse: true, stop: false });
  assert.deepEqual(contact.update(6710, at(.18), at(0)), { touching: false, pulse: false, stop: true });
  assert.deepEqual(contact.update(6800, at(.1), at(0)), { touching: true, pulse: false, stop: false });
  assert.deepEqual(contact.update(6810, null, at(0)), { touching: false, pulse: false, stop: true });
});
