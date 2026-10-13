import assert from "node:assert/strict";
import test from "node:test";
import { createMediaActionBarrier } from "./media-action-barrier.js";

test("retirement waits for the old room's in-flight microphone action, including a failed action", async () => {
  for (const fail of [false, true]) {
    const barrier = createMediaActionBarrier(); let finish!: () => void, retired = false;
    const gate = new Promise<void>(done => { finish = done; });
    const action = barrier.run(async () => { await gate; if (fail) throw new Error("mic_failed"); });
    const result = action.then(() => "ok", () => "failed");
    const retiring = barrier.settled().then(() => { retired = true; });
    await Promise.resolve(); assert.equal(retired, false);
    await assert.rejects(barrier.run(async () => {}), /media_audio_action_overlaps/);
    finish(); await retiring; assert.equal(await result, fail ? "failed" : "ok");
    assert.equal(retired, true);
    await barrier.run(async () => {});
  }
});
