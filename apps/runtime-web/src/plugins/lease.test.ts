import test from "node:test";
import assert from "node:assert/strict";
import { RoomPluginBindingLease } from "./lease.js";
import { parseRoomPluginRuntimeSnapshot, roomPluginContentPath } from "./runtime-dto.js";

const raw = { bindingId: "11111111-1111-4111-8111-111111111111", packageId: "22222222-2222-4222-8222-222222222222",
  pluginId: "external.status", version: "1.0.0", artifactSha256: "a".repeat(64), enabled: true, generation: 1, bindingRevision: 1,
  config: {}, approvedCapabilities: ["status.set"], contentUrl: roomPluginContentPath("room", "22222222-2222-4222-8222-222222222222") };
const snapshot = (revision = 1, bindings = [raw]) => parseRoomPluginRuntimeSnapshot(JSON.stringify({ schemaVersion: 1,
  sdkApiVersion: 1, revision, leaseExpiresAtMs: Number.MAX_SAFE_INTEGER, bindings }), "room");
const identity = snapshot().bindings[0];
const proof = (deadlineMs = 900_000) => ({ token: "native-proof", deadlineMs });

test("lease expires synchronously at request-start plus5s even when expiry timers never run", () => {
  let now = 0; const lease = new RoomPluginBindingLease(() => now);
  const request = lease.beginRequest(proof())!, late = lease.beginRequest(proof())!; assert.ok(lease.accept(request, snapshot()));
  const permit = lease.permit(identity)!; now = 4999; assert.ok(lease.isCurrent(permit));
  now = 5000; assert.equal(lease.isCurrent(permit), false); assert.equal(lease.permit(identity), null);
  assert.equal(lease.accept(late, snapshot()), false, "an expired request cannot grant a new deadline from receipt");
});
test("a slow4900ms config reply grants only100ms, not another5s from receipt", () => {
  let now = 0; const lease = new RoomPluginBindingLease(() => now); const request = lease.beginRequest(proof())!;
  now = 4900; assert.ok(lease.accept(request, snapshot())); assert.equal(lease.diagnostics().remainingMs, 100);
  const permit = lease.permit(identity)!; now = 5000; assert.equal(lease.isCurrent(permit), false);
});
test("a renewal in flight cannot extend a lease issued with the old token's bound", () => {
  let now = 0; const lease = new RoomPluginBindingLease(() => now); const old = lease.beginRequest(proof(1000))!;
  now = 900; assert.ok(lease.accept(old, snapshot())); const oldPermit = lease.permit(identity)!;
  const renewed = lease.beginRequest(proof(900_000))!; assert.ok(lease.accept(renewed, snapshot()));
  now = 1000; assert.equal(lease.isCurrent(oldPermit), false); assert.ok(lease.permit(identity));
});
test("a fresh bounded revalidation can resume after expiry without reviving older effect permits", () => {
  let now = 0; const lease = new RoomPluginBindingLease(() => now); assert.ok(lease.accept(lease.beginRequest(proof())!, snapshot()));
  const oldPermit = lease.permit(identity)!;
  now = 4000; const fresh = lease.beginRequest(proof())!;
  now = 6000; assert.equal(lease.isCurrent(oldPermit), false); assert.ok(lease.accept(fresh, snapshot()));
  assert.equal(lease.permit(identity)!.deadlineMs, 9000); assert.equal(lease.isCurrent(oldPermit), false);
});
test("older revision or reordered equal-revision replies never renew the accepted lease", () => {
  let now = 0; const lease = new RoomPluginBindingLease(() => now); const old = lease.beginRequest(proof())!, equal = lease.beginRequest(proof())!;
  now = 100; const newer = lease.beginRequest(proof())!; assert.ok(lease.accept(newer, snapshot(2)));
  const deadline = lease.permit(identity)!.deadlineMs;
  now = 200; assert.equal(lease.accept(old, snapshot(1)), false); assert.equal(lease.accept(equal, snapshot(2)), false);
  assert.equal(lease.permit(identity)!.deadlineMs, deadline);
});
test("disable/context fences reject pending effects and late config before async cleanup", () => {
  let now = 0; const lease = new RoomPluginBindingLease(() => now); const request = lease.beginRequest(proof())!;
  assert.ok(lease.accept(request, snapshot())); const permit = lease.permit(identity)!;
  const delayed = lease.beginRequest(proof())!;
  now = 100; lease.invalidate(); assert.equal(lease.isCurrent(permit), false); assert.equal(lease.accept(delayed, snapshot(9)), false);
  const fresh = lease.beginRequest(proof())!; assert.ok(lease.accept(fresh, snapshot(2, []))); assert.equal(lease.permit(identity), null);
});
test("permits bind exact generation/revision/hash and old sessions cannot pin a new room's revision", () => {
  const lease = new RoomPluginBindingLease(() => 0); const request = lease.beginRequest(proof())!; assert.ok(lease.accept(request, snapshot()));
  for (const patch of [{ generation: 2 }, { bindingRevision: 2 }, { artifactSha256: "b".repeat(64) }, { bindingId: "other" }]) {
    assert.equal(lease.permit({ ...identity, ...patch }), null);
  }
  const previousSession = lease.beginRequest(proof())!;
  lease.resetSession(); assert.equal(lease.accept(previousSession, snapshot(100)), false);
  assert.ok(lease.accept(lease.beginRequest(proof())!, snapshot(0, [])));
});
test("invalid native request timestamps cannot manufacture a lease", () => {
  const lease = new RoomPluginBindingLease(() => 0); const request = lease.beginRequest(proof())!;
  for (const patch of [{ startedAtMs: NaN }, { startedAtMs: -1 }, { startedAtMs: 1 }, { tokenDeadlineMs: NaN }, { tokenDeadlineMs: Infinity }]) {
    assert.equal(lease.accept({ ...request, ...patch }, snapshot()), false);
  }
  assert.equal(lease.permit(identity), null);
});
test("copied or replayed metadata is not an issued native request/effect permit", () => {
  const lease = new RoomPluginBindingLease(() => 0); const request = lease.beginRequest(proof())!;
  assert.equal(lease.accept({ ...request }, snapshot()), false);
  assert.ok(lease.accept(request, snapshot())); assert.equal(lease.accept(request, snapshot()), false);
  const permit = lease.permit(identity)!; assert.ok(lease.isCurrent(permit));
  assert.equal(lease.isCurrent({ ...permit, deadlineMs: Number.MAX_SAFE_INTEGER }), false);
});
test("unchanged binding tuple cannot silently change approved effects or config", () => {
  for (const patch of [{ approvedCapabilities: [] }, { config: { greeting: "changed" } }, { version: "2.0.0" },
    { packageId: "33333333-3333-4333-8333-333333333333", contentUrl: roomPluginContentPath("room", "33333333-3333-4333-8333-333333333333") }]) {
    const lease = new RoomPluginBindingLease(() => 0); assert.ok(lease.accept(lease.beginRequest(proof())!, snapshot()));
    const permit = lease.permit(identity)!;
    const changed = snapshot(1, [{ ...raw, ...patch }]);
    assert.equal(lease.accept(lease.beginRequest(proof())!, changed), false); assert.equal(lease.isCurrent(permit), false);
    assert.equal(lease.accept(lease.beginRequest(proof())!, changed), false, "a new request cannot forget conflicting metadata");
  }
});
test("expired permits never revive after a shorter intervening lease and fresh revalidation", () => {
  let now = 0; const lease = new RoomPluginBindingLease(() => now); assert.ok(lease.accept(lease.beginRequest(proof())!, snapshot()));
  const permit = lease.permit(identity)!;
  now = 100; assert.ok(lease.accept(lease.beginRequest(proof(3000))!, snapshot()));
  now = 3500; assert.ok(lease.accept(lease.beginRequest(proof())!, snapshot()));
  assert.equal(lease.isCurrent(permit), false); assert.ok(lease.permit(identity));
});
test("a room revision change fences pending effects even when a different binding changed", () => {
  const lease = new RoomPluginBindingLease(() => 0); assert.ok(lease.accept(lease.beginRequest(proof())!, snapshot()));
  const permit = lease.permit(identity)!; assert.ok(lease.accept(lease.beginRequest(proof())!, snapshot(2)));
  assert.equal(lease.isCurrent(permit), false); assert.ok(lease.permit(identity));
});
test("newer revisions from older-start requests cannot extend a deadline or emit nonfinite diagnostics", () => {
  let now = 0; const lease = new RoomPluginBindingLease(() => now); const older = lease.beginRequest(proof())!;
  now = 100; assert.ok(lease.accept(lease.beginRequest(proof())!, snapshot()));
  now = 200; assert.ok(lease.accept(older, snapshot(2))); assert.equal(lease.permit(identity)!.deadlineMs, 5000);
  now = NaN; assert.equal(lease.diagnostics().remainingMs, 0); assert.equal(lease.permit(identity), null);
});
