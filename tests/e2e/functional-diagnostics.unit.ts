import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mediaFacts, mediaParticipantFacts, observeFunctionalClient } from "./functional-diagnostics.ts";

test("media diagnostics correlate object/track/revision without retaining content or owner IDs", () => {
  const media = { surfaces: { wall: { surfaceId: "whiteboard-wall", activeObjectId: "object-private", textureId: 3 } },
    objects: { one: { objectId: "object-private", ownerParticipantId: "owner-private", surfaceId: "whiteboard-wall", revision: 4,
      type: "markdown-board", state: { status: "active", notes: [{ text: "private-note" }, {}], mediaTrackSid: "track-private", config: "secret-config" } } } };
  const facts = mediaFacts(media);
  assert.equal(facts.surfaces[0].object, facts.objects[0].object);
  assert.equal(facts.objects[0].notes, 2); assert.equal(facts.objects[0].revision, 4);
  assert.equal(facts.surfaces[0].hasTexture, true);
  assert.doesNotMatch(JSON.stringify(facts), /private|secret-config/);
  assert.deepEqual(mediaFacts(null), { surfaces: [], objects: [] });
});

test("server media bindings and object tracks share pseudonyms without raw attributes", () => {
  const participants = mediaParticipantFacts([{ identity: "identity-private", attributes: {
    vrataMediaBinding: JSON.stringify({ participantId: "participant-private", scope: "ms", token: "never-copy" }) },
    tracks: [{ sid: "track-private", source: 3, type: 1, muted: false }] }]);
  const media = mediaFacts({ objects: [{ state: { mediaTrackSid: "track-private" } }] });
  assert.equal(participants[0].tracks[0].track, media.objects[0].track);
  assert.equal(participants[0].scope, "ms");
  assert.doesNotMatch(JSON.stringify(participants), /private|never-copy|vrataMediaBinding/);
});

test("passive transport observation correlates sent target and ACK, without retaining the socket URL or payload", async () => {
  const cdp = Object.assign(new EventEmitter(), { send: async () => ({}), detach: async () => {} });
  const page = Object.assign(new EventEmitter(), { context: () => ({ newCDPSession: async () => cdp }),
    addInitScript: async () => {}, evaluate: async () => ({}), isClosed: () => false });
  const observation = await observeFunctionalClient(page as any);
  try {
    cdp.emit("Network.webSocketCreated", { requestId: "one", url: "ws://private.invalid/?roomId=room&accessToken=secret-proof" });
    const frame = (message: unknown) => ({ requestId: "one", response: { opcode: 1, payloadData: JSON.stringify(message) } });
    cdp.emit("Network.webSocketFrameSent", frame({ type: "surface_patch_object_state", commandId: "command-private", objectId: "object-private",
      surfaceId: "whiteboard-wall", expectedRevision: 1, patch: { type: "add-note", text: "private-colleague-note" } }));
    cdp.emit("Network.webSocketFrameReceived", frame({ type: "surface_command_result", result: { commandId: "command-private", accepted: true,
      objectId: "object-private", surfaceId: "whiteboard-wall", revision: 2 } }));
    const facts = await observation.snapshot(), commands = facts.events.filter((event: any) => event.kind === "command");
    assert.equal(commands.length, 2); assert.equal(commands[0].command, commands[1].command);
    assert.equal(commands[0].object, commands[1].object); assert.equal(commands[1].revision, 2);
    assert.equal(commands[1].accepted, true);
    assert.doesNotMatch(JSON.stringify(facts), /private|secret-proof|accessToken|payloadData/);
  } finally { await observation.close(); }
  assert.equal(cdp.listenerCount("Network.webSocketFrameReceived"), 0);
  assert.equal(page.listenerCount("response"), 0);
});
