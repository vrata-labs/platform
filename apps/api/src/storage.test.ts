import test from "node:test";
import assert from "node:assert/strict";

import { MemoryStorage, initPostgresStorageWithRetry } from "./storage.js";

test("MemoryStorage keeps xr telemetry events in insertion order", async () => {
  const storage = new MemoryStorage();

  await storage.addXrTelemetry("room-a", "p-1", {
    updatedAt: "2026-04-24T18:00:00.000Z",
    kind: "ray_on"
  });
  await storage.addXrTelemetry("room-a", "p-1", {
    updatedAt: "2026-04-24T18:00:01.000Z",
    kind: "trigger_press"
  });

  const events = await storage.getXrTelemetry("room-a");
  assert.equal(events.length, 2);
  assert.equal(events[0]?.participantId, "p-1");
  assert.equal(events[0]?.payload.kind, "ray_on");
  assert.equal(events[1]?.payload.kind, "trigger_press");
});

test("MemoryStorage xr telemetry snapshots are cloned on read", async () => {
  const storage = new MemoryStorage();

  await storage.addXrTelemetry("room-a", "p-1", {
    updatedAt: "2026-04-24T18:00:00.000Z",
    xrAxes: { turnX: -0.16 }
  });

  const firstRead = await storage.getXrTelemetry("room-a");
  (firstRead[0]?.payload.xrAxes as { turnX?: number }).turnX = 999;

  const secondRead = await storage.getXrTelemetry("room-a");
  assert.equal((secondRead[0]?.payload.xrAxes as { turnX?: number }).turnX, -0.16);
});

test("MemoryStorage enables screen share for new rooms by default", async () => {
  const storage = new MemoryStorage();

  const defaultRoom = await storage.createRoom({ name: "Default Feature Room" });
  const disabledRoom = await storage.createRoom({
    name: "Share Disabled Room",
    features: { voice: true, spatialAudio: true, screenShare: false }
  });

  assert.equal(defaultRoom.features.screenShare, true);
  assert.equal(disabledRoom.features.screenShare, false);
});

test("Postgres storage init retries transient connection failures", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const retryAttempts: number[] = [];

  await initPostgresStorageWithRetry({
    async init() {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("connect ECONNREFUSED 127.0.0.1:5432") as Error & { code: string };
        error.code = "ECONNREFUSED";
        throw error;
      }
    }
  }, {
    maxAttempts: 3,
    retryDelayMs: 25,
    onRetry: (_error, attempt) => retryAttempts.push(attempt),
    wait: async (ms) => {
      waits.push(ms);
    }
  });

  assert.equal(attempts, 3);
  assert.deepEqual(retryAttempts, [1, 2]);
  assert.deepEqual(waits, [25, 25]);
});

test("Postgres storage init fails fast on non-connection errors", async () => {
  let attempts = 0;
  const syntaxError = new Error("syntax error at or near create") as Error & { code: string };
  syntaxError.code = "42601";

  let rejected: unknown;
  try {
    await initPostgresStorageWithRetry({
      async init() {
        attempts += 1;
        throw syntaxError;
      }
    }, {
      maxAttempts: 5,
      retryDelayMs: 25,
      wait: async () => undefined
    });
  } catch (error) {
    rejected = error;
  }

  assert.equal(attempts, 1);
  assert.equal(rejected, syntaxError);
});
