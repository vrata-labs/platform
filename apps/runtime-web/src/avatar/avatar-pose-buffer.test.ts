import test from "node:test";
import assert from "node:assert/strict";

import { createAvatarPoseBuffer, pushAvatarPoseFrame, sampleAvatarPoseBuffer } from "./avatar-pose-buffer.js";

function createFrame(seq: number, sentAtMs: number) {
  return {
    seq,
    sentAtMs,
    flags: 0,
    root: { x: seq, y: 0, z: seq, yaw: 0, vx: 0, vz: 0 },
    head: { x: seq, y: 1.6, z: seq, qx: 0, qy: 0, qz: 0, qw: 1 },
    leftHand: { x: seq, y: 1.2, z: seq, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
    rightHand: { x: seq, y: 1.2, z: seq, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 1 },
    locomotion: { mode: 1, speed: 1, angularVelocity: 0 }
  };
}

test("pushAvatarPoseFrame rejects stale and reordered frames", () => {
  const buffer = createAvatarPoseBuffer();
  assert.equal(pushAvatarPoseFrame(buffer, createFrame(2, 200), 200).accepted, true);
  assert.equal(pushAvatarPoseFrame(buffer, createFrame(1, 100), 200).reason, "reorder");
  assert.equal(pushAvatarPoseFrame(buffer, createFrame(2, 200), 200).reason, "stale");
  assert.equal(buffer.droppedReorderCount, 1);
  assert.equal(buffer.droppedStaleCount, 1);
});

test("sampleAvatarPoseBuffer returns surrounding frames for interpolation", () => {
  const buffer = createAvatarPoseBuffer();
  pushAvatarPoseFrame(buffer, createFrame(1, 100), 100);
  pushAvatarPoseFrame(buffer, createFrame(2, 200), 200);
  pushAvatarPoseFrame(buffer, createFrame(3, 300), 300);

  const sample = sampleAvatarPoseBuffer(buffer, 250);
  assert.equal(sample.previous?.seq, 2);
  assert.equal(sample.next?.seq, 3);
  assert.equal(sample.latest?.seq, 3);
});

test("pushAvatarPoseFrame derives adaptive playback delay from observed jitter", () => {
  const buffer = createAvatarPoseBuffer();
  pushAvatarPoseFrame(buffer, createFrame(1, 100), 100);
  pushAvatarPoseFrame(buffer, createFrame(2, 140), 150);
  pushAvatarPoseFrame(buffer, createFrame(3, 180), 230);

  assert.equal(buffer.recommendedPlaybackDelayMs >= 100, true);
  assert.equal(buffer.recommendedPlaybackDelayMs <= 140, true);
  assert.equal(buffer.recommendedPlaybackDelayMs > 100, true);
});

test("sampleAvatarPoseBuffer follows local receive timeline even when sender clock is offset", () => {
  const buffer = createAvatarPoseBuffer();
  pushAvatarPoseFrame(buffer, createFrame(1, 10_000), 100);
  pushAvatarPoseFrame(buffer, createFrame(2, 10_100), 200);
  pushAvatarPoseFrame(buffer, createFrame(3, 10_200), 300);

  const sample = sampleAvatarPoseBuffer(buffer, 250);
  assert.equal(sample.previous?.seq, 2);
  assert.equal(sample.next?.seq, 3);
  assert.equal(sample.latest?.sentAtMs, 300);
});

test("a late anchor after a receiver stall does not delay playback of later frames", () => {
  const buffer = createAvatarPoseBuffer();
  pushAvatarPoseFrame(buffer, createFrame(1, 100), 105);
  pushAvatarPoseFrame(buffer, createFrame(2, 200), 205);
  // The receiver thread was blocked for ~2 s: every buffered frame expired by TTL and
  // the next frame (sent at 300) is handled 2 s late, becoming the new anchor.
  pushAvatarPoseFrame(buffer, createFrame(3, 300), 2_305);
  assert.deepEqual(buffer.frames.map((frame) => frame.seq), [3]);
  // Following frames arrive on time again; each must play within the playback delay.
  pushAvatarPoseFrame(buffer, createFrame(4, 2_400), 2_405);
  pushAvatarPoseFrame(buffer, createFrame(5, 2_500), 2_505);
  for (const frame of buffer.frames) {
    assert.ok(frame.sentAtMs <= 2_505, `frame ${frame.seq} scheduled ahead of arrival`);
  }
  assert.equal(sampleAvatarPoseBuffer(buffer, 2_505).previous?.seq, 5);
  assert.equal(sampleAvatarPoseBuffer(buffer, 2_405 + 50).previous?.seq, 4);
});

test("timeline correction keeps sender spacing and only moves playback forward", () => {
  const buffer = createAvatarPoseBuffer();
  pushAvatarPoseFrame(buffer, createFrame(1, 1_000), 500);
  pushAvatarPoseFrame(buffer, createFrame(2, 1_100), 640);
  pushAvatarPoseFrame(buffer, createFrame(3, 1_200), 700);
  const before = sampleAvatarPoseBuffer(buffer, 650).previous?.seq ?? 0;
  // Frame 4 arrives earlier than the timeline predicts (the anchor itself was late).
  pushAvatarPoseFrame(buffer, createFrame(4, 1_300), 760);
  const times = buffer.frames.map((frame) => frame.sentAtMs);
  assert.deepEqual(times.slice(1).map((time, index) => time - times[index]!), [100, 100, 100]);
  assert.equal(times[times.length - 1], 760);
  assert.ok((sampleAvatarPoseBuffer(buffer, 650).previous?.seq ?? 0) >= before);
});

test("on-time and late frames keep the receive-anchored timeline unchanged", () => {
  const buffer = createAvatarPoseBuffer();
  pushAvatarPoseFrame(buffer, createFrame(1, 5_000), 100);
  pushAvatarPoseFrame(buffer, createFrame(2, 5_100), 260);
  pushAvatarPoseFrame(buffer, createFrame(3, 5_200), 300);
  assert.deepEqual(buffer.frames.map((frame) => frame.sentAtMs), [100, 200, 300]);
});
