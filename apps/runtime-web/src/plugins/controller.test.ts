import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createRoomPluginArtifact } from "@vrata/room-plugin-sdk/artifact";
import type { RoomPluginEvent, RoomPluginRequest, RoomPluginRoomSnapshot } from "@vrata/room-plugin-sdk";
import { RoomPluginController, type RoomPluginCoreContext, type RoomPluginInstance, type RoomPluginSeatingHost } from "./controller.js";
import { parseRoomPluginRuntimeSnapshot, roomPluginContentPath, type RoomPluginRuntimeSnapshot } from "./runtime-dto.js";
import type { RoomPluginStatusRow } from "./status-view.js";
import { SandboxError } from "./limits.js";
import { createRoomPluginHttp, RoomPluginHttpError } from "./http.js";
import { RoomPluginSeatAdapter, type RoomPluginSeatWorld } from "./seat-adapter.js";

const artifact = createRoomPluginArtifact({ schemaVersion: 1, sdkApiVersion: 1, id: "external.greeting", version: "1.0.0", displayName: "<b>owned label</b>",
  requestedCapabilities: ["status.set"], configSchema: { greeting: { type: "string", required: true, minLength: 1, maxLength: 64 } } },
  "export function init(c) { return c.sdk.status.set(c.config.greeting); }");
const bindingId = "11111111-1111-4111-8111-111111111111", packageId = "22222222-2222-4222-8222-222222222222";
function snapshot(revision = 1, greeting: unknown = "first", enabled = true) {
  return parseRoomPluginRuntimeSnapshot(JSON.stringify({ schemaVersion: 1, sdkApiVersion: 1, revision, leaseExpiresAtMs: 1, bindings: enabled ? [{
    bindingId, packageId, pluginId: artifact.artifact.manifest.id, version: "1.0.0", artifactSha256: artifact.artifactSha256,
    enabled: true, generation: revision, bindingRevision: revision, approvedCapabilities: ["status.set"], config: { greeting }, contentUrl: roomPluginContentPath("room", packageId)
  }] : [] }), "room");
}
class Instance implements RoomPluginInstance {
  state = "ready"; busy = false; terminated = 0; disposed = 0; events: RoomPluginEvent[] = [];
  async event(event: RoomPluginEvent) { this.events.push(event); }
  async dispose() { this.disposed++; this.state = "disposed"; }
  terminate() { this.terminated++; this.state = "failed"; }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() >= deadline) assert.fail("controller_condition_not_reached"); await delay(1); }
}
function harness(seating?: RoomPluginSeatingHost) {
  let now = 0, id = 0, current = snapshot(0, "", false), content = artifact.bytes, startsError: Error | null = null;
  const context: RoomPluginCoreContext = { active: true, ready: true, online: true, visible: true, connection: "connected" };
  const timers = new Map<number, { at: number; callback(): void }>();
  const counters = { snapshots: 0, contents: 0, starts: 0 };
  const instances: Instance[] = [], dispatches: Array<(request: RoomPluginRequest, signal: AbortSignal) => unknown> = [];
  const signals: AbortSignal[] = [];
  const renderings: RoomPluginStatusRow[][] = [];
  let pendingSnapshot: (() => Promise<RoomPluginRuntimeSnapshot>) | null = null;
  let pendingContent: (() => Promise<Uint8Array>) | null = null;
  let pendingStart: (() => Promise<Instance>) | null = null;
  const controller = new RoomPluginController({ apiBaseUrl: "https://app.invalid", roomId: "room", context: () => context, seating,
    proof: () => ({ token: "native-private-token", deadlineMs: 900_000 }), clock: () => now,
    timers: { schedule(callback, ms) { const handle = ++id; timers.set(handle, { at: now + ms, callback }); return handle; }, cancel(handle) { timers.delete(handle as number); } },
    http: { async snapshot() { counters.snapshots++; return pendingSnapshot ? pendingSnapshot() : current; },
      async content(_binding, _proof, signal) { counters.contents++; signals.push(signal); return pendingContent ? pendingContent() : content; } },
    async start(source, config, _caps, dispatch, signal) {
      counters.starts++; dispatches.push(dispatch); signals.push(signal);
      assert.equal(source, artifact.artifact.entry); assert.equal(signal.aborted, false);
      if (startsError) throw startsError;
      if (pendingStart) return pendingStart();
      assert.equal((dispatch({ sdkApiVersion: 1, requestId: "1", operation: "status.set", payload: { text: String(config.greeting) } }, new AbortController().signal) as { ok: boolean }).ok, true);
      const instance = new Instance(); instances.push(instance); return instance;
    },
    render(rows) { renderings.push(rows.map(row => ({ ...row }))); }
  });
  return { controller, counters, context, instances, dispatches, signals, renderings,
    config(value: RoomPluginRuntimeSnapshot) { current = value; }, bytes(value: Uint8Array) { content = value; }, failStart(error: Error) { startsError = error; },
    snapshotTask(value: (() => Promise<RoomPluginRuntimeSnapshot>) | null) { pendingSnapshot = value; },
    contentTask(value: (() => Promise<Uint8Array>) | null) { pendingContent = value; },
    startTask(value: (() => Promise<Instance>) | null) { pendingStart = value; },
    async advance(target: number) {
      for (;;) {
        const next = [...timers].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await delay(1);
      }
      now = target; await delay(1);
    }
  };
}

test("legacy identity creates no plugin traffic and zero bindings keep discovery without importing a host", async () => {
  const h = harness(); h.controller.start(null); await delay(1);
  assert.deepEqual(h.counters, { snapshots: 0, contents: 0, starts: 0 });
  h.controller.start(2); await until(() => h.counters.snapshots === 1 && !h.controller.diagnostics().fetchPending);
  await h.advance(2000); assert.equal(h.counters.snapshots, 2); assert.equal(h.counters.starts, 0); assert.equal(h.counters.contents, 0);
  assert.equal(h.controller.diagnostics().state, "empty"); h.controller.stop();
});

test("session-control revision hint only brings refresh forward; equal, invalid, rapid and stopped hints are ignored", async () => {
  const h = harness(); h.controller.start(2); await until(() => h.counters.snapshots === 1 && !h.controller.diagnostics().fetchPending);
  for (const value of [0, -1, "1", 1.5, null]) h.controller.observeRevisionHint(value);
  await delay(1); assert.equal(h.counters.snapshots, 1);
  h.config(snapshot()); h.controller.observeRevisionHint(1);
  await until(() => h.controller.diagnostics().running === 1); assert.equal(h.counters.snapshots, 2);
  h.config(snapshot(2, "second")); h.controller.observeRevisionHint(2); await delay(1);
  assert.equal(h.counters.snapshots, 2, "hints are spaced by at least 500 ms");
  await h.advance(500); h.controller.observeRevisionHint(2);
  await until(() => h.renderings.at(-1)?.[0]?.text === "second"); assert.equal(h.counters.snapshots, 3);
  h.controller.stop(); await h.advance(1000); h.controller.observeRevisionHint(9); await delay(1); assert.equal(h.counters.snapshots, 3);
});

test("external exact content starts only after readiness and commits a labelled status without room-ready fiction", async () => {
  const h = harness(); h.context.ready = false; h.config(snapshot()); h.controller.start(2);
  await until(() => h.counters.snapshots === 1 && !h.controller.diagnostics().fetchPending);
  assert.equal(h.counters.contents, 0); assert.equal(h.counters.starts, 0);
  h.context.ready = true; h.controller.kick(); await until(() => h.controller.diagnostics().running === 1);
  assert.equal(h.counters.contents, 1); assert.equal(h.counters.starts, 1);
  const row = h.renderings.at(-1)![0]; assert.equal(row.name, "<b>owned label</b>"); assert.equal(row.text, "first");
  assert.deepEqual(h.instances[0].events, [{ sdkApiVersion: 1, type: "room.connection", state: "connected" }]);
  const diagnostics = JSON.stringify(h.controller.diagnostics());
  for (const privateValue of ["native-private-token", "external.greeting", "owned label", "first", artifact.artifact.entry]) assert.equal(diagnostics.includes(privateValue), false);
  h.controller.stop();
});

test("identical lease renewals preserve pending content and keep discovery independent", async t => {
  const h = harness(); t.after(() => h.controller.stop()); h.config(snapshot());
  let release!: (bytes: Uint8Array) => void;
  h.contentTask(() => new Promise(resolve => { release = resolve; }));
  h.controller.start(2); await until(() => h.counters.contents === 1 && !h.controller.diagnostics().fetchPending);
  await h.advance(8000);
  assert.deepEqual(h.counters, { snapshots: 5, contents: 1, starts: 0 });
  release(artifact.bytes); await until(() => h.controller.diagnostics().running === 1);
  assert.deepEqual(h.counters, { snapshots: 5, contents: 1, starts: 1 });
});

test("identical lease renewals preserve one pending VM without blocking fresh discovery", async t => {
  const h = harness(); t.after(() => h.controller.stop()); h.config(snapshot());
  let release!: (value: Instance) => void;
  h.startTask(() => new Promise(resolve => { release = resolve; }));
  h.controller.start(2); await until(() => h.counters.starts === 1 && !h.controller.diagnostics().fetchPending);
  await h.advance(18000);
  assert.deepEqual(h.counters, { snapshots: 10, contents: 1, starts: 1 });
  const instance = new Instance(); release(instance);
  await until(() => h.controller.diagnostics().running === 1);
  assert.equal(instance.terminated, 0);
  assert.equal(h.counters.starts, 1);
});

test("a disabled generation still terminates a pending VM after identical renewals", async t => {
  const h = harness(); t.after(() => h.controller.stop()); h.config(snapshot());
  let release!: (value: Instance) => void;
  h.startTask(() => new Promise(resolve => { release = resolve; }));
  h.controller.start(2); await until(() => h.counters.starts === 1);
  await h.advance(2000); h.config(snapshot(2, "", false)); h.controller.kick();
  await until(() => h.controller.diagnostics().instances === 0);
  const instance = new Instance(); release(instance); await delay(1);
  assert.equal(instance.terminated, 1);
  const denied = h.dispatches[0]({ sdkApiVersion: 1, requestId: "90", operation: "status.set", payload: { text: "old" } }, new AbortController().signal) as { ok: boolean };
  assert.equal(denied.ok, false);
  assert.equal(h.controller.diagnostics().retirements[0].reason, "binding-removed");
});

for (const phase of ["content", "VM"] as const) test(`expiry during pending ${phase} records the actual branch and fences late completion`, async t => {
  const h = harness(); t.after(() => h.controller.stop()); h.config(snapshot());
  let releaseContent!: (bytes: Uint8Array) => void, releaseVm!: (instance: Instance) => void;
  if (phase === "content") h.contentTask(() => new Promise(resolve => { releaseContent = resolve; }));
  else h.startTask(() => new Promise(resolve => { releaseVm = resolve; }));
  h.controller.start(2); await until(() => (phase === "content" ? h.counters.contents : h.counters.starts) === 1);
  h.snapshotTask(() => new Promise(() => {}));
  await h.advance(5000);
  const [fact] = h.controller.diagnostics().retirements;
  assert.equal(fact.reason, "lease-expired"); assert.equal(fact.starting, true);
  assert.equal(fact.instanceState, null); assert.equal(fact.leaseValid, false); assert.equal(fact.remainingLeaseMs, 0);
  assert.equal(fact.fetchPending, true); assert.equal(fact.ordinal, 1); assert.equal(fact.generation, 1);
  const instance = new Instance();
  if (phase === "content") releaseContent(artifact.bytes); else releaseVm(instance);
  await delay(5);
  assert.equal(h.controller.diagnostics().running, 0);
  assert.equal(h.counters.starts, phase === "content" ? 0 : 1);
  assert.equal(instance.terminated, phase === "content" ? 0 : 1);
});

/** A renewal that starts late is in flight when the old deadline passes: the refresh at
 * base+2000 is lost without touching the lease and the one at base+4000 stays pending. */
async function expireWhileRenewing(h: ReturnType<typeof harness>, base = 0) {
  h.snapshotTask(async () => { throw new RoomPluginHttpError("unavailable"); });
  await h.advance(base + 2000);
  let answer!: (value: RoomPluginRuntimeSnapshot) => void, refuse!: (error: Error) => void;
  h.snapshotTask(() => new Promise((resolve, reject) => { answer = resolve; refuse = reject; }));
  await h.advance(base + 5000);
  assert.equal(h.controller.diagnostics().fetchPending, true, "the renewal is in flight at the expiry");
  assert.equal(h.controller.diagnostics().remainingLeaseMs, 0);
  h.snapshotTask(null);
  return { answer: (value: RoomPluginRuntimeSnapshot) => answer(value), refuse: (error: Error) => refuse(error) };
}
function holdPreparation(h: ReturnType<typeof harness>, phase: "content" | "VM") {
  const finish: Array<(instance: Instance) => void> = [];
  if (phase === "content") h.contentTask(() => new Promise(resolve => { finish.push(() => resolve(artifact.bytes)); }));
  else h.startTask(() => new Promise(resolve => { finish.push(resolve); }));
  return finish;
}
const preparing = (h: ReturnType<typeof harness>, phase: "content" | "VM") => (phase === "content" ? h.counters.contents : h.counters.starts) === 1;

for (const phase of ["content", "VM"] as const) {
  test(`expiry during an in-flight renewal keeps the pending ${phase} and its attempt once the renewal is accepted`, async t => {
    const h = harness(); t.after(() => h.controller.stop()); h.config(snapshot());
    const finish = holdPreparation(h, phase);
    h.controller.start(2); await until(() => preparing(h, phase) && !h.controller.diagnostics().fetchPending);
    const renewal = await expireWhileRenewing(h);
    assert.deepEqual(h.controller.diagnostics().retirements, []);
    assert.equal(h.signals[0].aborted, false, "the preparation is not cancelled while its renewal can still return");
    assert.equal(h.controller.diagnostics().state, "suspended");
    renewal.answer(snapshot()); await until(() => !h.controller.diagnostics().fetchPending);
    assert.equal(h.controller.diagnostics().state, "running");
    assert.equal(h.controller.diagnostics().remainingLeaseMs, 4000, "fresh authority comes only from the accepted renewal");
    assert.deepEqual([h.counters.contents, h.counters.starts], phase === "content" ? [1, 0] : [1, 1], "no second attempt");
    h.contentTask(null); h.startTask(null);
    finish[0](new Instance()); await until(() => h.controller.diagnostics().running === 1);
    assert.deepEqual([h.counters.contents, h.counters.starts], [1, 1]);
    assert.deepEqual(h.controller.diagnostics().retirements, []);
  });

  test(`a pending ${phase} finished between expiry and renewal gets no effects and needs a new attempt`, async t => {
    const h = harness(); t.after(() => h.controller.stop()); h.config(snapshot());
    const finish = holdPreparation(h, phase);
    h.controller.start(2); await until(() => preparing(h, phase) && !h.controller.diagnostics().fetchPending);
    const renewal = await expireWhileRenewing(h);
    h.contentTask(null); h.startTask(null);
    const late = new Instance(); finish[0](late); await delay(5);
    assert.equal(h.controller.diagnostics().running, 0);
    assert.equal(h.counters.starts, phase === "content" ? 0 : 1, "no VM starts without authority");
    assert.equal(late.terminated, phase === "content" ? 0 : 1);
    assert.deepEqual(late.events, []);
    assert.equal(h.renderings.flat().some(row => row.text !== ""), false, "no status was committed");
    renewal.answer(snapshot()); await until(() => h.controller.diagnostics().running === 1);
    assert.equal(h.counters.starts, phase === "content" ? 1 : 2);
  });

  test(`expiry with no renewal in flight still cancels the pending ${phase}`, async t => {
    const h = harness(); t.after(() => h.controller.stop()); h.config(snapshot());
    const finish = holdPreparation(h, phase);
    h.controller.start(2); await until(() => preparing(h, phase) && !h.controller.diagnostics().fetchPending);
    h.snapshotTask(async () => { throw new RoomPluginHttpError("unavailable"); });
    await h.advance(5000);
    const [fact] = h.controller.diagnostics().retirements;
    assert.equal(fact.reason, "lease-expired"); assert.equal(fact.fetchPending, false); assert.equal(fact.starting, true);
    assert.equal(h.signals[0].aborted, true);
    const late = new Instance(); finish[0](late); await delay(5);
    assert.equal(h.controller.diagnostics().running, 0);
    assert.equal(late.terminated, phase === "content" ? 0 : 1);
  });

  for (const [name, outcome, reason] of [
    ["refused as unavailable", new RoomPluginHttpError("unavailable"), "refresh-failed"],
    ["denied", new RoomPluginHttpError("denied"), "refresh-failed"],
    ["stale", snapshot(1), "snapshot-rejected"],
    ["without the binding", snapshot(3, "", false), "binding-removed"],
    ["with a replaced binding", snapshot(3, "second"), "binding-replaced"]
  ] as const) test(`a renewal ${name} interrupts the pending ${phase} with ${reason}; its late result creates nothing`, async t => {
    const h = harness(); t.after(() => h.controller.stop()); h.config(snapshot(2));
    const finish = holdPreparation(h, phase);
    h.controller.start(2); await until(() => preparing(h, phase) && !h.controller.diagnostics().fetchPending);
    const renewal = await expireWhileRenewing(h);
    assert.deepEqual(h.controller.diagnostics().retirements, []);
    if (outcome instanceof Error) renewal.refuse(outcome); else renewal.answer(outcome);
    await until(() => !h.controller.diagnostics().fetchPending);
    const [fact] = h.controller.diagnostics().retirements;
    assert.equal(fact.reason, reason); assert.equal(fact.starting, true);
    assert.equal(h.signals[0].aborted, true);
    h.contentTask(null);
    const before = h.counters.starts, late = new Instance(); finish[0](late); await delay(5);
    assert.equal(h.counters.starts, before, "the late result starts no VM");
    assert.equal(late.terminated, phase === "content" ? 0 : 1);
    assert.equal(h.controller.diagnostics().running, 0);
  });
}

test("a broker request between expiry and renewal is denied and commits nothing while the VM start is pending", async t => {
  const h = harness(); t.after(() => h.controller.stop()); h.config(snapshot());
  const finish = holdPreparation(h, "VM");
  h.controller.start(2); await until(() => h.counters.starts === 1 && !h.controller.diagnostics().fetchPending);
  const request = (text: string) => h.dispatches[0]({ sdkApiVersion: 1, requestId: text, operation: "status.set", payload: { text } }, new AbortController().signal) as { ok: boolean; error?: string };
  const renewal = await expireWhileRenewing(h);
  assert.deepEqual(request("gap"), { sdkApiVersion: 1, requestId: "gap", ok: false, error: "lease-expired" });
  assert.equal(h.renderings.flat().some(row => row.text === "gap"), false);
  renewal.answer(snapshot()); await until(() => !h.controller.diagnostics().fetchPending);
  assert.equal(request("fresh").ok, true, "the same preparation works again only under the accepted renewal");
  finish[0](new Instance()); await until(() => h.controller.diagnostics().running === 1);
  assert.equal(h.renderings.at(-1)![0].text, "fresh");
});

test("a start failing after the lease gap is an interruption, not a sticky guest or host failure", async t => {
  const h = harness(); t.after(() => h.controller.stop()); h.config(snapshot());
  let reject!: (error: Error) => void;
  h.startTask(() => new Promise((_, fail) => { reject = fail; }));
  h.controller.start(2); await until(() => h.counters.starts === 1 && !h.controller.diagnostics().fetchPending);
  const renewal = await expireWhileRenewing(h);
  h.startTask(null);
  reject(new SandboxError("guest_exception")); await delay(5);
  const diagnostics = h.controller.diagnostics();
  assert.equal(diagnostics.failed, 0); assert.equal(diagnostics.hostFailed, false); assert.equal(diagnostics.lastInstanceFailure, null);
  assert.equal(diagnostics.retirements[0].reason, "lease-expired"); assert.equal(diagnostics.retirements[0].failure, "guest_exception");
  renewal.answer(snapshot()); await until(() => h.controller.diagnostics().running === 1);
  assert.equal(h.counters.starts, 2);
});

test("the lease gap excuses only its own attempt: a guest failure of the next start is sticky", async t => {
  const h = harness(); t.after(() => h.controller.stop()); h.config(snapshot());
  let reject!: (error: Error) => void;
  h.startTask(() => new Promise((_, fail) => { reject = fail; }));
  h.controller.start(2); await until(() => h.counters.starts === 1 && !h.controller.diagnostics().fetchPending);
  const renewal = await expireWhileRenewing(h);
  h.startTask(null);
  reject(new SandboxError("guest_exception")); await delay(5);
  assert.equal(h.controller.diagnostics().failed, 0, "the first attempt was an interruption");
  h.failStart(new SandboxError("guest_exception"));
  renewal.answer(snapshot()); await until(() => h.counters.starts === 2 && !h.controller.diagnostics().fetchPending); await delay(5);
  const diagnostics = h.controller.diagnostics();
  assert.equal(diagnostics.failed, 1, "the second attempt had no gap of its own");
  assert.equal(diagnostics.lastInstanceFailure, "guest_exception");
  assert.equal(diagnostics.retirements.at(-1)?.reason, "start-failed");
  await h.advance(10_000); assert.equal(h.counters.starts, 2, "the failure stays sticky");
});

test("repeated gaps keep one attempt, and a start interrupted by them still spends the unchanged budget", async t => {
  const kept = harness(); t.after(() => kept.controller.stop()); kept.config(snapshot());
  const finish = holdPreparation(kept, "VM");
  kept.controller.start(2); await until(() => kept.counters.starts === 1 && !kept.controller.diagnostics().fetchPending);
  for (let round = 0; round < 4; round++) {
    const renewal = await expireWhileRenewing(kept, round * 4000); renewal.answer(snapshot());
    await until(() => !kept.controller.diagnostics().fetchPending);
  }
  kept.startTask(null); finish[0](new Instance()); await until(() => kept.controller.diagnostics().running === 1);
  assert.equal(kept.counters.starts, 1); assert.deepEqual(kept.controller.diagnostics().retirements, []);

  const spent = harness(); t.after(() => spent.controller.stop()); spent.config(snapshot());
  const late = holdPreparation(spent, "VM"), terminated: Instance[] = [];
  spent.controller.start(2); await until(() => spent.counters.starts === 1 && !spent.controller.diagnostics().fetchPending);
  for (let round = 0; round < 3; round++) {
    const renewal = await expireWhileRenewing(spent, round * 4000);
    const instance = new Instance(); terminated.push(instance); late[round](instance); await delay(5);
    renewal.answer(snapshot()); await until(() => !spent.controller.diagnostics().fetchPending);
  }
  assert.equal(spent.counters.starts, 3); assert.equal(spent.controller.diagnostics().failed, 1);
  assert.equal(spent.controller.diagnostics().retirements.at(-1)?.reason, "start-budget");
  assert.deepEqual(terminated.map(instance => instance.terminated), [1, 1, 1]);
});

test("expiry during an in-flight renewal still cancels the preparation's pending claim; a late ACK uses nothing", async t => {
  const { entrySha256: _computed, ...manifest } = artifact.artifact.manifest;
  const seatArtifact = createRoomPluginArtifact({ ...manifest, id: "external.seat", requestedCapabilities: ["status.set", "seating.claimSelfOnEntry"] }, artifact.artifact.entry);
  const world: RoomPluginSeatWorld = { ready: true, correlation: true, online: true, xr: false, selfId: "self", seats: [{ id: "seat-a", yaw: 0 }], occupancy: {}, currentSeatId: null, pendingSeatId: null };
  const cancels: string[] = [], claims: string[] = [];
  const adapter = new RoomPluginSeatAdapter({ world: () => world, optedOut: () => false, clock: () => 0, random: () => "alias",
    claim(seat, id) { world.pendingSeatId = seat; claims.push(id); },
    cancel(_release, claim) { cancels.push(claim); world.pendingSeatId = null; return true; } });
  const h = harness({ supported: () => true, ready: () => world.ready, activate: () => adapter.activate(),
    snapshot: (owner, seating) => adapter.snapshot(owner, seating),
    port: owner => ({ claim: seat => adapter.claim(seat, owner), cancel: () => adapter.cancelOwn(owner) }),
    retire: owner => adapter.retire(owner) });
  t.after(() => { h.controller.stop(); adapter.stop(); });
  h.bytes(seatArtifact.bytes);
  const seatSnapshot = () => parseRoomPluginRuntimeSnapshot(JSON.stringify({ schemaVersion: 1, sdkApiVersion: 1, revision: 1, leaseExpiresAtMs: 1, bindings: [{
    bindingId, packageId, pluginId: "external.seat", version: "1.0.0", artifactSha256: seatArtifact.artifactSha256, enabled: true,
    generation: 1, bindingRevision: 1, approvedCapabilities: ["status.set", "seating.claimSelfOnEntry"], config: { greeting: "x" },
    contentUrl: roomPluginContentPath("room", packageId) }] }), "room");
  h.config(seatSnapshot());
  const finish = holdPreparation(h, "VM");
  adapter.observe(); adapter.activate();
  h.controller.start(2); await until(() => h.counters.starts === 1 && !h.controller.diagnostics().fetchPending);
  const claim = h.dispatches[0]({ sdkApiVersion: 1, requestId: "claim", operation: "seating.claimSelfOnEntry", payload: { seatId: "seat-a" } }, new AbortController().signal) as Promise<{ ok: boolean; result?: string }>;
  assert.equal(adapter.diagnostics().inFlight, true);
  const renewal = await expireWhileRenewing(h);
  assert.deepEqual(adapter.diagnostics().settlements.map(row => row.reason), ["retired"]);
  assert.deepEqual(cancels, claims); assert.equal((await claim).result, "cancelled");
  adapter.settleClaim({ seatId: "seat-a", accepted: true, commandId: claims[0] });
  assert.equal(adapter.diagnostics().grant, "open", "a late ACK cannot use the arrival grant");
  renewal.answer(seatSnapshot()); await until(() => !h.controller.diagnostics().fetchPending);
  assert.equal(h.signals[0].aborted, false, "only the claim is cancelled; preparation continues under fresh authority");
  finish[0](new Instance()); await until(() => h.controller.diagnostics().running === 1);
  assert.equal(h.counters.starts, 1);
});

test("the real snapshot timeout ends a hung renewal: the kept preparation is cancelled at its bound", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0, refreshes = 0, release!: (instance: Instance) => void, signal!: AbortSignal;
  const turn = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
  const tick = async (to: number) => { const ms = to - now; now = to; t.mock.timers.tick(ms); await turn(); };
  const runtime = JSON.stringify({ schemaVersion: 1, sdkApiVersion: 1, revision: 1, leaseExpiresAtMs: 1, bindings: [{
    bindingId, packageId, pluginId: artifact.artifact.manifest.id, version: "1.0.0", artifactSha256: artifact.artifactSha256, enabled: true,
    generation: 1, bindingRevision: 1, approvedCapabilities: ["status.set"], config: { greeting: "x" }, contentUrl: roomPluginContentPath("room", packageId) }] });
  const fetcher = (async (url: string | URL) => {
    if (!String(url).endsWith("/plugins/runtime")) return new Response(Uint8Array.from(artifact.bytes));
    refreshes++;
    if (refreshes === 1) return new Response(runtime);
    if (refreshes === 2) return new Response(null, { status: 503 });
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  const controller = new RoomPluginController({ apiBaseUrl: "https://app.invalid", roomId: "room", clock: () => now,
    context: () => ({ active: true, ready: true, online: true, visible: true, connection: "connected" }),
    proof: () => ({ token: "unit-only", deadlineMs: 900_000 }), render() {},
    http: createRoomPluginHttp({ apiBaseUrl: "https://app.invalid", roomId: "room", fetch: fetcher }),
    start: (_source, _config, _approved, _dispatch, abort) => { signal = abort; return new Promise(resolve => { release = resolve; }); } });
  t.after(() => controller.stop());
  controller.start(2); await turn();
  assert.ok(signal, "the VM start is pending"); assert.equal(controller.diagnostics().fetchPending, false);
  await tick(2000); assert.equal(refreshes, 2); assert.equal(controller.diagnostics().remainingLeaseMs, 3000);
  await tick(4000); assert.equal(refreshes, 3); assert.equal(controller.diagnostics().fetchPending, true);
  await tick(5000);
  assert.deepEqual(controller.diagnostics().retirements, []); assert.equal(signal.aborted, false);
  await tick(5999);
  assert.deepEqual(controller.diagnostics().retirements, [], "the renewal is still inside its own timeout");
  await tick(6000);
  assert.equal(controller.diagnostics().retirements[0].reason, "refresh-failed");
  assert.equal(signal.aborted, true);
  const late = new Instance(); release(late); await turn();
  assert.equal(late.terminated, 1); assert.equal(controller.diagnostics().running, 0);
});

test("binding revision replacement is distinct from renewal and retains early diagnostics across healthy instances", async t => {
  const h = harness(); t.after(() => h.controller.stop()); h.config(snapshot()); h.controller.start(2);
  await until(() => h.controller.diagnostics().running === 1);
  await h.advance(2000); assert.deepEqual(h.controller.diagnostics().retirements, []);
  h.config(snapshot(2, "second")); h.controller.kick(); await until(() => h.counters.starts === 2);
  const [first] = h.controller.diagnostics().retirements;
  assert.equal(first.reason, "binding-replaced"); assert.equal(first.bindingRevision, 1); assert.equal(first.leaseValid, false);
  for (let revision = 3; revision <= 40; revision++) {
    h.config(snapshot(revision, "next")); h.controller.kick(); await until(() => h.counters.starts === revision);
  }
  const rows = h.controller.diagnostics().retirements;
  assert.equal(rows.length, 32); assert.deepEqual(rows[0], first);
  rows[0].reason = "session-stop";
  assert.deepEqual(h.controller.diagnostics().retirements[0], first, "returned rows cannot mutate the history");
  for (const secret of [bindingId, packageId, "native-private-token", artifact.artifact.entry, "second"])
    assert.equal(JSON.stringify(rows).includes(secret), false);
});

test("busy availability loss and instance failure retain different producer branches", async t => {
  const h = harness(); t.after(() => h.controller.stop()); h.config(snapshot()); h.controller.start(2);
  await until(() => h.controller.diagnostics().running === 1);
  h.instances[0].busy = true; h.context.online = false; h.controller.availabilityChanged();
  assert.equal(h.controller.diagnostics().retirements[0].reason, "availability-changed");
  h.context.online = true; h.controller.availabilityChanged(); await until(() => h.counters.starts === 2);
  h.instances[1].state = "failed"; h.controller.kick(); await until(() => h.controller.diagnostics().failed === 1);
  const row = h.controller.diagnostics().retirements.at(-1)!;
  assert.equal(row.reason, "instance-closed"); assert.equal(row.failure, "instance_closed");
  assert.equal(row.leaseValid, true);
});

test("update uses a new instance and new config with cached verified code; disable fences old callbacks first", async () => {
  const h = harness(); h.config(snapshot()); h.controller.start(2); await until(() => h.controller.diagnostics().running === 1);
  const old = h.dispatches[0]; h.config(snapshot(2, "second")); h.controller.kick(); await until(() => h.counters.starts === 2 && h.controller.diagnostics().running === 1);
  assert.equal(h.counters.contents, 1); assert.equal(h.instances[0].disposed, 1); assert.equal(h.renderings.at(-1)![0].text, "second");
  const before = JSON.stringify(h.renderings.at(-1));
  assert.equal((old({ sdkApiVersion: 1, requestId: "2", operation: "status.set", payload: { text: "late callback" } }, new AbortController().signal) as { ok: boolean }).ok, false);
  assert.equal(JSON.stringify(h.renderings.at(-1)), before);
  h.config(snapshot(3, "", false)); h.controller.kick(); await until(() => h.controller.diagnostics().instances === 0);
  assert.deepEqual(h.renderings.at(-1), []); h.controller.stop();
});

test("guest failure is sticky for its key, including pause/restore, and does not restart on each discovery", async () => {
  const h = harness(); h.config(snapshot()); h.failStart(new SandboxError("execution_timeout")); h.controller.start(2);
  await until(() => h.controller.diagnostics().failed === 1);
  for (let i = 0; i < 5; i++) { h.controller.kick(); await until(() => !h.controller.diagnostics().fetchPending); }
  assert.equal(h.counters.starts, 1); assert.equal(h.counters.contents, 1); assert.equal(h.controller.diagnostics().lastFailure, "execution_timeout");
  assert.equal(h.controller.diagnostics().retirements[0].reason, "start-failed");
  assert.equal(h.controller.diagnostics().retirements[0].failure, "execution_timeout");
  h.controller.stop(); h.controller.start(2); await until(() => !h.controller.diagnostics().fetchPending);
  assert.equal(h.counters.starts, 1); assert.equal(h.controller.diagnostics().failed, 1); h.controller.stop();
});

test("hidden/offline contexts park idle instances and require fresh configuration before effects resume", async () => {
  const h = harness(); h.config(snapshot()); h.controller.start(2); await until(() => h.controller.diagnostics().running === 1);
  h.context.visible = false; h.controller.availabilityChanged(); assert.equal(h.controller.diagnostics().state, "suspended");
  const before = h.counters.snapshots; await h.advance(2000); assert.equal(h.counters.snapshots, before);
  const response = h.dispatches[0]({ sdkApiVersion: 1, requestId: "2", operation: "status.set", payload: { text: "hidden" } }, new AbortController().signal) as { ok: boolean };
  assert.equal(response.ok, false);
  h.context.visible = true; h.controller.availabilityChanged(); await until(() => h.controller.diagnostics().running === 1);
  assert.ok(h.counters.snapshots > before); assert.equal(h.counters.starts, 1); assert.equal(h.instances[0].terminated, 0); h.controller.stop();
});

test("late configuration after stop cannot allocate a Worker or revive a room session", async () => {
  const h = harness(); let release!: (value: RoomPluginRuntimeSnapshot) => void;
  h.snapshotTask(() => new Promise(resolve => { release = resolve; })); h.controller.start(2); await until(() => h.counters.snapshots === 1);
  h.controller.stop(); release(snapshot()); await delay(5);
  assert.equal(h.counters.starts, 0); assert.equal(h.counters.contents, 0); assert.equal(h.controller.diagnostics().state, "off");
});

test("tampered bytes and invalid cached config stop only the affected instance before native execution", async () => {
  const tampered = harness(); tampered.config(snapshot()); tampered.bytes(new Uint8Array([1, 2])); tampered.controller.start(2);
  await until(() => tampered.controller.diagnostics().failed === 1); assert.equal(tampered.counters.starts, 0); tampered.controller.stop();
  const cached = harness(); cached.config(snapshot()); cached.controller.start(2); await until(() => cached.controller.diagnostics().running === 1);
  cached.config(snapshot(2, false)); cached.controller.kick(); await until(() => cached.controller.diagnostics().failed === 1);
  assert.equal(cached.counters.starts, 1); assert.equal(cached.counters.contents, 1); assert.equal(cached.controller.diagnostics().hostFailed, false); cached.controller.stop();
});

test("lease expiration blocks effects while a fresh bounded request can still revalidate", async () => {
  const h = harness(); h.config(snapshot()); h.controller.start(2); await until(() => h.controller.diagnostics().running === 1);
  let release!: (value: RoomPluginRuntimeSnapshot) => void; h.snapshotTask(() => new Promise(resolve => { release = resolve; }));
  await h.advance(2000); await h.advance(5000); assert.equal(h.controller.diagnostics().state, "suspended");
  assert.deepEqual(h.controller.diagnostics().retirements, [], "idle expiry fences effects without retiring the instance");
  assert.equal((h.dispatches[0]({ sdkApiVersion: 1, requestId: "2", operation: "status.set", payload: { text: "expired" } }, new AbortController().signal) as { ok: boolean }).ok, false);
  release(snapshot()); await until(() => h.controller.diagnostics().running === 1); assert.equal(h.counters.starts, 1); h.controller.stop();
});

test("stale snapshot and session end retain their own retirement branch, not lease expiry", async t => {
  const h = harness(); t.after(() => h.controller.stop()); h.config(snapshot(2)); h.controller.start(2);
  await until(() => h.controller.diagnostics().running === 1);
  h.instances[0].busy = true; h.config(snapshot(1)); h.controller.kick();
  await until(() => !h.controller.diagnostics().fetchPending);
  const [stale] = h.controller.diagnostics().retirements;
  assert.equal(stale.reason, "snapshot-rejected"); assert.equal(stale.leaseValid, true);
  assert.equal(stale.remainingLeaseMs, 5000); assert.equal(h.controller.diagnostics().revision, 2);
  h.controller.stop();
  assert.equal(h.controller.diagnostics().retirements.at(-1)?.reason, "session-stop");
  assert.equal(h.controller.diagnostics().retirements.at(-1)?.leaseValid, false);
});

test("late content cannot cache or execute an artifact after its generation was disabled", async () => {
  const h = harness(); let release!: (bytes: Uint8Array) => void;
  h.contentTask(() => new Promise(resolve => { release = resolve; })); h.config(snapshot()); h.controller.start(2);
  await until(() => h.counters.contents === 1);
  h.config(snapshot(2, "", false)); h.controller.kick(); await until(() => h.controller.diagnostics().instances === 0);
  release(artifact.bytes); await delay(5); assert.equal(h.counters.starts, 0);
  h.contentTask(null); h.config(snapshot(3, "fresh")); h.controller.kick(); await until(() => h.controller.diagnostics().running === 1);
  assert.equal(h.counters.contents, 2, "retired generation did not populate the verified-code cache");
  assert.equal(h.renderings.at(-1)![0].text, "fresh"); h.controller.stop();
});

test("a host returned after session block is terminated rather than installed or allowed to commit", async () => {
  const h = harness(); let release!: (instance: Instance) => void;
  h.startTask(() => new Promise(resolve => { release = resolve; })); h.config(snapshot()); h.controller.start(2);
  await until(() => h.counters.starts === 1);
  h.context.active = false; h.controller.availabilityChanged();
  const instance = new Instance(); release(instance); await delay(5);
  assert.equal(instance.terminated, 1); assert.equal(h.controller.diagnostics().state, "off");
  assert.equal((h.dispatches[0]({ sdkApiVersion: 1, requestId: "2", operation: "status.set", payload: { text: "late" } }, new AbortController().signal) as { ok: boolean }).ok, false);
  assert.deepEqual(h.renderings.at(-1), []);
});

test("transient refresh failure retains only the original lease and does not erase an instance failure", async () => {
  const h = harness(); h.config(snapshot()); h.failStart(new SandboxError("execution_timeout")); h.controller.start(2);
  await until(() => h.controller.diagnostics().failed === 1);
  h.snapshotTask(async () => { throw new RoomPluginHttpError("unavailable"); });
  await h.advance(2000); await until(() => !h.controller.diagnostics().fetchPending);
  assert.equal(h.controller.diagnostics().remainingLeaseMs, 3000);
  assert.equal(h.controller.diagnostics().lastInstanceFailure, "execution_timeout");
  await h.advance(5000); assert.equal(h.controller.diagnostics().remainingLeaseMs, 0);
  assert.equal(h.controller.diagnostics().failed, 1); assert.equal(h.counters.starts, 1); h.controller.stop();
});

test("boot failure diagnostics retain only numeric startup timing across host ownership cleanup", async () => {
  const h = harness(), timing = { moduleAgeMs: 3, prepareMs: 4, prepareRoundTripMs: 1234, wasmLoadMs: 12 };
  h.config(snapshot()); h.failStart(new SandboxError("worker_boot_timeout", undefined, "worker-prepare", timing)); h.controller.start(2);
  await until(() => h.controller.diagnostics().failed === 1);
  assert.deepEqual(h.controller.diagnostics().startupTiming, timing);
  assert.equal(h.controller.diagnostics().lastHostPhase, "worker-prepare");
  assert.equal(h.controller.diagnostics().lastInstanceFailure, "worker_boot_timeout");
  assert.equal(JSON.stringify(h.controller.diagnostics()).includes("native-private-token"), false); h.controller.stop();
});

test("an instance that fails while idle is not replaced by the discovery timer", async () => {
  const h = harness(); h.config(snapshot()); h.controller.start(2); await until(() => h.controller.diagnostics().running === 1);
  h.instances[0].state = "failed";
  await h.advance(2000); await until(() => !h.controller.diagnostics().fetchPending);
  assert.equal(h.controller.diagnostics().failed, 1); assert.equal(h.counters.starts, 1);
  await h.advance(6000); assert.equal(h.counters.starts, 1); h.controller.stop();
});

function seatingHost(capabilities: string[] = ["status.set", "seating.claimSelfOnEntry"]) {
  const calls: string[] = [];
  let ready = false, supported = true;
  let data: RoomPluginRoomSnapshot = { ownParticipantAlias: "alias", arrivalAllowed: true, seats: [] };
  const host: RoomPluginSeatingHost = {
    supported: () => supported, ready: () => ready, activate: () => { calls.push("activate"); },
    snapshot: (owner, seating) => { calls.push(`snapshot:${seating}`); return { ...data, arrivalAllowed: seating && data.arrivalAllowed, seats: seating ? data.seats : [] }; },
    port: owner => { calls.push("port"); return { claim: async () => ({ result: "busy" }), cancel: () => undefined }; },
    retire: owner => { calls.push("retire"); }
  };
  return { host, calls, capabilities, setSnapshot(value: RoomPluginRoomSnapshot) { data = value; }, setReady(value: boolean) { ready = value; }, setSupported(value: boolean) { supported = value; } };
}
function seatingSnapshot(revision = 1, enabled = true) {
  return parseRoomPluginRuntimeSnapshot(JSON.stringify({ schemaVersion: 1, sdkApiVersion: 1, revision, leaseExpiresAtMs: 1, bindings: enabled ? [{
    bindingId, packageId, pluginId: artifact.artifact.manifest.id, version: "1.0.0", artifactSha256: artifact.artifactSha256,
    enabled: true, generation: revision, bindingRevision: revision, approvedCapabilities: ["status.set"], config: { greeting: "seat" }, contentUrl: roomPluginContentPath("room", packageId)
  }] : [] }), "room");
}

test("room.ready waits for platform readiness, is sent once per instance and snapshots stay coalesced", async () => {
  const s = seatingHost(); const h = harness(s.host); h.config(seatingSnapshot()); h.controller.start(2);
  await until(() => h.controller.diagnostics().running === 1);
  assert.deepEqual(h.instances[0].events.map(event => event.type), ["room.connection"], "no room.ready before readiness");
  s.setReady(true); h.controller.seatingChanged(); h.controller.seatingChanged();
  await h.advance(100); await until(() => h.instances[0].events.length === 2);
  assert.deepEqual(h.instances[0].events.map(event => event.type), ["room.connection", "room.ready"]);
  assert.deepEqual(s.calls, ["snapshot:false"], "a status-only plugin gets no seat data");
  await until(() => h.controller.diagnostics().readyDeliveries[0]?.completedAtMs !== null);
  assert.deepEqual(h.controller.diagnostics().readyDeliveries, [{ sentAtMs: 100, completedAtMs: 100, failedAtMs: null, seating: false, arrivalAllowed: false }]);
  h.controller.seatingChanged(); await h.advance(200); await delay(5);
  assert.equal(h.instances[0].events.length, 2, "status-only plugins receive no seating snapshots");
  h.config(seatingSnapshot(2, false)); h.controller.kick(); await until(() => h.controller.diagnostics().instances === 0);
  assert.ok(s.calls.includes("retire"), "disable retires the instance's pending seating");
  h.controller.stop();
});

test("seating status is labelled unavailable only when the server cannot correlate claims", async () => {
  const s = seatingHost(); s.setSupported(false); const h = harness(s.host);
  h.config(parseRoomPluginRuntimeSnapshot(JSON.stringify({ schemaVersion: 1, sdkApiVersion: 1, revision: 1, leaseExpiresAtMs: 1, bindings: [{
    bindingId, packageId, pluginId: artifact.artifact.manifest.id, version: "1.0.0", artifactSha256: artifact.artifactSha256, enabled: true,
    generation: 1, bindingRevision: 1, approvedCapabilities: ["status.set"], config: { greeting: "x" }, contentUrl: roomPluginContentPath("room", packageId) }] }), "room"));
  h.controller.start(2); await until(() => h.controller.diagnostics().running === 1);
  assert.equal(h.renderings.at(-1)![0].seatingUnavailable, false, "status-only bindings never show the seating notice");
  assert.equal(s.calls.includes("port"), false, "no seat port without a seating capability");
  h.controller.stop();
});

test("a seating-capable instance gets the seat port, real snapshots and coalesced updates", async () => {
  const { entrySha256: _computed, ...manifest } = artifact.artifact.manifest;
  const seatArtifact = createRoomPluginArtifact({ ...manifest, id: "external.seat", requestedCapabilities: ["status.set", "seating.claimSelfOnEntry"] },
    artifact.artifact.entry);
  const s = seatingHost(); s.setReady(true); const h = harness(s.host); h.bytes(seatArtifact.bytes);
  h.config(parseRoomPluginRuntimeSnapshot(JSON.stringify({ schemaVersion: 1, sdkApiVersion: 1, revision: 1, leaseExpiresAtMs: 1, bindings: [{
    bindingId, packageId, pluginId: "external.seat", version: "1.0.0", artifactSha256: seatArtifact.artifactSha256, enabled: true,
    generation: 1, bindingRevision: 1, approvedCapabilities: ["status.set", "seating.claimSelfOnEntry"], config: { greeting: "x" },
    contentUrl: roomPluginContentPath("room", packageId) }] }), "room"));
  h.controller.start(2); await until(() => h.instances.length === 1 && h.instances[0].events.length === 2);
  assert.deepEqual(h.instances[0].events.map(event => event.type), ["room.connection", "room.ready"]);
  assert.ok(s.calls.includes("port")); assert.equal(h.renderings.at(-1)![0].seatingUnavailable, false);
  assert.ok(s.calls.indexOf("activate") >= 0 && s.calls.indexOf("activate") < s.calls.indexOf("snapshot:true"), "the window opens before the first snapshot");
  s.setSnapshot({ ownParticipantAlias: "alias", arrivalAllowed: true, seats: [{ id: "seat-a", yaw: 0, occupantAlias: null }] });
  for (let i = 0; i < 5; i++) h.controller.seatingChanged();
  await h.advance(100); await until(() => h.instances[0].events.length === 3);
  assert.equal(h.instances[0].events[2].type, "seating.snapshot");
  await h.advance(300); await delay(5); assert.equal(h.instances[0].events.length, 3, "five changes produced one snapshot");
  h.controller.stop();
  assert.ok(s.calls.includes("retire"));
});

test("a trusted WASM load miss gets one bounded retry; a second miss stops plugins without a restart loop", async () => {
  const h = harness(); h.config(snapshot()); h.failStart(new SandboxError("wasm_load_failed")); h.controller.start(2);
  await until(() => h.counters.starts === 1 && !h.controller.diagnostics().fetchPending);
  assert.equal(h.controller.diagnostics().hostFailed, false); assert.equal(h.controller.diagnostics().failed, 0);
  await h.advance(2000); await until(() => h.counters.starts === 2);
  await until(() => h.controller.diagnostics().failed === 1);
  assert.equal(h.controller.diagnostics().hostFailed, true);
  for (let i = 0; i < 3; i++) { await h.advance(2000 * (i + 2)); }
  assert.equal(h.counters.starts, 2, "no further restarts after the bounded retry");
  h.controller.stop();
  const ok = harness(); ok.config(snapshot()); ok.failStart(new SandboxError("wasm_load_failed")); ok.controller.start(2);
  await until(() => ok.counters.starts === 1 && !ok.controller.diagnostics().fetchPending);
  ok.failStart(null as never); await ok.advance(2000); await until(() => ok.controller.diagnostics().running === 1);
  assert.equal(ok.controller.diagnostics().hostFailed, false);
  ok.controller.stop();
});

async function seatingControllerHarness() {
  const { entrySha256: _computed, ...manifest } = artifact.artifact.manifest;
  const seatArtifact = createRoomPluginArtifact({ ...manifest, id: "external.seat", requestedCapabilities: ["status.set", "seating.claimSelfOnEntry"] }, artifact.artifact.entry);
  const s = seatingHost(); s.setReady(true); const h = harness(s.host); h.bytes(seatArtifact.bytes);
  const config = (revision = 1) => parseRoomPluginRuntimeSnapshot(JSON.stringify({ schemaVersion: 1, sdkApiVersion: 1, revision, leaseExpiresAtMs: 1, bindings: [{
    bindingId, packageId, pluginId: "external.seat", version: "1.0.0", artifactSha256: seatArtifact.artifactSha256, enabled: true,
    generation: revision, bindingRevision: revision, approvedCapabilities: ["status.set", "seating.claimSelfOnEntry"], config: { greeting: "x" },
    contentUrl: roomPluginContentPath("room", packageId) }] }), "room");
  h.config(config()); h.controller.start(2);
  await until(() => h.instances.length === 1 && h.instances[0].events.length === 2);
  return { ...h, s, seatConfig: config };
}

test("seating updates suppress an unchanged SDK snapshot and deliver one changed snapshot", async () => {
  const h = await seatingControllerHarness();
  try {
    for (let i = 0; i < 5; i++) h.controller.seatingChanged();
    await h.advance(100); assert.equal(h.instances[0].events.length, 2, "unchanged snapshot creates no VM event");
    h.s.setSnapshot({ ownParticipantAlias: "alias", arrivalAllowed: true, seats: [{ id: "seat-a", yaw: 0, occupantAlias: "peer" }] });
    for (let i = 0; i < 5; i++) h.controller.seatingChanged();
    await h.advance(200); assert.equal(h.instances[0].events.length, 3);
    assert.equal(h.instances[0].events[2].type, "seating.snapshot");
    h.controller.seatingChanged(); await h.advance(300); assert.equal(h.instances[0].events.length, 3);
  } finally { h.controller.stop(); }
});

test("explicit force delivers one unchanged snapshot and survives coalescing with ordinary updates", async () => {
  const h = await seatingControllerHarness();
  try {
    h.controller.seatingChanged(true); await h.advance(100);
    assert.equal(h.instances[0].events.length, 3, "a post-claim observation is a semantic event even without occupancy changes");
    h.controller.seatingChanged(); h.controller.seatingChanged(true); h.controller.seatingChanged();
    await h.advance(200); assert.equal(h.instances[0].events.length, 4, "coalescing preserves force but sends only one event");
    h.controller.seatingChanged(); await h.advance(300); assert.equal(h.instances[0].events.length, 4, "force resets after delivery");
  } finally { h.controller.stop(); }
});

test("stop clears a pending seating force and a new instance always gets room.ready even with the same snapshot", async () => {
  const h = await seatingControllerHarness();
  try {
    h.controller.seatingChanged(true); h.controller.stop(); h.controller.start(2);
    await until(() => h.instances.length === 2 && h.instances[1].events.length === 2);
    assert.equal(h.instances[1].events[1].type, "room.ready");
    h.controller.seatingChanged(); await h.advance(100);
    assert.equal(h.instances[1].events.length, 2, "a cancelled session cannot force the next session");
    h.config(h.seatConfig(2)); h.controller.kick();
    await until(() => h.instances.length === 3 && h.instances[2].events.some(event => event.type === "room.ready"));
    assert.equal(h.instances[2].events.filter(event => event.type === "room.ready").length, 1);
    h.controller.seatingChanged(); await h.advance(200);
    assert.equal(h.instances[2].events.filter(event => event.type === "seating.snapshot").length, 0, "room.ready seeds dedupe for its own generation");
  } finally { h.controller.stop(); }
});
