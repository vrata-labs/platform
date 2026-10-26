import assert from "node:assert/strict";
import test from "node:test";
import { ParticipantInfo, ParticipantPermission, Room, TrackInfo, TrackSource } from "livekit-server-sdk";
import { createUserMediaIdentity } from "@vrata/shared-types";
import { roomMediaGrantName } from "./identity/media-room.js";
import { createMediaScreenReconciler, type MediaScreenAuthority } from "./media-screen-reconciler.js";
import { screenSourceLowering } from "./media-source-permissions.js";

const namespace = "a".repeat(32), prefix = "vrata-", roomId = "room", mediaRoom = roomMediaGrantName(roomId, prefix, namespace);
const incarnation = "1".repeat(32), recreated = "2".repeat(32), v3Room = roomMediaGrantName(roomId, prefix, namespace, incarnation);
async function peer(participantId: string, scope: "m" | "s" | "ms", room = mediaRoom, epoch?: number) {
  const media = await createUserMediaIdentity(room, { participantId, scope, ...(epoch === undefined ? {} : { epoch }) });
  const sources = scope === "m" ? [TrackSource.MICROPHONE] : scope === "s" ? [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]
    : [TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO];
  return new ParticipantInfo({ ...media, sid: `sid-${participantId}-${scope}`, permission: new ParticipantPermission({
    canPublish: true, canSubscribe: true, canPublishData: true, canPublishSources: sources
  }), tracks: sources.map(source => new TrackInfo({ sid: `track-${participantId}-${source}`, source })) });
}

/** Selected IDs default to active epoch-1 identities unless the desired state lists their lineage. */
function withLineage(value: MediaScreenAuthority, participantIds?: readonly string[]): MediaScreenAuthority {
  if (!value.authority || !participantIds) return value;
  const explicit = value.authority.participants;
  return { ...value, authority: { ...value.authority, participants: Object.fromEntries(participantIds.flatMap(id =>
    explicit ? (Object.hasOwn(explicit, id) ? [[id, explicit[id]]] : []) : [[id, { epoch: 1, active: true }]])) } };
}

function harness(options: Partial<Parameters<typeof createMediaScreenReconciler>[0]> = {}, codec: 2 | 3 = 2) {
  let time = 1000, contextEnabled = true;
  let desired: MediaScreenAuthority = { tenantId: "tenant", authority: { revision: 3, roomActive: true, publisherParticipantIds: ["current"] } };
  const rooms = new Map<string, ParticipantInfo[]>(), updates: Array<{ room: string; identity: string; permission: object }> = [], events: string[] = [];
  const removals: Array<{ room: string; identity: string }> = [];
  let beforeUpdate: (() => void | Promise<void>) | undefined, beforeRemove: (() => void | Promise<void>) | undefined;
  let afterRead: (() => void) | undefined, onList: ((room: string) => void | Promise<void>) | undefined;
  let listingFailed = false, writeFailed = false, preserveTracks = false, lists = 0;
  let removalFailed = false, keepRemovedPeer = false, loseRemovalAck = false;
  const native = {
    async listRooms(names?: string[]) { lists++; if (listingFailed) throw new Error("secret-url-must-not-escape");
      return [...rooms.keys()].filter(name => !names?.length || names.includes(name)).map(name => new Room({ name })); },
    async listParticipants(room: string) { await onList?.(room); return (rooms.get(room) ?? []).map(value => value.clone()); },
    async updateParticipant(room: string, identity: string, input: { permission?: Partial<ParticipantPermission> }) {
      await beforeUpdate?.();
      if (writeFailed) throw new Error("secret-token-must-not-escape");
      const current = rooms.get(room)!.find(peer => peer.identity === identity)!;
      updates.push({ room, identity, permission: structuredClone(input.permission!) });
      current.permission = new ParticipantPermission(input.permission);
      if (!preserveTracks) current.tracks = current.tracks.filter(track => current.permission!.canPublish && current.permission!.canPublishSources.includes(track.source));
      return current.clone();
    },
    async removeParticipant(room: string, identity: string) {
      await beforeRemove?.();
      if (removalFailed) throw new Error("private-removal-failure");
      removals.push({ room, identity });
      if (!keepRemovedPeer) rooms.set(room, (rooms.get(room) ?? []).filter(peer => peer.identity !== identity));
      if (loseRemovalAck) { loseRemovalAck = false; throw new Error("private-removal-ack-loss"); }
    }
  };
  const reconciler = createMediaScreenReconciler({
    now: () => time, context: async () => contextEnabled ? { namespace, codec, prefix, native } : null,
    authority: async (_roomId, participantIds) => { const value = withLineage(desired, participantIds); afterRead?.(); return value; },
    event: event => events.push(event), ...options
  });
  return { reconciler, rooms, updates, removals, events, native,
    status: (current: { namespace: string; codec: 2 | 3 } | null = { namespace, codec }) => reconciler.status(roomId, desired, current),
    setDesired: (value: MediaScreenAuthority) => { desired = value; },
    disable: () => { contextEnabled = false; }, advance: (ms: number) => { time += ms; },
    beforeUpdate: (callback: typeof beforeUpdate) => { beforeUpdate = callback; },
    beforeRemove: (callback: typeof beforeRemove) => { beforeRemove = callback; },
    onList: (callback: typeof onList) => { onList = callback; },
    /** Runs once, after the decision read of the next pass returns. */
    afterDecisionRead: (callback: () => void) => { afterRead = () => { afterRead = undefined; callback(); }; },
    failListing: (value: boolean) => { listingFailed = value; }, failWrite: (value: boolean) => { writeFailed = value; },
    failRemoval: (value: boolean) => { removalFailed = value; }, keepRemovedPeer: (value: boolean) => { keepRemovedPeer = value; },
    loseRemovalAck: () => { loseRemovalAck = true; },
    preserveTracks: (value: boolean) => { preserveTracks = value; }, listCount: () => lists };
}

test("terminal user removal disconnects every source class instead of merely lowering screen permissions", async () => {
  const h = harness();
  h.rooms.set(mediaRoom, [await peer("target", "m"), await peer("target", "s"), await peer("target", "ms")]);
  h.setDesired({ tenantId: "tenant", authority: { revision: 4, roomActive: false, publisherParticipantIds: [] } });
  await h.reconciler.runOnce();
  assert.equal(h.removals.length, 3);
  assert.equal(h.updates.length, 0);
  assert.equal(h.rooms.get(mediaRoom)!.length, 0);
  assert.equal(h.status().state, "observed");
});

test("public removal evicts only its participant and never sends a competing source update", async () => {
  const h = harness(), others = await peer("current", "m");
  h.rooms.set(mediaRoom, [await peer("removed", "m"), await peer("removed", "s"), await peer("removed", "ms"), others]);
  h.setDesired({ tenantId: "tenant", authority: { revision: 4, roomActive: true, publisherParticipantIds: ["current"], removedParticipantIds: ["removed"] } });
  await h.reconciler.runOnce();
  assert.equal(h.removals.length, 3); assert.equal(h.updates.length, 0);
  assert.deepEqual(h.rooms.get(mediaRoom)!.map(peer => peer.identity), [others.identity]);
  assert.equal(h.status().enforcementVersion, 4); assert.equal(h.status().state, "observed");
});

test("failed removal, new-SID presence and lost successful removal ACK cannot falsely acknowledge eviction", async () => {
  const h = harness(), target = await peer("removed", "m"); h.rooms.set(mediaRoom, [target]);
  h.setDesired({ tenantId: "tenant", authority: { revision: 4, roomActive: true, publisherParticipantIds: [], removedParticipantIds: ["removed"] } });
  h.failRemoval(true); await h.reconciler.runOnce(); assert.equal(h.status().state, "pending");
  h.failRemoval(false); h.keepRemovedPeer(true); h.beforeRemove(() => { target.sid = "new-rejoin-sid"; });
  await h.reconciler.runOnce(); assert.equal(h.status().state, "pending", "any still-present removed identity blocks observation, including microphone-only replacements");
  h.beforeRemove(undefined); h.keepRemovedPeer(false); h.loseRemovalAck();
  await h.reconciler.runOnce(); assert.equal(h.rooms.get(mediaRoom)!.length, 0); assert.equal(h.status().state, "pending");
  const writes = h.removals.length; await h.reconciler.runOnce(); assert.equal(h.removals.length, writes); assert.equal(h.status().state, "observed");
});

test("room re-enable racing an already sent removal is an availability event, not a success for the new desired state", async () => {
  const h = harness(), target = await peer("current", "m"); h.rooms.set(mediaRoom, [target]);
  h.setDesired({ tenantId: "tenant", authority: { revision: 3, roomActive: false, publisherParticipantIds: [], observationVersion: "disabled-row" } });
  h.beforeRemove(() => h.setDesired({ tenantId: "tenant", authority: { revision: 3, roomActive: true, publisherParticipantIds: ["current"], observationVersion: "enabled-row" } }));
  await h.reconciler.runOnce(); assert.equal(h.removals.length, 1); assert.equal(h.status().state, "pending");
  h.beforeRemove(undefined); h.rooms.set(mediaRoom, [await peer("current", "m")]);
  await h.reconciler.runOnce(); assert.equal(h.removals.length, 1); assert.equal(h.status().state, "observed");
});

test("room observation tokens and removal digests prevent cache success carrying across different room records", async () => {
  const h = harness(); h.rooms.set(mediaRoom, [await peer("current", "m")]);
  const authority = { revision: 3, roomActive: true, publisherParticipantIds: ["current"], removedParticipantIds: [], observationVersion: "old-row" };
  h.setDesired({ tenantId: "tenant", authority }); await h.reconciler.runOnce(); assert.equal(h.status().state, "observed");
  h.setDesired({ tenantId: "tenant", authority: { ...authority, observationVersion: "new-row" } });
  assert.equal(h.status().state, "pending"); await h.reconciler.runOnce(); assert.equal(h.status().state, "observed");
  h.setDesired({ tenantId: "tenant", authority: { ...authority, observationVersion: "new-row", removedParticipantIds: ["current"] } });
  assert.equal(h.status().state, "pending");
});

for (const removing of [true, false]) test(`unrelated room autosave cannot prevent ${removing ? "terminal eviction" : "screen lowering"}, but invalidates its observation`, async () => {
  const h = harness(); h.rooms.set(mediaRoom, [await peer("target", removing ? "m" : "ms")]);
  const authority = { revision: 4, roomActive: true, publisherParticipantIds: ["current"],
    removedParticipantIds: removing ? ["target"] : [], observationVersion: "before-pose-autosave" };
  h.setDesired({ tenantId: "tenant", authority });
  h.afterDecisionRead(() => h.setDesired({ tenantId: "tenant", authority: { ...authority, observationVersion: "after-pose-autosave" } }));
  await h.reconciler.runOnce();
  assert.equal(h.removals.length, removing ? 1 : 0); assert.equal(h.updates.length, removing ? 0 : 1);
  assert.equal(h.status().state, "pending", "a cache-only token change cannot be acknowledged across a native observation");
  await h.reconciler.runOnce(); assert.equal(h.status().state, "observed");
});

for (const removing of [true, false]) test(`fresh semantic authority skips an obsolete ${removing ? "removal" : "lowering"} before its native RPC`, async () => {
  const h = harness(); h.rooms.set(mediaRoom, [await peer("target", removing ? "m" : "ms")]);
  h.setDesired({ tenantId: "tenant", authority: { revision: 4, roomActive: !removing, publisherParticipantIds: ["current"], observationVersion: "old-row" } });
  h.afterDecisionRead(() => h.setDesired({ tenantId: "tenant", authority: { revision: 5, roomActive: true, publisherParticipantIds: ["target"], observationVersion: "current-row" } }));
  await h.reconciler.runOnce();
  assert.equal(h.removals.length, 0); assert.equal(h.updates.length, 0); assert.equal(h.status().state, "pending");
  await h.reconciler.runOnce();
  assert.equal(h.removals.length, 0); assert.equal(h.updates.length, 0); assert.equal(h.status().state, "observed");
});

test("terminal eviction uses the existing fair per-peer budget", async () => {
  const h = harness({ maxPeers: 1 }); h.rooms.set(mediaRoom, [await peer("removed", "m"), await peer("removed", "s"), await peer("removed", "ms")]);
  h.setDesired({ tenantId: "tenant", authority: { revision: 4, roomActive: true, publisherParticipantIds: [], removedParticipantIds: ["removed"] } });
  for (let count = 1; count <= 3; count++) {
    await h.reconciler.runOnce(); assert.equal(h.removals.length, count);
    assert.equal(h.status().state, count === 3 ? "observed" : "pending");
  }
});

test("screen reconciliation lowers only unauthorized verified source classes and observes native post-state", async () => {
  const h = harness(), ms = await peer("former", "ms"), s = await peer("former", "s"), mic = await peer("former", "m"), current = await peer("current", "ms");
  h.rooms.set(mediaRoom, [ms, s, mic, current, new ParticipantInfo({ identity: "remote-browser:executor" })]);
  const microphoneSid = ms.tracks[0].sid;
  await h.reconciler.runOnce();
  assert.equal(h.updates.length, 2);
  assert.deepEqual(h.updates.map(update => update.permission), [screenSourceLowering("ms"), screenSourceLowering("s")]);
  assert.deepEqual(ms.tracks.map(track => track.sid), [microphoneSid]);
  assert.equal(s.tracks.length, 0); assert.equal(mic.tracks.length, 1); assert.equal(current.tracks.length, 3);
  assert.equal(h.status().state, "observed");
  assert.equal(h.status({ namespace: "b".repeat(32), codec: 2 }).state, "pending", "a namespace mismatch cannot reuse a past observation");
  assert.equal(h.status({ namespace, codec: 3 }).state, "pending", "a raised codec cannot reuse a past observation");
  await h.reconciler.runOnce(); assert.equal(h.updates.length, 2, "an already retired source needs no duplicate write");
  h.advance(5001); assert.equal(h.status().state, "pending", "old observations expire");
});

test("missing native room is observed only after an independent scan and a stable authority read", async () => {
  const h = harness(); assert.equal(h.status().state, "pending");
  await h.reconciler.runOnce(); assert.deepEqual(h.status(), { enforcementVersion: 4, state: "observed", desiredVersion: { authorityRevision: 3, roomActive: true }, observedAtMs: 1000, nativeRoom: "absent" });
  h.setDesired({ tenantId: "tenant", authority: { revision: 4, roomActive: true, publisherParticipantIds: [] } });
  assert.equal(h.status().state, "pending");
});

test("frequent readers cannot starve an absent-room observation, and idle interests do not poll forever", async () => {
  const h = harness({ maxRooms: 1 });
  const desired: MediaScreenAuthority = { tenantId: "tenant", authority: { revision: 3, roomActive: true, publisherParticipantIds: ["current"] } };
  h.status(); h.reconciler.status("cold", desired, { namespace, codec: 2 }); h.status();
  await h.reconciler.runOnce(); assert.equal(h.status().state, "observed", "the repeated request did not move the hot room behind the cold room");
  await h.reconciler.runOnce();
  const lists = h.listCount();
  await h.reconciler.runOnce(); assert.equal(h.listCount(), lists + 1, "only native discovery remains, without repeated per-room absence RPCs");
});

test("an interest requested during the native absence observation survives exactly one further scan", async () => {
  const desired: MediaScreenAuthority = { tenantId: "tenant", authority: { revision: 3, roomActive: true, publisherParticipantIds: ["current"] } };
  let reads = 0;
  const h = harness({ authority: async () => { if (++reads === 1) h.status(); return desired; } });
  h.status(); await h.reconciler.runOnce(); assert.equal(h.status().state, "observed");
  const afterFirst = h.listCount();
  await h.reconciler.runOnce(); assert.equal(h.listCount(), afterFirst + 2);
  await h.reconciler.runOnce(); assert.equal(h.listCount(), afterFirst + 3);
});

test("floor-one, foreign namespaces and invalid bindings never cause native permission writes", async () => {
  const inactive = harness(); inactive.disable(); await inactive.reconciler.runOnce(); assert.equal(inactive.listCount(), 0);
  const h = harness(), foreign = roomMediaGrantName(roomId, prefix, "b".repeat(32));
  h.rooms.set(foreign, [await peer("foreign", "ms", foreign)]);
  h.rooms.set(`vrata-${roomId}`, [await peer("legacy", "ms")]);
  const forged = await peer("former", "ms"); forged.attributes = {};
  h.rooms.set(mediaRoom, [forged]); await h.reconciler.runOnce();
  assert.equal(h.updates.length, 0); assert.equal(h.removals.length, 0); assert.equal(h.status().state, "pending");
});

for (const state of ["deleted", "disabled", "ended"] as const) test(`${state} disconnects verified user media while it is absent or inactive`, async () => {
  const h = harness(), ms = await peer("current", "ms"), s = await peer("current", "s");
  h.rooms.set(mediaRoom, [ms, s]);
  h.setDesired(state === "deleted" ? { tenantId: null, authority: null }
    : { tenantId: "tenant", authority: { revision: state === "ended" ? 4 : 3, roomActive: false, publisherParticipantIds: [] } });
  await h.reconciler.runOnce();
  assert.equal(h.removals.length, 2); assert.equal(h.updates.length, 0); assert.equal(h.rooms.get(mediaRoom)!.length, 0);
  assert.equal(h.status().state, "observed");
});

test("partial writes, lost acknowledgements and remaining native tracks remain pending until independently observed", async () => {
  const h = harness(), ms = await peer("former", "ms"); h.rooms.set(mediaRoom, [ms]);
  h.failWrite(true); await h.reconciler.runOnce(); assert.equal(h.status().state, "pending");
  h.failWrite(false); h.preserveTracks(true); await h.reconciler.runOnce(); assert.equal(h.status().state, "pending");
  h.preserveTracks(false); await h.reconciler.runOnce(); assert.equal(h.status().state, "observed");
  h.failListing(true); await h.reconciler.runOnce(); assert.equal(h.status().state, "unavailable");
  h.failListing(false); await h.reconciler.runOnce(); assert.equal(h.status().state, "observed");
});

test("a concurrent authority change or same-identity replacement cannot be acknowledged as an applied new revision", async () => {
  const h = harness(), ms = await peer("former", "ms"); h.rooms.set(mediaRoom, [ms]);
  h.beforeUpdate(() => {
    ms.sid = "replacement-sid";
    h.setDesired({ tenantId: "tenant", authority: { revision: 4, roomActive: true, publisherParticipantIds: ["former"] } });
  });
  await h.reconciler.runOnce();
  assert.equal(h.status().state, "pending"); assert.deepEqual(h.updates[0].permission, screenSourceLowering("ms"));
  assert.deepEqual(ms.permission!.canPublishSources, [TrackSource.MICROPHONE], "stale lowering may restrict a new same-class grant, never widen its credential");
  h.beforeUpdate(undefined); await h.reconciler.runOnce(); assert.equal(h.status().state, "observed");
});

test("new broad peers arriving during a pass are caught by the full native post-read", async () => {
  const h = harness(), first = await peer("former", "ms"), late = await peer("late", "ms"); h.rooms.set(mediaRoom, [first]);
  h.beforeUpdate(() => { if (!h.rooms.get(mediaRoom)!.includes(late)) h.rooms.get(mediaRoom)!.push(late); });
  await h.reconciler.runOnce(); assert.equal(h.status().state, "pending");
  await h.reconciler.runOnce(); assert.equal(h.status().state, "observed");
});

test("fair peer budgets continue past failures and never acknowledge an incomplete room", async () => {
  const h = harness({ maxPeers: 1 }); h.rooms.set(mediaRoom, [await peer("first", "ms"), await peer("second", "s")]);
  await h.reconciler.runOnce(); assert.equal(h.updates.length, 1); assert.equal(h.status().state, "pending");
  await h.reconciler.runOnce(); assert.equal(h.updates.length, 2); assert.equal(h.status().state, "pending");
});

test("same-revision lifecycle and authorized-ID changes invalidate a native observation", async () => {
  const h = harness(), ms = await peer("former", "ms"); h.rooms.set(mediaRoom, [ms]);
  await h.reconciler.runOnce(); assert.equal(h.status().state, "observed");
  h.setDesired({ tenantId: "tenant", authority: { revision: 3, roomActive: false, publisherParticipantIds: [] } });
  assert.equal(h.status().state, "pending"); await h.reconciler.runOnce(); assert.equal(h.status().state, "observed");
  h.setDesired({ tenantId: "tenant", authority: { revision: 3, roomActive: true, publisherParticipantIds: ["former"] } });
  assert.equal(h.status().state, "pending");
});

test("fair room limits and exhausted time budgets preserve pending state without starving the next room", async () => {
  const h = harness({ maxRooms: 1, passBudgetMs: 10 });
  const secondRoom = roomMediaGrantName("second-room", prefix, namespace);
  h.rooms.set(mediaRoom, [await peer("first", "ms")]); h.rooms.set(secondRoom, [await peer("second", "s", secondRoom)]);
  h.beforeUpdate(() => { h.advance(11); });
  await h.reconciler.runOnce(); assert.equal(h.status().state, "pending"); assert.equal(h.updates.length, 1);
  h.beforeUpdate(undefined); await h.reconciler.runOnce(); assert.equal(h.updates.length, 2);
  assert.equal(h.updates[1].room, secondRoom);
});

test("authority errors fail closed without any native permission write", async () => {
  const h = harness({ authority: async () => { throw new Error("private-database-error"); } });
  h.rooms.set(mediaRoom, [await peer("former", "ms")]); await h.reconciler.runOnce();
  assert.equal(h.updates.length, 0); assert.equal(h.status().state, "pending");
});

test("diagnostic callback exceptions cannot interrupt lowering or its native post-observation", async () => {
  const h = harness({ event: () => { throw new Error("private-observer-error"); } });
  h.rooms.set(mediaRoom, [await peer("former", "ms")]); await h.reconciler.runOnce();
  assert.equal(h.updates.length, 1); assert.equal(h.status().state, "observed");
});

test("single-flight and shutdown prevent a late response from scheduling writes or restoring an observation", async () => {
  const h = harness(), ms = await peer("former", "ms"); h.rooms.set(mediaRoom, [ms]);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  h.beforeUpdate(async () => { entered(); await gate; });
  const first = h.reconciler.runOnce(); assert.equal(h.reconciler.runOnce(), first); await ready;
  h.reconciler.stop(); release(); await first;
  assert.equal(h.updates.length, 1, "an already sent RPC cannot be cancelled retroactively");
  assert.equal(h.status().state, "pending");
  await h.reconciler.runOnce(); assert.equal(h.updates.length, 1);
});

test("stop/start during an in-flight pass leaves exactly one scheduler chain", async t => {
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  t.mock.method(globalThis, "setTimeout", ((callback: () => void) => {
    const timer = { unref() {} } as ReturnType<typeof setTimeout>;
    timers.set(timer, callback); return timer;
  }) as typeof setTimeout);
  t.mock.method(globalThis, "clearTimeout", (timer: Parameters<typeof clearTimeout>[0]) => { timers.delete(timer as ReturnType<typeof setTimeout>); });
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  const h = harness({ context: async () => { await gate; return null; } });
  h.reconciler.start(); const first = h.reconciler.runOnce();
  h.reconciler.stop(); h.reconciler.start(); release(); await first;
  assert.equal(timers.size, 1);
  const [timer, callback] = timers.entries().next().value!;
  timers.delete(timer); callback(); await h.reconciler.runOnce();
  assert.equal(timers.size, 1);
  h.reconciler.stop(); assert.equal(timers.size, 0);
});

test("codec 3 evicts the pre-recovery lineage of a participant and keeps the recovered connection", async () => {
  const h = harness({}, 3), old = await peer("host", "ms", v3Room, 1), recovered = await peer("host", "ms", v3Room, 2), other = await peer("member", "m", v3Room, 1);
  h.rooms.set(v3Room, [old, recovered, other]);
  h.setDesired({ tenantId: "tenant", authority: { revision: 6, roomActive: true, publisherParticipantIds: ["host"], mediaIncarnation: incarnation,
    participants: { host: { epoch: 2, active: true }, member: { epoch: 1, active: true } } } });
  await h.reconciler.runOnce();
  assert.deepEqual(h.removals, [{ room: v3Room, identity: old.identity }]);
  assert.deepEqual(h.rooms.get(v3Room)!.map(value => value.identity).sort(), [recovered.identity, other.identity].sort());
  assert.equal(h.updates.length, 0); assert.equal(h.status().state, "observed");
  // A cached JWT of the old lineage rejoins: the next pass removes it again, never the recovered address.
  h.rooms.get(v3Room)!.push(await peer("host", "ms", v3Room, 1));
  await h.reconciler.runOnce();
  assert.deepEqual(h.removals.map(value => value.identity), [old.identity, old.identity]);
});

test("revoked and absent identities are evicted even without a public removal or codec-3 epoch", async () => {
  const h = harness(), revoked = await peer("revoked", "m"), absent = await peer("absent", "s"), current = await peer("current", "m");
  h.rooms.set(mediaRoom, [revoked, absent, current]);
  h.setDesired({ tenantId: "tenant", authority: { revision: 5, roomActive: true, publisherParticipantIds: [], removedParticipantIds: [],
    participants: { revoked: { epoch: 2, active: false }, current: { epoch: 1, active: true } } } });
  await h.reconciler.runOnce();
  assert.deepEqual(h.removals.map(value => value.identity).sort(), [revoked.identity, absent.identity].sort());
  assert.equal(h.updates.length, 0); assert.equal(h.status().state, "observed");
});

test("a lineage read without the selected participants fails closed as pending", async () => {
  const desired: MediaScreenAuthority = { tenantId: "tenant", authority: { revision: 3, roomActive: true, publisherParticipantIds: [] } };
  const h = harness({ authority: async () => desired });
  h.rooms.set(mediaRoom, [await peer("removed", "m")]);
  await h.reconciler.runOnce();
  assert.equal(h.removals.length, 0); assert.equal(h.status().state, "pending");
});

test("a recovery between the decision read and the RPC skips the obsolete eviction", async () => {
  const h = harness({}, 3), target = await peer("host", "m", v3Room, 1);
  h.rooms.set(v3Room, [target]);
  const authority = { revision: 6, roomActive: true, publisherParticipantIds: [], mediaIncarnation: incarnation };
  h.setDesired({ tenantId: "tenant", authority: { ...authority, participants: { host: { epoch: 2, active: true } } } });
  h.afterDecisionRead(() => h.setDesired({ tenantId: "tenant", authority: { ...authority, revision: 7, participants: { host: { epoch: 3, active: true } } } }));
  await h.reconciler.runOnce();
  assert.equal(h.removals.length, 0); assert.equal(h.status().state, "pending");
  await h.reconciler.runOnce(); assert.equal(h.removals.length, 1); assert.equal(h.status().state, "observed");
});

test("after the codec-3 boundary every codec-2 room is retired and blocks the room's observation until it is empty", async () => {
  const h = harness({ maxRooms: 1 }, 3);
  h.rooms.set(mediaRoom, [await peer("current", "m"), await peer("current", "ms"), new ParticipantInfo({ identity: "remote-browser:executor" })]);
  h.rooms.set(v3Room, [await peer("current", "ms", v3Room, 1)]);
  h.setDesired({ tenantId: "tenant", authority: { revision: 3, roomActive: true, publisherParticipantIds: ["current"], mediaIncarnation: incarnation } });
  // Rooms are visited in name order; the codec-3 room first, while the codec-2 sibling still has users.
  assert.ok(v3Room.localeCompare(mediaRoom) > 0);
  await h.reconciler.runOnce(); assert.equal(h.removals.length, 3, "both codec-2 grants and the executor of the retired room");
  assert.equal(h.status().state, "pending", "a retired generation is swept, not observed");
  await h.reconciler.runOnce(); assert.equal(h.status().state, "observed");
  assert.deepEqual(h.removals.map(value => value.room), [mediaRoom, mediaRoom, mediaRoom]);
  assert.ok(h.removals.some(value => value.identity === "remote-browser:executor"));
  assert.equal(h.rooms.get(v3Room)!.length, 1);
});

test("a recreated room retires connections of the previous incarnation without touching the current one", async () => {
  const h = harness({}, 3), previous = roomMediaGrantName(roomId, prefix, namespace, recreated);
  const stale = await peer("current", "ms", previous, 1), current = await peer("current", "ms", v3Room, 1);
  h.rooms.set(previous, [stale]); h.rooms.set(v3Room, [current]);
  h.setDesired({ tenantId: "tenant", authority: { revision: 0, roomActive: true, publisherParticipantIds: ["current"], mediaIncarnation: incarnation } });
  await h.reconciler.runOnce();
  assert.deepEqual(h.removals, [{ room: previous, identity: stale.identity }]);
  await h.reconciler.runOnce(); assert.equal(h.status().state, "observed");
  // Deleted entirely: both generations are retired.
  h.setDesired({ tenantId: null, authority: null }); await h.reconciler.runOnce();
  assert.deepEqual(h.removals.map(value => value.identity), [stale.identity, current.identity]);
});

test("a binding of the other codec in a room name is unverified and never written", async () => {
  const h = harness({}, 3), forged = await peer("current", "ms", v3Room);
  h.rooms.set(v3Room, [forged]);
  h.setDesired({ tenantId: "tenant", authority: { revision: 3, roomActive: false, publisherParticipantIds: [], mediaIncarnation: incarnation } });
  await h.reconciler.runOnce();
  assert.equal(h.removals.length, 0); assert.equal(h.updates.length, 0); assert.equal(h.status().state, "pending");
});

test("a retired generation created during the pass is found by the post-read and blocks the observation", async () => {
  const h = harness({}, 3);
  h.rooms.set(v3Room, [await peer("current", "m", v3Room, 1)]);
  h.setDesired({ tenantId: "tenant", authority: { revision: 3, roomActive: true, publisherParticipantIds: [], mediaIncarnation: incarnation } });
  let lists = 0;
  h.onList(async room => { if (room === v3Room && ++lists === 2) h.rooms.set(mediaRoom, [await peer("current", "m")]); });
  await h.reconciler.runOnce();
  assert.equal(h.status().state, "pending", "the codec-2 connection existed before the claimed observation time");
  h.onList(undefined);
  await h.reconciler.runOnce(); assert.deepEqual(h.removals.map(value => value.room), [mediaRoom]);
  await h.reconciler.runOnce(); assert.equal(h.status().state, "observed");
});

test("a retired generation with a user beyond the selected portion invalidates the current observation", async () => {
  const h = harness({ maxRooms: 1, maxPeers: 1 }, 3);
  h.rooms.set(v3Room, [await peer("current", "m", v3Room, 1)]);
  h.setDesired({ tenantId: "tenant", authority: { revision: 3, roomActive: true, publisherParticipantIds: [], mediaIncarnation: incarnation } });
  await h.reconciler.runOnce(); assert.equal(h.status().state, "observed");
  // The executor sorts first and fills the one-peer portion; the user is outside it.
  h.rooms.set(mediaRoom, [new ParticipantInfo({ identity: "remote-browser:executor" }), await peer("current", "ms")]);
  await h.reconciler.runOnce();
  assert.deepEqual(h.removals.map(value => value.identity), ["remote-browser:executor"], "only the selected portion is swept this pass");
  assert.equal(h.status().state, "pending");
});

test("a participant ID spelled __proto__ is an ordinary lineage key", async () => {
  const h = harness({}, 3), target = await peer("__proto__", "m", v3Room, 2);
  h.rooms.set(v3Room, [target]);
  h.setDesired({ tenantId: "tenant", authority: { revision: 3, roomActive: true, publisherParticipantIds: [], mediaIncarnation: incarnation,
    participants: Object.fromEntries([["__proto__", { epoch: 2, active: true }]]) } });
  await h.reconciler.runOnce();
  assert.equal(h.removals.length, 0); assert.equal(h.status().state, "observed");
});

test("a portal-managed epoch room is reconciled against its platform room, not an unknown room id", async () => {
  const accessEpoch = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f", epochRoom = `${mediaRoom}:${accessEpoch}`;
  const asked: string[] = [];
  const desired: MediaScreenAuthority = { tenantId: "tenant", accessEpoch,
    authority: { revision: 4, roomActive: true, publisherParticipantIds: ["current"], removedParticipantIds: ["removed"] } };
  const h = harness({ authority: async (id: string, participantIds?: readonly string[]) => { asked.push(id); return withLineage(desired, participantIds); } });
  const kept = await peer("current", "m", epochRoom);
  h.rooms.set(epochRoom, [await peer("removed", "m", epochRoom), kept]);
  await h.reconciler.runOnce();
  assert(asked.length > 0 && asked.every(id => id === roomId), JSON.stringify(asked));
  assert.deepEqual(h.removals.map(removal => removal.room), [epochRoom]);
  assert.deepEqual(h.rooms.get(epochRoom)!.map(value => value.identity), [kept.identity]);
});

test("a portal-managed room's previous access epoch is a retired generation; the current epoch is kept", async () => {
  const previous = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f", current = "7a1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
  const h = harness({}, 3), oldRoom = `${v3Room}:${previous}`, currentRoom = `${v3Room}:${current}`;
  const stale = await peer("current", "m", oldRoom, 1), kept = await peer("current", "m", currentRoom, 1);
  h.rooms.set(oldRoom, [stale]); h.rooms.set(currentRoom, [kept]);
  h.setDesired({ tenantId: "tenant", accessEpoch: current,
    authority: { revision: 3, roomActive: true, publisherParticipantIds: [], mediaIncarnation: incarnation } });
  await h.reconciler.runOnce();
  assert.deepEqual(h.removals, [{ room: oldRoom, identity: stale.identity }]);
  await h.reconciler.runOnce(); assert.equal(h.status().state, "observed");
  assert.deepEqual(h.rooms.get(currentRoom)!.map(value => value.identity), [kept.identity]);
});

for (const state of ["deleted", "ended", "retired"] as const) test(`a remote-browser executor in a ${state} room is retired`, async () => {
  const h = harness({}, state === "retired" ? 3 : 2), executor = new ParticipantInfo({ identity: "remote-browser:object-1" });
  h.rooms.set(mediaRoom, [executor]);
  h.setDesired(state === "deleted" ? { tenantId: null, authority: null }
    : { tenantId: "tenant", authority: { revision: 4, roomActive: state !== "ended", roomEnded: state === "ended", publisherParticipantIds: [],
      mediaIncarnation: incarnation } });
  await h.reconciler.runOnce();
  assert.deepEqual(h.removals, [{ room: mediaRoom, identity: executor.identity }]);
  if (state !== "retired") { await h.reconciler.runOnce(); assert.equal(h.status().state, "observed"); }
});

test("a disabled room and a current active room keep their executor", async () => {
  const h = harness(), executor = new ParticipantInfo({ identity: "remote-browser:object-1" });
  h.rooms.set(mediaRoom, [executor, await peer("member", "m")]);
  h.setDesired({ tenantId: "tenant", authority: { revision: 4, roomActive: false, roomEnded: false, publisherParticipantIds: [] } });
  await h.reconciler.runOnce();
  assert.deepEqual(h.removals.map(value => value.identity), [(await peer("member", "m")).identity], "users leave a disabled room; its executor stays");
  h.setDesired({ tenantId: "tenant", authority: { revision: 5, roomActive: true, roomEnded: false, publisherParticipantIds: [] } });
  await h.reconciler.runOnce(); await h.reconciler.runOnce();
  assert.equal(h.removals.length, 1); assert.equal(h.status().state, "observed");
});

test("an ended room is not observed while its executor survives a failed removal", async () => {
  const h = harness(), executor = new ParticipantInfo({ identity: "remote-browser:object-1" });
  h.rooms.set(mediaRoom, [executor]);
  h.setDesired({ tenantId: "tenant", authority: { revision: 4, roomActive: false, roomEnded: true, publisherParticipantIds: [] } });
  h.failRemoval(true); await h.reconciler.runOnce(); assert.equal(h.status().state, "pending");
  h.failRemoval(false); await h.reconciler.runOnce(); await h.reconciler.runOnce();
  assert.equal(h.removals.length, 1); assert.equal(h.status().state, "observed");
});
