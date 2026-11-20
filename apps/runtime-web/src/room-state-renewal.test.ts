import assert from "node:assert/strict";
import test from "node:test";
import { createRoomStateRenewalCutover } from "./room-state-renewal.js";

function fixture() {
  const socket = {}, plan = {};
  const state = { connection: socket, authority: "presenter:7", transition: plan as object | null, now: 110 };
  const replacements: object[] = [];
  let timer: { run: () => void; delay: number } | undefined;
  const renewal = createRoomStateRenewalCutover({
    current: () => state, now: () => state.now, replace: connection => { replacements.push(connection); },
    schedule: (run, delay) => { timer = { run, delay }; return () => { timer = undefined; }; }
  });
  return { state, socket, renewal, replacements, timer: () => timer };
}

test("only an already running transition under verified unchanged authority defers rotation", () => {
  for (const reason of ["idle", "changed-authority", "no-deadline", "expired"] as const) {
    const f = fixture();
    if (reason === "idle") f.state.transition = null;
    f.renewal.request(f.socket, reason !== "changed-authority", reason === "no-deadline" ? null : reason === "expired" ? 110 : 190);
    assert.deepEqual(f.replacements, [f.socket], reason);
    assert.equal(f.timer(), undefined);
  }
});

test("a second renewal cannot extend the old socket deadline, even if its timer is delayed", () => {
  const f = fixture();
  f.renewal.request(f.socket, true, 190);
  const timer = f.timer();
  assert.equal(timer?.delay, 80);
  f.state.now = 150;
  f.renewal.request(f.socket, true, 900);
  assert.equal(f.timer(), timer);
  assert.equal(f.renewal.expired(), false);
  f.state.now = 190;
  assert.equal(f.renewal.expired(), true);
  timer!.run();
  f.renewal.sync();
  assert.deepEqual(f.replacements, [f.socket]);
});

test("changed authority or transition ends the hold; a closed or superseded socket is not reopened by its timer", () => {
  for (const change of ["revoke", "new-intent", "different-socket", "close"] as const) {
    const f = fixture();
    f.renewal.request(f.socket, true, 190);
    const staleTimer = f.timer()!;
    if (change === "revoke") f.state.authority = "member:8";
    else if (change === "new-intent") f.state.transition = {};
    else if (change === "different-socket") f.state.connection = {};
    else f.renewal.clear();
    f.renewal.sync();
    staleTimer.run();
    assert.deepEqual(f.replacements, change === "revoke" || change === "new-intent" ? [f.socket] : [], change);
    assert.equal(f.timer(), undefined);
  }
});
