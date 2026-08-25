import assert from "node:assert/strict";
import test from "node:test";

import { cleanupMediaRoomConsumers, createDeferredMediaStopQueue, createMediaRoomIdleScheduler, hasMediaRoomSurfaceConsumer, planMediaRoomIdleAction, shouldHandleMediaRoomEvent, transitionPassiveMediaOwnership } from "./media-room-lifecycle.js";

function createFakeTimers() {
  let nowMs = 0;
  let nextId = 1;
  const timers = new Map<number, { deadlineMs: number; callback: () => void }>();
  return {
    get nowMs(): number {
      return nowMs;
    },
    setTimer(callback: () => void, delayMs: number): number {
      const id = nextId++;
      timers.set(id, { deadlineMs: nowMs + delayMs, callback });
      return id;
    },
    clearTimer(id: number): void {
      timers.delete(id);
    },
    advanceBy(deltaMs: number): void {
      const targetMs = nowMs + deltaMs;
      while (true) {
        const next = Array.from(timers.entries())
          .filter(([, timer]) => timer.deadlineMs <= targetMs)
          .sort((left, right) => left[1].deadlineMs - right[1].deadlineMs)[0];
        if (!next) {
          break;
        }
        nowMs = next[1].deadlineMs;
        timers.delete(next[0]);
        next[1].callback();
      }
      nowMs = targetMs;
    }
  };
}

test("pending media connection schedules disconnect when its physical consumer was removed", () => {
  assert.equal(planMediaRoomIdleAction({
    roomIsCurrent: true,
    audioSessionJoined: false,
    hasPhysicalConsumer: false,
    passiveMediaRequired: false
  }), "schedule-disconnect");
});

test("active physical media consumer keeps the room", () => {
  assert.equal(planMediaRoomIdleAction({
    roomIsCurrent: true,
    audioSessionJoined: false,
    hasPhysicalConsumer: true,
    passiveMediaRequired: false
  }), "keep-room");
});

test("each media consumer class independently owns the room", () => {
  const consumerStates = [
    { screenShare: true, remoteBrowser: false, surfaceAudio: false },
    { screenShare: false, remoteBrowser: true, surfaceAudio: false },
    { screenShare: false, remoteBrowser: false, surfaceAudio: true }
  ];
  for (const state of consumerStates) {
    assert.equal(hasMediaRoomSurfaceConsumer(state), true);
    assert.equal(planMediaRoomIdleAction({
      roomIsCurrent: true,
      audioSessionJoined: false,
      hasPhysicalConsumer: hasMediaRoomSurfaceConsumer(state),
      passiveMediaRequired: false
    }), "keep-room");
  }
});

test("removing the final media consumer allows idle disconnect", () => {
  const hasPhysicalConsumer = hasMediaRoomSurfaceConsumer({
    screenShare: false,
    remoteBrowser: false,
    surfaceAudio: false
  });
  assert.equal(hasPhysicalConsumer, false);
  assert.equal(planMediaRoomIdleAction({
    roomIsCurrent: true,
    audioSessionJoined: false,
    hasPhysicalConsumer,
    passiveMediaRequired: false
  }), "schedule-disconnect");
});

test("joined audio session keeps the room without a physical media consumer", () => {
  assert.equal(planMediaRoomIdleAction({
    roomIsCurrent: true,
    audioSessionJoined: true,
    hasPhysicalConsumer: false,
    passiveMediaRequired: false
  }), "keep-room");
});

test("later physical consumer prevents a scheduled idle callback from disconnecting", () => {
  assert.equal(planMediaRoomIdleAction({
    roomIsCurrent: true,
    audioSessionJoined: false,
    hasPhysicalConsumer: false,
    passiveMediaRequired: false
  }), "schedule-disconnect");
  assert.equal(planMediaRoomIdleAction({
    roomIsCurrent: true,
    audioSessionJoined: false,
    hasPhysicalConsumer: true,
    passiveMediaRequired: false
  }), "keep-room");
});

test("consumer removal preserves joined audio, passive ownership, and a replacement consumer", () => {
  const remainingOwners = [
    { audioSessionJoined: true, hasPhysicalConsumer: false, passiveMediaRequired: false },
    { audioSessionJoined: false, hasPhysicalConsumer: false, passiveMediaRequired: true },
    { audioSessionJoined: false, hasPhysicalConsumer: true, passiveMediaRequired: false }
  ];
  for (const remaining of remainingOwners) {
    assert.equal(planMediaRoomIdleAction({ roomIsCurrent: true, ...remaining }), "keep-room");
  }
});

test("idle callback ignores a room that is no longer current", () => {
  assert.equal(planMediaRoomIdleAction({
    roomIsCurrent: false,
    audioSessionJoined: false,
    hasPhysicalConsumer: false,
    passiveMediaRequired: false
  }), "ignore-stale-room");
});

test("passive media activation cancels pending idle ownership after fallback consumer removal", () => {
  let passiveMediaRequired = false;
  assert.equal(planMediaRoomIdleAction({
    roomIsCurrent: true,
    audioSessionJoined: false,
    hasPhysicalConsumer: false,
    passiveMediaRequired
  }), "schedule-disconnect");

  passiveMediaRequired = transitionPassiveMediaOwnership(passiveMediaRequired, "startup-requested");
  assert.equal(planMediaRoomIdleAction({
    roomIsCurrent: true,
    audioSessionJoined: false,
    hasPhysicalConsumer: false,
    passiveMediaRequired
  }), "keep-room");
});

test("passive media ownership keeps the room after startup succeeds", () => {
  let passiveMediaRequired = transitionPassiveMediaOwnership(false, "startup-requested");
  passiveMediaRequired = transitionPassiveMediaOwnership(passiveMediaRequired, "startup-succeeded");

  assert.equal(planMediaRoomIdleAction({
    roomIsCurrent: true,
    audioSessionJoined: false,
    hasPhysicalConsumer: false,
    passiveMediaRequired
  }), "keep-room");
});

test("passive startup failure clears ownership", () => {
  let passiveMediaRequired = transitionPassiveMediaOwnership(false, "startup-requested");
  passiveMediaRequired = transitionPassiveMediaOwnership(passiveMediaRequired, "startup-failed");

  assert.equal(passiveMediaRequired, false);
});

test("idle disconnect is allowed after passive failure leaves no owner or consumer", () => {
  let passiveMediaRequired = transitionPassiveMediaOwnership(false, "startup-requested");
  passiveMediaRequired = transitionPassiveMediaOwnership(passiveMediaRequired, "startup-failed");

  assert.equal(planMediaRoomIdleAction({
    roomIsCurrent: true,
    audioSessionJoined: false,
    hasPhysicalConsumer: false,
    passiveMediaRequired
  }), "schedule-disconnect");
});

test("80ms idle reconciles do not postpone the original disconnect deadline", () => {
  const timers = createFakeTimers();
  const room = { id: "room-1" };
  const ownership = { audioSessionJoined: false, hasPhysicalConsumer: false, passiveMediaRequired: false };
  const scheduler = createMediaRoomIdleScheduler({
    delayMs: 10000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  let disconnectCount = 0;
  const reconcile = () => {
    scheduler.reconcile(room, planMediaRoomIdleAction({ roomIsCurrent: true, ...ownership }), () => {
      if (planMediaRoomIdleAction({ roomIsCurrent: true, ...ownership }) === "schedule-disconnect") {
        disconnectCount += 1;
      }
    });
  };

  reconcile();
  for (let index = 0; index < 124; index += 1) {
    timers.advanceBy(80);
    reconcile();
  }
  assert.equal(timers.nowMs, 9920);
  assert.equal(disconnectCount, 0);
  timers.advanceBy(80);
  assert.equal(disconnectCount, 1);
});

test("active consumer, audio, or passive ownership cancels a pending idle deadline", () => {
  const ownershipCases = ["hasPhysicalConsumer", "audioSessionJoined", "passiveMediaRequired"] as const;
  for (const owner of ownershipCases) {
    const timers = createFakeTimers();
    const room = { id: owner };
    const ownership = { audioSessionJoined: false, hasPhysicalConsumer: false, passiveMediaRequired: false };
    const scheduler = createMediaRoomIdleScheduler({
      delayMs: 10000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer
    });
    let disconnectCount = 0;
    scheduler.reconcile(room, planMediaRoomIdleAction({ roomIsCurrent: true, ...ownership }), () => { disconnectCount += 1; });
    timers.advanceBy(5000);
    ownership[owner] = true;
    scheduler.reconcile(room, planMediaRoomIdleAction({ roomIsCurrent: true, ...ownership }), () => { disconnectCount += 1; });
    timers.advanceBy(10000);
    assert.equal(disconnectCount, 0, owner);
  }
});

test("idle deadline callback rechecks ownership before disconnecting", () => {
  const timers = createFakeTimers();
  const room = { id: "room-1" };
  const ownership = { audioSessionJoined: false, hasPhysicalConsumer: false, passiveMediaRequired: false };
  const scheduler = createMediaRoomIdleScheduler({
    delayMs: 10000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  let disconnectCount = 0;
  scheduler.reconcile(room, planMediaRoomIdleAction({ roomIsCurrent: true, ...ownership }), () => {
    if (planMediaRoomIdleAction({ roomIsCurrent: true, ...ownership }) === "schedule-disconnect") {
      disconnectCount += 1;
    }
  });

  timers.advanceBy(5000);
  ownership.hasPhysicalConsumer = true;
  timers.advanceBy(5000);
  assert.equal(disconnectCount, 0);
});

test("scheduling a different room replaces the pending room deadline", () => {
  const timers = createFakeTimers();
  const scheduler = createMediaRoomIdleScheduler({
    delayMs: 10000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  const disconnected: string[] = [];
  scheduler.reconcile({ id: "room-1" }, "schedule-disconnect", () => { disconnected.push("room-1"); });
  timers.advanceBy(1000);
  scheduler.reconcile({ id: "room-2" }, "schedule-disconnect", () => { disconnected.push("room-2"); });
  timers.advanceBy(9000);
  assert.deepEqual(disconnected, []);
  timers.advanceBy(1000);
  assert.deepEqual(disconnected, ["room-2"]);
});

test("terminal media-room cleanup detaches every transport-bound consumer", () => {
  const screenShares = new Map([
    ["share-1", { id: "share-1", transportBound: true }],
    ["mock-share", { id: "mock-share", transportBound: false }]
  ]);
  const remoteBrowserVideos = new Map([["browser-1", { id: "browser-1" }]]);
  const surfaceAudio = new Map([["surface-1", true]]);
  const remoteAudio = new Map([["participant-1", true]]);
  const cleaned: string[] = [];

  cleanupMediaRoomConsumers({
    screenShares: screenShares.values(),
    remoteBrowserVideos: remoteBrowserVideos.values(),
    surfaceAudioIds: surfaceAudio.keys(),
    remoteAudioParticipantIds: remoteAudio.keys(),
    detachScreenShare: (entry) => {
      cleaned.push(entry.id);
      screenShares.delete(entry.id);
    },
    detachRemoteBrowserVideo: (entry) => {
      cleaned.push(entry.id);
      remoteBrowserVideos.delete(entry.id);
    },
    disconnectSurfaceAudio: (surfaceId) => {
      cleaned.push(surfaceId);
      surfaceAudio.delete(surfaceId);
    },
    disconnectRemoteAudio: (participantId) => {
      cleaned.push(participantId);
      remoteAudio.delete(participantId);
    },
    shouldDetachScreenShare: (entry) => entry.transportBound
  });

  assert.deepEqual(cleaned, ["share-1", "browser-1", "surface-1", "participant-1"]);
  assert.deepEqual(Array.from(screenShares.keys()), ["mock-share"]);
  assert.equal(remoteBrowserVideos.size, 0);
  assert.equal(surfaceAudio.size, 0);
  assert.equal(remoteAudio.size, 0);
});

test("media-room events are accepted only from the current room generation", () => {
  const oldRoom = { id: "old" };
  const replacementRoom = { id: "replacement" };

  assert.equal(shouldHandleMediaRoomEvent(null, oldRoom), false);
  assert.equal(shouldHandleMediaRoomEvent(replacementRoom, oldRoom), false);
  assert.equal(shouldHandleMediaRoomEvent(replacementRoom, replacementRoom), true);
});

test("deferred media stop waits for room-state reconnect and deduplicates concurrent flushes", async () => {
  const queue = createDeferredMediaStopQueue();
  const sent: string[] = [];
  let releaseSend!: () => void;
  const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
  queue.enqueue("share-1", "surface-1");

  await queue.flush({
    canSend: false,
    isStillActive: () => true,
    send: async () => true
  });
  assert.equal(queue.size(), 1);

  const options = {
    canSend: true,
    isStillActive: () => true,
    send: async (objectId: string) => {
      sent.push(objectId);
      await sendGate;
      return true;
    }
  };
  const first = queue.flush(options);
  const concurrent = queue.flush(options);
  releaseSend();
  await Promise.all([first, concurrent]);

  assert.deepEqual(sent, ["share-1"]);
  assert.equal(queue.size(), 0);
});

test("deferred media stop drops an object that is no longer authoritative", async () => {
  const queue = createDeferredMediaStopQueue();
  queue.enqueue("share-1", "surface-1");

  await queue.flush({
    canSend: true,
    isStillActive: () => false,
    send: async () => {
      assert.fail("stale object must not send a stop command");
    }
  });

  assert.equal(queue.size(), 0);
});

test("deferred media stop retains a failed send for a later reconnect", async () => {
  const queue = createDeferredMediaStopQueue();
  queue.enqueue("share-1", "surface-1");

  await queue.flush({
    canSend: true,
    isStillActive: () => true,
    send: async () => false
  });
  assert.equal(queue.size(), 1);

  await queue.flush({
    canSend: true,
    isStillActive: () => true,
    send: async () => true
  });
  assert.equal(queue.size(), 0);
});
