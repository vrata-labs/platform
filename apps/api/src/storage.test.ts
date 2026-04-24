import test from "node:test";
import assert from "node:assert/strict";

import { MemoryStorage } from "./storage.js";

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
