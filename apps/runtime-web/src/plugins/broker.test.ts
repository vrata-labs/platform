import test from "node:test";
import assert from "node:assert/strict";
import { createRoomPluginBroker } from "./broker.js";
import { RoomPluginBindingLease } from "./lease.js";
import { parseRoomPluginRuntimeSnapshot, roomPluginContentPath, type RoomPluginRuntimeBinding } from "./runtime-dto.js";

const makeBinding = (): RoomPluginRuntimeBinding => parseRoomPluginRuntimeSnapshot(JSON.stringify({ schemaVersion: 1, sdkApiVersion: 1, revision: 1, leaseExpiresAtMs: 1,
  bindings: [{ bindingId: "11111111-1111-4111-8111-111111111111", packageId: "22222222-2222-4222-8222-222222222222", pluginId: "external.status", version: "1.0.0",
    artifactSha256: "a".repeat(64), enabled: true, generation: 1, bindingRevision: 1, config: {}, approvedCapabilities: ["status.set", "seating.claimSelfOnEntry"],
    contentUrl: roomPluginContentPath("room", "22222222-2222-4222-8222-222222222222") }] }), "room").bindings[0];
const request = (id = "1", text = "<b>literal</b>") => ({ sdkApiVersion: 1, requestId: id, operation: "status.set", payload: { text } } as const);
function fixture() {
  let now = 0, available = true, tokenDeadline = 900_000;
  const binding = makeBinding(); let current: RoomPluginRuntimeBinding | null = binding;
  const lease = new RoomPluginBindingLease(() => now), effects: string[] = [], abort = new AbortController();
  const proof = () => now < tokenDeadline ? { token: "native-private-proof", deadlineMs: tokenDeadline } : null;
  assert.ok(lease.accept(lease.beginRequest(proof()!)!, { schemaVersion: 1, sdkApiVersion: 1, revision: 1, leaseExpiresAtMs: 1, bindings: [binding] }));
  const broker = createRoomPluginBroker({ binding, currentBinding: () => current, available: () => available, proof, lease, clock: () => now, status: text => effects.push(text) });
  return { broker, lease, effects, abort, binding, setTime(value: number) { now = value; }, setCurrent(value: RoomPluginRuntimeBinding | null) { current = value; },
    offline() { available = false; }, expireToken() { tokenDeadline = now; } };
}
test("status commit is synchronous, plain data and native-authorized before the SDK receipt", () => {
  const h = fixture(); const response = h.broker(request(), h.abort.signal);
  assert.deepEqual(h.effects, ["<b>literal</b>"]); assert.deepEqual(response, { sdkApiVersion: 1, requestId: "1", ok: true, result: null });
  assert.equal(JSON.stringify(response).includes("native-private-proof"), false);
});
test("revoked, stale, offline, cancelled and expired contexts cannot emit another status", () => {
  for (const change of [(h: ReturnType<typeof fixture>) => h.lease.invalidate(), (h: ReturnType<typeof fixture>) => h.setCurrent(null),
    (h: ReturnType<typeof fixture>) => h.offline(), (h: ReturnType<typeof fixture>) => h.abort.abort(),
    (h: ReturnType<typeof fixture>) => h.expireToken(), (h: ReturnType<typeof fixture>) => h.setTime(5000)]) {
    const h = fixture(); change(h); assert.equal(h.broker(request(), h.abort.signal).ok, false); assert.deepEqual(h.effects, []);
  }
});
test("caps/config cannot be borrowed from a different native binding or changed tuple content", () => {
  for (const patch of [{ generation: 2 }, { artifactSha256: "b".repeat(64) }, { config: { changed: true } }, { approvedCapabilities: [] }]) {
    const h = fixture(); h.setCurrent({ ...h.binding, ...patch });
    assert.equal(h.broker(request(), h.abort.signal).ok, false); assert.deepEqual(h.effects, []);
  }
});
test("broker retains its own native rate fence and never pretends seating is integrated", () => {
  const h = fixture();
  assert.equal(h.broker(request("1"), h.abort.signal).ok, true); assert.equal(h.broker(request("2"), h.abort.signal).ok, true);
  assert.deepEqual(h.broker(request("3"), h.abort.signal), { sdkApiVersion: 1, requestId: "3", ok: false, error: "quota-exceeded" });
  h.setTime(1000); assert.equal(h.broker(request("4"), h.abort.signal).ok, true);
  assert.deepEqual(h.broker({ sdkApiVersion: 1, requestId: "5", operation: "seating.claimSelfOnEntry", payload: { seatId: "real-seat" } }, h.abort.signal),
    { sdkApiVersion: 1, requestId: "5", ok: false, error: "capability-denied" });
  assert.equal(h.effects.length, 3);
});
test("malformed DTOs and host exceptions cannot be echoed as plugin-provided authority", () => {
  const h = fixture();
  assert.throws(() => h.broker({ ...request(), participantId: "someone-else" } as never, h.abort.signal), { code: "host-unavailable" });
  assert.deepEqual(h.effects, []);
});
test("a reappearing tuple cannot authorize an old instance with a different config", () => {
  const h = fixture(); h.lease.resetSession();
  const changed = { ...h.binding, config: { changed: true } }; h.setCurrent(changed);
  assert.ok(h.lease.accept(h.lease.beginRequest({ token: "native-private-proof", deadlineMs: 900_000 })!,
    { schemaVersion: 1, sdkApiVersion: 1, revision: 2, leaseExpiresAtMs: 1, bindings: [changed] }));
  assert.equal(h.broker(request(), h.abort.signal).ok, false); assert.deepEqual(h.effects, []);
});
test("an expired action cannot commit under a freshly renewed binding lease", () => {
  const h = fixture(); assert.equal(h.broker(request(), h.abort.signal, () => false).ok, false);
  assert.deepEqual(h.effects, []);
});
