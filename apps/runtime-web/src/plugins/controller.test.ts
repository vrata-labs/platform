import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createRoomPluginArtifact } from "@vrata/room-plugin-sdk/artifact";
import type { RoomPluginEvent, RoomPluginRequest } from "@vrata/room-plugin-sdk";
import { RoomPluginController, type RoomPluginCoreContext, type RoomPluginInstance, type RoomPluginSeatingHost } from "./controller.js";
import { parseRoomPluginRuntimeSnapshot, roomPluginContentPath, type RoomPluginRuntimeSnapshot } from "./runtime-dto.js";
import type { RoomPluginStatusRow } from "./status-view.js";
import { SandboxError } from "./limits.js";
import { RoomPluginHttpError } from "./http.js";

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
  const renderings: RoomPluginStatusRow[][] = [];
  let pendingSnapshot: (() => Promise<RoomPluginRuntimeSnapshot>) | null = null;
  let pendingContent: (() => Promise<Uint8Array>) | null = null;
  let pendingStart: (() => Promise<Instance>) | null = null;
  const controller = new RoomPluginController({ apiBaseUrl: "https://app.invalid", roomId: "room", context: () => context, seating,
    proof: () => ({ token: "native-private-token", deadlineMs: 900_000 }), clock: () => now,
    timers: { schedule(callback, ms) { const handle = ++id; timers.set(handle, { at: now + ms, callback }); return handle; }, cancel(handle) { timers.delete(handle as number); } },
    http: { async snapshot() { counters.snapshots++; return pendingSnapshot ? pendingSnapshot() : current; },
      async content() { counters.contents++; return pendingContent ? pendingContent() : content; } },
    async start(source, config, _caps, dispatch, signal) {
      counters.starts++; dispatches.push(dispatch);
      assert.equal(source, artifact.artifact.entry); assert.equal(signal.aborted, false);
      if (startsError) throw startsError;
      if (pendingStart) return pendingStart();
      assert.equal((dispatch({ sdkApiVersion: 1, requestId: "1", operation: "status.set", payload: { text: String(config.greeting) } }, new AbortController().signal) as { ok: boolean }).ok, true);
      const instance = new Instance(); instances.push(instance); return instance;
    },
    render(rows) { renderings.push(rows.map(row => ({ ...row }))); }
  });
  return { controller, counters, context, instances, dispatches, renderings,
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
  assert.equal((h.dispatches[0]({ sdkApiVersion: 1, requestId: "2", operation: "status.set", payload: { text: "expired" } }, new AbortController().signal) as { ok: boolean }).ok, false);
  release(snapshot()); await until(() => h.controller.diagnostics().running === 1); assert.equal(h.counters.starts, 1); h.controller.stop();
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
  const host: RoomPluginSeatingHost = {
    supported: () => supported, ready: () => ready, activate: () => { calls.push("activate"); },
    snapshot: (owner, seating) => { calls.push(`snapshot:${seating}`); return { ownParticipantAlias: "alias", arrivalAllowed: seating, seats: [] }; },
    port: owner => { calls.push("port"); return { claim: async () => ({ result: "busy" }), cancel: () => undefined }; },
    retire: owner => { calls.push("retire"); }
  };
  return { host, calls, capabilities, setReady(value: boolean) { ready = value; }, setSupported(value: boolean) { supported = value; } };
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
  for (let i = 0; i < 5; i++) h.controller.seatingChanged();
  await h.advance(100); await until(() => h.instances[0].events.length === 3);
  assert.equal(h.instances[0].events[2].type, "seating.snapshot");
  await h.advance(300); await delay(5); assert.equal(h.instances[0].events.length, 3, "five changes produced one snapshot");
  h.controller.stop();
  assert.ok(s.calls.includes("retire"));
});
