import assert from "node:assert/strict";
import test from "node:test";
import { createUserMediaIdentity } from "@vrata/shared-types";
import { createMediaParticipantResolver, planRemoteMicrophones, sameMicrophoneOwner, selectRemoteMicrophones } from "./media-participant.js";
import type { RemoteParticipant, Track } from "livekit-client";

test("media peer mapping verifies its room and preserves recovered executor-looking IDs as users", async () => {
  let done!: () => void;
  const ready = new Promise<void>(resolve => { done = resolve; });
  const resolvePeer = createMediaParticipantResolver(done);
  const binding = await createUserMediaIdentity("room", { participantId: "remote-browser:recovered", scope: "ms" });
  const peer = { ...binding, kind: 0 };
  assert.equal(resolvePeer(peer, "room", 2), null);
  await ready;
  assert.deepEqual(resolvePeer(peer, "room", 2), { kind: "user", participantId: "remote-browser:recovered", scope: "ms", mediaIdentity: binding.identity });
  assert.equal(resolvePeer(peer, "another-room", 2), null);
  assert.equal(resolvePeer({ ...peer, kind: 1 }, "room", 2), null);
  assert.equal(resolvePeer({ ...peer, attributes: {} }, "room", 2), null);
  assert.deepEqual(resolvePeer({ identity: "remote-browser:executor", kind: 0, attributes: {} }, "room", 2),
    { kind: "executor", mediaIdentity: "remote-browser:executor" });
  assert.equal(resolvePeer({ identity: "legacy", kind: 0, attributes: {} }, "room", 2), null);
  assert.equal(resolvePeer({ identity: "legacy", kind: 0, attributes: {} }, "room", null)?.kind, "user");
});

test("late verification of changed peer attributes cannot restore an earlier mapping", async () => {
  let callbacks = 0;
  const resolvePeer = createMediaParticipantResolver(() => { callbacks++; });
  const original = await createUserMediaIdentity("room", { participantId: "p", scope: "m" });
  const peer = { ...original, kind: 0 };
  resolvePeer(peer, "room", 2);
  peer.attributes = { vrataMediaBinding: "invalid" };
  resolvePeer(peer, "room", 2);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(resolvePeer(peer, "room", 2), null);
  assert.equal(callbacks, 0);
});

test("M to MS overlap has one microphone, no self echo and no old-source cleanup of its replacement", () => {
  const m = { participantId: "remote", mediaIdentity: "m", trackKey: "track-old", scope: "m" as const, value: 1 };
  const ms = { participantId: "remote", mediaIdentity: "ms", trackKey: "track-new", scope: "ms" as const, value: 2 };
  const s = { participantId: "remote", mediaIdentity: "s", trackKey: "screen-audio", scope: "s" as const, value: 3 };
  const own = { ...m, participantId: "self" };
  const active = new Set(["remote", "self"]);
  assert.equal(selectRemoteMicrophones([m], "self", active).get("remote"), m);
  assert.deepEqual([...selectRemoteMicrophones([own, s, m, ms], "self", active).values()], [ms]);
  assert.deepEqual([...selectRemoteMicrophones([ms, m], "self", active).values()], [ms]);
  assert.deepEqual([...selectRemoteMicrophones([ms], "self", active).values()], [ms]);
  const track = {}, current = { ...ms, track };
  assert.equal(sameMicrophoneOwner(current, { ...m, track }), false);
  assert.equal(sameMicrophoneOwner(current, { ...current, trackKey: "new-sid" }), false);
  assert.equal(sameMicrophoneOwner(current, { ...current, track: {} }), false);
  assert.equal(sameMicrophoneOwner(current, { ...current }), true);
  assert.equal(selectRemoteMicrophones([m, ms], "self", new Set()).size, 0);
});

test("unsubscribe excludes the outgoing Track before LiveKit clears the publication", () => {
  const track = { kind: "audio" } as Track;
  const publication = { track, isMuted: false, source: "microphone", trackSid: "same-sid" };
  const peer = { identity: "media", attributes: {}, kind: 0, trackPublications: new Map([["same-sid", publication]]) } as unknown as RemoteParticipant;
  const resolve = () => ({ kind: "user" as const, participantId: "remote", mediaIdentity: "media", scope: "ms" as const });
  const active = new Set(["remote"]);
  assert.equal(planRemoteMicrophones([peer], resolve, "self", active).size, 1);
  assert.equal(planRemoteMicrophones([peer], resolve, "self", active, track).size, 0);
  publication.track = { kind: "audio" } as Track;
  assert.equal(planRemoteMicrophones([peer], resolve, "self", active, track).get("remote")?.value.track, publication.track);
});

test("codec-3 peers resolve with their epoch, and a recovered lineage is heard over the old one", async () => {
  let done!: () => void;
  const ready = new Promise<void>(resolve => { done = resolve; });
  const resolvePeer = createMediaParticipantResolver(done);
  const room = "v3:namespace:incarnation:room";
  const media = await createUserMediaIdentity(room, { participantId: "p", scope: "ms", epoch: 4 });
  const peer = { ...media, kind: 0 };
  assert.equal(resolvePeer(peer, room, 2), null);
  await ready;
  assert.deepEqual(resolvePeer(peer, room, 2), { kind: "user", participantId: "p", scope: "ms", epoch: 4, mediaIdentity: media.identity });
  assert.equal(resolvePeer(peer, "v3:namespace:other:room", 2), null);
  const old = { participantId: "p", mediaIdentity: "a-old", trackKey: "old", scope: "ms" as const, epoch: 3, value: 1 };
  const recovered = { participantId: "p", mediaIdentity: "z-new", trackKey: "new", scope: "m" as const, epoch: 4, value: 2 };
  const active = new Set(["p"]);
  assert.deepEqual([...selectRemoteMicrophones([old, recovered], "self", active).values()], [recovered]);
  assert.deepEqual([...selectRemoteMicrophones([recovered, old], "self", active).values()], [recovered]);
});
