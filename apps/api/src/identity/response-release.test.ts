import assert from "node:assert/strict";
import test from "node:test";
import { releaseFencedResponse } from "./response-release.js";
import { IdentityBoundaryError } from "./legacy-boundary.js";

test("a COMMIT failure after private bytes were released is not an authority denial", async () => {
  const events: string[] = [];
  const failure = new IdentityBoundaryError(503, "identity_authority_unavailable");
  await assert.rejects(releaseFencedResponse({
    run: async release => { release(); throw failure; },
    send: () => { events.push("sent"); },
    onReleased: () => { events.push("allowed"); },
    onDenied: () => { events.push("denied"); }
  }), error => error === failure);
  assert.deepEqual(events, ["sent", "allowed"]);
});

test("an authority failure before release is recorded as denied and sends no bytes", async () => {
  const events: string[] = [];
  const failure = new IdentityBoundaryError(409, "identity_upgrade_required");
  await assert.rejects(releaseFencedResponse({
    run: async () => { throw failure; }, send: () => { events.push("sent"); },
    onReleased: () => { events.push("allowed"); }, onDenied: () => { events.push("denied"); }
  }), error => error === failure);
  assert.deepEqual(events, ["denied"]);
});
