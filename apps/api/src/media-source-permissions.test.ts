import assert from "node:assert/strict";
import test from "node:test";
import { ParticipantInfo, ParticipantPermission, TrackInfo, TrackSource } from "livekit-server-sdk";
import { createUserMediaIdentity } from "@vrata/shared-types";
import { mustEvictUserMedia, screenSourceLowering, screenSourcesRetired, verifiedSourcePeer } from "./media-source-permissions.js";

test("terminal removal is independent of source class or current screen role", () => {
  const active = { revision: 2, roomActive: true, publisherParticipantIds: ["host"], removedParticipantIds: ["removed"] };
  assert.equal(mustEvictUserMedia(active, "removed"), true);
  assert.equal(mustEvictUserMedia(active, "member"), false);
  assert.equal(mustEvictUserMedia(active, "host"), false);
  assert.equal(mustEvictUserMedia({ ...active, roomActive: false }, "host"), true);
  assert.equal(mustEvictUserMedia(null, "member"), true);
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
