import assert from "node:assert/strict";
import test from "node:test";
import { ParticipantInfo, ParticipantPermission, TrackInfo, TrackSource } from "livekit-server-sdk";
import { createUserMediaIdentity } from "@vrata/shared-types";
import { mustEvictExecutorMedia, mustEvictUserMedia, screenSourceLowering, screenSourcesRetired, verifiedSourcePeer } from "./media-source-permissions.js";

test("terminal removal is independent of source class or current screen role", () => {
  const active = { revision: 2, roomActive: true, publisherParticipantIds: ["host"], removedParticipantIds: ["removed"] };
  assert.equal(mustEvictUserMedia(active, { participantId: "removed" }), true);
  assert.equal(mustEvictUserMedia(active, { participantId: "member" }), false);
  assert.equal(mustEvictUserMedia(active, { participantId: "host" }), false);
  assert.equal(mustEvictUserMedia({ ...active, roomActive: false }, { participantId: "host" }), true);
  assert.equal(mustEvictUserMedia(null, { participantId: "member" }), true);
});

test("selected lineage evicts revoked, absent and other-epoch identities and every retired generation", () => {
  const authority = { revision: 4, roomActive: true, publisherParticipantIds: [], removedParticipantIds: [],
    participants: { current: { epoch: 2, active: true }, revoked: { epoch: 3, active: false } } };
  assert.equal(mustEvictUserMedia(authority, { participantId: "current", epoch: 2 }), false);
  assert.equal(mustEvictUserMedia(authority, { participantId: "current", epoch: 1 }), true, "recovered lineage");
  assert.equal(mustEvictUserMedia(authority, { participantId: "current", epoch: 3 }), true);
  // Codec 2 has no epoch: recovery stays indistinguishable, revocation and absence do not.
  assert.equal(mustEvictUserMedia(authority, { participantId: "current" }), false);
  assert.equal(mustEvictUserMedia(authority, { participantId: "revoked" }), true);
  assert.equal(mustEvictUserMedia(authority, { participantId: "revoked", epoch: 3 }), true);
  assert.equal(mustEvictUserMedia(authority, { participantId: "absent" }), true);
  assert.equal(mustEvictUserMedia(authority, { participantId: "toString" }), true, "no prototype lookup");
  assert.equal(mustEvictUserMedia(authority, { participantId: "current", epoch: 2 }, true), true, "retired generation");
});

test("screen lowering has one fixed permission tuple per immutable source class", () => {
  assert.equal(screenSourceLowering("m"), null);
  const ms = screenSourceLowering("ms")!, s = screenSourceLowering("s")!;
  assert.equal(ms.canPublish, true);
  assert.deepEqual(ms.canPublishSources, [TrackSource.MICROPHONE]);
  assert.equal(s.canPublish, false);
  assert.deepEqual(s.canPublishSources, []);
  for (const permission of [ms, s]) {
    assert.equal(permission.canSubscribe, true);
    assert.equal(permission.canPublishData, true);
    for (const key of ["canUpdateMetadata", "hidden", "recorder", "agent", "canSubscribeMetrics", "canManageAgentSession"] as const) assert.equal(permission[key], false);
  }
  ms.canPublishSources!.push(TrackSource.CAMERA);
  assert.deepEqual(screenSourceLowering("ms")!.canPublishSources, [TrackSource.MICROPHONE]);
});

test("source mapping requires the actual room, protected binding and standard user kind", async () => {
  for (const participantId of ["remote-browser:recovered", "界".repeat(200)]) {
    for (const scope of ["m", "s", "ms"] as const) {
      const media = await createUserMediaIdentity("owned-room", { participantId, scope });
      const peer = new ParticipantInfo({ ...media, permission: new ParticipantPermission({ canUpdateMetadata: false }) });
      assert.deepEqual(await verifiedSourcePeer("owned-room", peer), { participantId, scope });
      assert.equal(await verifiedSourcePeer("foreign-room", peer), null);
      assert.equal(await verifiedSourcePeer("owned-room", { ...peer, permission: undefined }), null);
      assert.equal(await verifiedSourcePeer("owned-room", { ...peer, permission: new ParticipantPermission({ canUpdateMetadata: true }) }), null);
      assert.equal(await verifiedSourcePeer("owned-room", { ...peer, kind: 1 }), null);
      assert.equal(await verifiedSourcePeer("owned-room", { ...peer, identity: "remote-browser:executor" }), null);
      assert.equal(await verifiedSourcePeer("owned-room", { ...peer, attributes: {} }), null);
    }
  }
});

test("native retirement requires exact full permissions and absence of every disallowed track", () => {
  for (const scope of ["s", "ms"] as const) {
    const peer = new ParticipantInfo({ permission: new ParticipantPermission(screenSourceLowering(scope)!) });
    assert.equal(screenSourcesRetired(peer, scope), true);
    assert.equal(screenSourcesRetired({ ...peer, permission: undefined }, scope), false);
    for (const source of [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO, TrackSource.CAMERA, TrackSource.UNKNOWN]) {
      assert.equal(screenSourcesRetired({ ...peer, tracks: [new TrackInfo({ source })] }, scope), false);
    }
    peer.tracks.push(new TrackInfo({ source: TrackSource.MICROPHONE }));
    assert.equal(screenSourcesRetired(peer, scope), scope === "ms");
    peer.tracks.length = 0;
    for (const key of ["canSubscribe", "canPublishData", "canUpdateMetadata", "hidden", "recorder", "agent", "canSubscribeMetrics", "canManageAgentSession", "canPublish"] as const) {
      const permission = new ParticipantPermission(screenSourceLowering(scope)!);
      permission[key] = !permission[key];
      assert.equal(screenSourcesRetired({ ...peer, permission }, scope), false);
    }
    const permission = new ParticipantPermission({ ...screenSourceLowering(scope)!, canPublishSources: [] });
    assert.equal(screenSourcesRetired({ ...peer, permission }, scope), scope === "s");
  }
  assert.equal(screenSourcesRetired(new ParticipantInfo(), "m"), false);
});

test("executor media is retired only in missing, ended and retired-generation rooms", () => {
  const active = { revision: 1, roomActive: true, roomEnded: false, publisherParticipantIds: [] };
  assert.equal(mustEvictExecutorMedia(active, false), false);
  assert.equal(mustEvictExecutorMedia({ ...active, roomActive: false }, false), false, "disable is reversible and the executor does not reconnect");
  assert.equal(mustEvictExecutorMedia({ ...active, roomActive: false, roomEnded: true }, false), true);
  assert.equal(mustEvictExecutorMedia(null, false), true, "a deleted room");
  assert.equal(mustEvictExecutorMedia(active, true), true, "a retired generation");
});
