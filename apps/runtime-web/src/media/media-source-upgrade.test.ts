import assert from "node:assert/strict";
import test from "node:test";
import { createMediaSourceUpgrade, permitsScreenShare } from "./media-source-upgrade.js";
import { createMediaActionBarrier } from "./media-action-barrier.js";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
function fixture(initialShare = false) {
  type Room = { id: number; share: boolean };
  let current: Room | null = { id: 1, share: initialShare }, id = 1, active = true, joined = true, muted = false;
  const events: string[] = [];
  const gates = { prepare: async () => {}, connect: async () => {}, retire: async () => {}, dispose: async () => {}, restore: async () => {} };
  const controller = createMediaSourceUpgrade<Room, boolean>({
    current: () => current,
    ensureBase: async () => { events.push("base"); assert.ok(current); return current; },
    permitsShare: room => room.share,
    assertActive: () => { if (!active) throw new Error("blocked"); },
    prepare: async share => { events.push(`prepare:${share}`); await gates.prepare(); return share; },
    create: () => ({ id: ++id, share: false }),
    retire: async room => { events.push(`retire:${room.id}`); current = null; await gates.retire(); events.push("retired"); },
    connect: async (room, share) => { events.push(`connect:${room.id}:${share}`); await gates.connect(); room.share = share; },
    install: room => { events.push(`install:${room.id}`); current = room; },
    dispose: async room => { events.push(`dispose:${room.id}`); if (current === room) current = null; await gates.dispose(); },
    restoreMicrophone: async () => { events.push(`mic:${joined}:${muted}`); await gates.restore(); },
    transition: value => { events.push(`transition:${value}`); },
    recoveryFailed: () => { events.push("recovery-failed"); joined = false; },
    invalidatedError: () => new Error("invalidated")
  });
  return { controller, events, gates, current: () => current,
    block: () => { active = false; controller.invalidate(); }, mute: () => { muted = true; }, leave: () => { joined = false; } };
}

test("confirmed scoped permissions and legacy all-source lists are distinguished", () => {
  assert.equal(permitsScreenShare(undefined), false);
  assert.equal(permitsScreenShare({ canPublish: false, canPublishSources: [] }), false);
  for (const sources of [undefined, [], ["microphone", "screen_share", "screen_share_audio"]]) {
    assert.equal(permitsScreenShare({ canPublish: true, canPublishSources: sources }), true);
  }
  for (const sources of [["microphone"], ["camera"], ["screen_share"], ["screen_share_audio"]]) {
    assert.equal(permitsScreenShare({ canPublish: true, canPublishSources: sources }), false);
  }
});

test("Host sharing and microphone reuse never reconnect an already scoped room", async () => {
  const f = fixture(true), room = f.current();
  assert.equal(await f.controller.ensure(true), room);
  assert.equal(await f.controller.ensure(), room);
  assert.deepEqual(f.events, ["base", "base"]);
});

test("promotion prepares before retirement, awaits disconnect and coalesces passive and sharing callers", async () => {
  const f = fixture(), prepared = deferred(), retired = deferred();
  f.gates.prepare = () => prepared.promise; f.gates.retire = () => retired.promise;
  const share = f.controller.ensure(true);
  await new Promise(resolve => setImmediate(resolve));
  const passive = f.controller.ensure(), secondShare = f.controller.ensure(true);
  assert.equal(f.current()?.id, 1);
  prepared.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.current(), null);
  assert.equal(f.events.some(event => event.startsWith("connect:")), false);
  retired.resolve();
  const rooms = await Promise.all([share, passive, secondShare]);
  assert.ok(rooms.every(room => room === rooms[0]));
  assert.deepEqual(f.events, ["base", "transition:true", "prepare:true", "retire:1", "retired", "connect:2:true", "install:2", "mic:true:false", "transition:false"]);
});

test("a denied token leaves the original microphone connection and passive consumers untouched", async () => {
  const f = fixture(), original = f.current();
  f.gates.prepare = async () => { throw new Error("denied"); };
  await assert.rejects(f.controller.ensure(true), /denied/);
  assert.equal(f.current(), original);
  assert.equal(await f.controller.ensure(), original);
  assert.equal(f.events.some(event => event.startsWith("retire:")), false);
});

for (const phase of ["prepare", "connect", "restore"] as const) test(`block during ${phase} never delivers a late media connection`, async () => {
  const f = fixture(), gate = deferred();
  f.gates[phase] = () => gate.promise;
  const result = f.controller.ensure(true);
  await new Promise(resolve => setImmediate(resolve));
  f.block(); gate.resolve();
  await assert.rejects(result, /blocked|invalidated/);
  assert.equal(f.events.includes("prepare:false"), false);
  if (phase !== "prepare") assert.equal(f.current(), null);
});

test("restored microphone follows live mute/leave intent rather than an earlier snapshot", async () => {
  for (const leave of [false, true]) {
    const f = fixture(), gate = deferred(); f.gates.connect = () => gate.promise;
    const pending = f.controller.ensure(true);
    await new Promise(resolve => setImmediate(resolve));
    if (leave) f.leave(); else f.mute();
    gate.resolve(); await pending;
    assert.ok(f.events.includes(leave ? "mic:false:false" : "mic:true:true"));
  }
});

test("failed upgrade makes one microphone-only recovery after candidate cleanup, while share still fails", async () => {
  const f = fixture(); let calls = 0;
  f.gates.connect = async () => { if (++calls === 1) throw new Error("connect_failed"); };
  await assert.rejects(f.controller.ensure(true), /connect_failed/);
  assert.equal(f.current()?.id, 3); assert.equal(f.current()?.share, false);
  assert.ok(f.events.indexOf("dispose:2") < f.events.indexOf("prepare:false"));
  assert.equal(f.events.filter(event => event === "prepare:false").length, 1);
  assert.equal(await f.controller.ensure(), f.current());
});

test("unconfirmed candidate cleanup prevents a duplicate-identity recovery attempt", async () => {
  const f = fixture(); f.gates.connect = async () => { throw new Error("connect_failed"); };
  f.gates.dispose = async () => { throw new Error("disconnect_failed"); };
  await assert.rejects(f.controller.ensure(true), /media_upgrade_cleanup_failed/);
  assert.equal(f.events.includes("prepare:false"), false);
  assert.ok(f.events.includes("recovery-failed"));
});

test("source upgrade cannot retire a room while its admitted microphone action is still publishing", async () => {
  const barrier = createMediaActionBarrier(), gate = deferred(), reached = deferred();
  let current: number | null = 1, microphone = false;
  const events: string[] = [];
  const audio = barrier.run(async () => { await gate.promise; microphone = true; events.push("mic-published"); });
  const controller = createMediaSourceUpgrade<number, boolean>({
    current: () => current, ensureBase: async () => 1, permitsShare: room => room === 2, assertActive: () => {},
    prepare: async () => true, create: () => 2,
    retire: async () => { reached.resolve(); await barrier.settled(); current = null; events.push("retired"); },
    connect: async () => { events.push("connected"); }, install: room => { current = room; },
    dispose: async () => {}, restoreMicrophone: async () => { assert.equal(microphone, true); events.push("mic-restored"); },
    transition: () => {}, recoveryFailed: () => {}, invalidatedError: () => new Error("invalidated")
  });
  const upgraded = controller.ensure(true); await reached.promise;
  assert.equal(current, 1); assert.deepEqual(events, []);
  gate.resolve(); await audio; assert.equal(await upgraded, 2);
  assert.deepEqual(events, ["mic-published", "retired", "connected", "mic-restored"]);
});
