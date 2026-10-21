import assert from "node:assert/strict";
import test from "node:test";
import { MediaSurfaceCommandClient } from "./media-surface-commands.js";
import type { RoomStateClient, SurfaceCommandResult } from "../room-state-client.js";

test("disconnected commands reject asynchronously so remaining cleanup can continue", async () => {
  const commands = new MediaSurfaceCommandClient({ participantId: "self", getClient: () => null, isConnected: () => false,
    createConnectionError: () => new Error("disconnected") });
  let promise!: Promise<SurfaceCommandResult>;
  assert.doesNotThrow(() => { promise = commands.stopObject("owned", "main"); });
  await assert.rejects(promise, /disconnected/);
  const cleanup: string[] = [];
  await commands.patchScreenShareObject("owned", "main", 0, { type: "mark-failed", errorCode: "unknown" }).catch(() => { cleanup.push("failed"); });
  await commands.stopScreenShareObject("owned", "main").catch(() => { cleanup.push("stop"); });
  assert.deepEqual(cleanup, ["failed", "stop"]);
});

test("the promise command owner preserves CAS and legacy Stop envelopes", async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window"); let timer = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout: () => ++timer, clearTimeout() {} } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); });
  const sent: Array<Record<string, unknown>> = [];
  const client = { socket: { OPEN: 1, readyState: 1, send: (text: string) => sent.push(JSON.parse(text)) } } as unknown as RoomStateClient;
  const commands = new MediaSurfaceCommandClient({ participantId: "self", getClient: () => client, isConnected: () => true, createConnectionError: () => new Error("unused") });
  for (const revision of [undefined, 0, 4]) {
    const pending = commands.stopObject("owned", "wall", "replacement", revision), wire = sent.at(-1)!;
    assert.equal(wire.type, "surface_stop_object"); assert.equal(wire.expectedRevision, revision);
    assert.equal(Object.hasOwn(wire, "expectedRevision"), revision !== undefined);
    commands.settle({ commandId: wire.commandId as string, accepted: true, permission: "surface.stop-object", role: "host" });
    assert.equal((await pending).accepted, true);
  }
});
