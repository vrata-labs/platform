import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { Storage } from "./storage-contracts.js";
import { createMediaScreenService } from "./media-screen-service.js";
import { RoomServiceClient, Room } from "livekit-server-sdk";

test("a process without an SFU URL never polls storage or consumes a media-namespace read", async () => {
  let reads = 0;
  const storage = new Proxy({}, { get(_target, key) {
    if (key === "then") return undefined;
    reads++; throw new Error("unexpected_background_read");
  } }) as Storage;
  for (const env of [{ NODE_ENV: "test" }, { NODE_ENV: "test", LIVEKIT_URL: "invalid" },
    { NODE_ENV: "test", LIVEKIT_URL: "https://media.example.test" },
    { NODE_ENV: "test", LIVEKIT_URL: "wss://media.example.test", LIVEKIT_API_KEY: "" }]) {
    const service = createMediaScreenService(Promise.resolve(storage), { env });
    service.start(); await setImmediate(); service.stop();
  }
  assert.equal(reads, 0);
});

test("a failed reconciliation status read cannot turn authenticated session control into an error or invent room activity", async () => {
  const storage = { async getRoom() { throw new Error("private-storage-message"); } } as unknown as Storage;
  const service = createMediaScreenService(Promise.resolve(storage), { env: { NODE_ENV: "test" } });
  assert.deepEqual(await service.status("room", 7), { enforcementVersion: 4, state: "unavailable", desiredVersion: { authorityRevision: 7, roomActive: null },
    observedAtMs: null, nativeRoom: "unknown" });
});

test("an observation cannot acknowledge a different outer session-control revision", { timeout: 10_000 }, async t => {
  const namespace = "a".repeat(32);
  t.mock.method(RoomServiceClient.prototype, "listRooms", async () => [new Room({ name: `vrata-v2:${namespace}:room` })]);
  t.mock.method(RoomServiceClient.prototype, "listParticipants", async () => []);
  const storage = {
    async getRoom() { return { tenantId: "tenant", roomId: "room" }; },
    identityProtocol: { async minimum() { return 2; }, async mediaBoundary() { return { namespace, codec: 2 }; } },
    roomIdentities: { async screenSourceAuthority() { return { revision: 4, roomActive: true, publisherParticipantIds: [],
      removedParticipantIds: ["private-removed-participant"], observationVersion: "private-observation-token" }; } }
  } as unknown as Storage;
  let observed!: () => void;
  const ready = new Promise<void>(done => { observed = done; });
  const service = createMediaScreenService(Promise.resolve(storage), { env: { NODE_ENV: "test", LIVEKIT_URL: "ws://127.0.0.1:1" },
    event: event => { if (event === "observed") observed(); } });
  try {
    service.start(); await ready;
    const current = await service.status("room", 4);
    assert.equal(current.state, "observed"); assert.equal(current.enforcementVersion, 4);
    assert.equal(JSON.stringify(current).includes("private-"), false, "cache tokens and participant sets are not status DTO fields");
    const mismatched = await service.status("room", 3);
    assert.equal(mismatched.state, "pending"); assert.equal(mismatched.observedAtMs, null);
  } finally { service.stop(); }
});
