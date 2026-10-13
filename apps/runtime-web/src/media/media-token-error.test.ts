import assert from "node:assert/strict";
import test from "node:test";
import { MediaTokenRequestError, planBaseMedia } from "./media-token-error.js";

test("base optional screen capability narrows once on its fixed permission refusal with the same proof", async () => {
  const calls: boolean[] = [];
  const value = await planBaseMedia({ optionalShare: true, proofStillCurrent: () => true, plan: async screen => {
    calls.push(screen); if (screen) throw new MediaTokenRequestError(403, "media_publish_not_allowed"); return "mic";
  } });
  assert.equal(value, "mic"); assert.deepEqual(calls, [true, false]);
});

test("base fallback never masks identity, lifecycle, config or unknown errors", async () => {
  for (const error of [new MediaTokenRequestError(401, "identity_session_expired"), new MediaTokenRequestError(403, "participant_removed"),
    new MediaTokenRequestError(403, "room_locked"), new MediaTokenRequestError(403, undefined), new MediaTokenRequestError(409, "identity_recovery_required"),
    new MediaTokenRequestError(503, "identity_authority_unavailable"), new Error("network")]) {
    let count = 0;
    await assert.rejects(planBaseMedia({ optionalShare: true, proofStillCurrent: () => true, plan: async () => { count++; throw error; } }), actual => actual === error);
    assert.equal(count, 1);
  }
});

test("changed or blocked proof, explicit microphone scope and a refused fallback do not make extra attempts", async () => {
  const error = new MediaTokenRequestError(403, "media_publish_not_allowed");
  for (const [optionalShare, current, expected] of [[false, true, 1], [true, false, 1], [true, true, 2]] as const) {
    let count = 0;
    await assert.rejects(planBaseMedia({ optionalShare, proofStillCurrent: () => current, plan: async () => { count++; throw error; } }), actual => actual === error);
    assert.equal(count, expected);
  }
});
