import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { Storage } from "./storage-contracts.js";
import { createMediaScreenService, readExecutorAuthority } from "./media-screen-service.js";
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
  assert.deepEqual(await service.status("room", 7), { enforcementVersion: 5, state: "unavailable", desiredVersion: { authorityRevision: 7, roomActive: null },
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
    assert.equal(current.state, "observed"); assert.equal(current.enforcementVersion, 5);
    assert.equal(JSON.stringify(current).includes("private-"), false, "cache tokens and participant sets are not status DTO fields");
    const mismatched = await service.status("room", 3);
    assert.equal(mismatched.state, "pending"); assert.equal(mismatched.observedAtMs, null);
  } finally { service.stop(); }
});

test("room-state's executor answer is trusted only as its own classified reply; anything else is unknown", async () => {
  const env = { ROOM_STATE_INTERNAL_URL: "http://room-state.test" }, headers = { "content-type": "application/json", "x-vrata-internal-token": "t" };
  const executor = { objectId: "object-1", instanceId: "remote-browser:object-1:instance:3" };
  const requests: Array<{ url: string; headers: unknown; body: unknown }> = [];
  const reply = (status: number, body: unknown) => (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), headers: init?.headers, body: JSON.parse(String(init?.body)) });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  assert.deepEqual(await readExecutorAuthority(env, headers, "room", executor, reply(200, { authorized: true, reason: "authorized" })),
    { reason: "authorized" });
  assert.deepEqual(requests[0], { url: "http://room-state.test/api/internal/remote-browser/bindings/verify", headers, body: {
    roomId: "room", objectId: "object-1", executorSessionId: "remote-browser:object-1", executorInstanceId: executor.instanceId, mediaParticipantId: executor.instanceId } });
  assert.deepEqual(await readExecutorAuthority(env, headers, "room", executor, reply(409, { authorized: false, reason: "room_missing" })),
    { reason: "room_missing" });
  for (const [status, body] of [[500, { reason: "stopped" }], [403, { error: "forbidden" }], [400, { reason: "mismatch" }],
    [409, { authorized: false }], [409, { reason: 7 }], [409, "not json"], [200, { reason: "stopped" }], [409, { reason: "authorized" }]] as const) {
    assert.equal(await readExecutorAuthority(env, headers, "room", executor, reply(status, body)), null, `${status} ${JSON.stringify(body)}`);
  }
  assert.equal(await readExecutorAuthority(env, headers, "room", executor, (async () => { throw new Error("private-network-failure"); }) as typeof fetch), null);
  assert.equal(await readExecutorAuthority({}, headers, "room", executor, reply(200, { reason: "authorized" })), null);
});
