import test from "node:test";
import assert from "node:assert/strict";
import { getRoomPermissions, type MediaObjectInstance, type MediaSurface } from "@vrata/shared-types";
import { createMeetingToolTransition, planMeetingTool, type MeetingToolContext, type MeetingToolIntent, type MeetingToolTransitionState } from "./meeting-tool-transition.js";

const documentIntent: MeetingToolIntent = { kind: "document", documentId: "slides", checksum: "own-checksum", objectType: "pdf-presentation" };
const surface = (surfaceId: string, types: string[]): MediaSurface => ({ surfaceId, roomId: "room", label: surfaceId,
  widthPx: 640, heightPx: 360, inputEnabled: true, mediaAudioEnabled: false, visible: true, allowedObjectTypes: types,
  activeObjectId: null, lockedByParticipantId: null });
function context(): MeetingToolContext {
  return { leaseKey: "owned-session-1", blocked: false, connected: true, xrActive: false, participantId: "host", permissions: getRoomPermissions("host"),
    screenSupported: true, screenEnabled: true, documentsEnabled: true, stopRevisionSupported: true,
    selectedSurfaceId: "main", selectedDocumentId: "slides", selectedDocumentChecksum: "own-checksum",
    documents: [{ documentId: "slides", checksum: "own-checksum" }],
    physicalSurfaceIds: new Set(["main", "wall"]), surfaces: { main: surface("main", ["pdf-presentation", "screen-share", "image-viewer", "video-player"]),
      wall: surface("wall", ["whiteboard", "markdown-board"]) }, objects: {}, templateSurfaces: [
      { surfaceId: "main", label: "Meeting display", purpose: "collaboration", allowedObjectTypes: ["pdf-presentation", "screen-share"] },
      { surfaceId: "wall", label: "Collaboration wall", purpose: "collaboration", allowedObjectTypes: ["whiteboard", "markdown-board"] }] };
}
function occupy(state: MeetingToolContext, surfaceId: string, type: string, revision = 0) {
  const object: MediaObjectInstance = { objectId: `${type}-own`, surfaceId, type, revision, roomId: "room", ownerParticipantId: "host",
    state: {}, status: "active", createdAtMs: 1, updatedAtMs: 1 };
  (state.surfaces as Record<string, MediaSurface>)[surfaceId].activeObjectId = object.objectId;
  (state.objects as Record<string, MediaObjectInstance>)[object.objectId] = object; return object;
}
function fixture() {
  const state = context(), events: string[] = [], changes: MeetingToolTransitionState[] = [];
  const video = { readyState: "live", stop() { this.readyState = "ended"; events.push("stop-capture"); } };
  const stream = { getTracks: () => [video], getVideoTracks: () => [video] } as unknown as MediaStream;
  const hooks = { capture: async () => stream, stop: async () => ({ accepted: true }), start: async () => true, afterStop: () => {} };
  const runtime = createMeetingToolTransition({ current: () => state, changed: value => changes.push(value),
    capture: plan => { events.push("capture"); return hooks.capture(); },
    stop: async plan => {
      events.push("stop-content"); const reply = await hooks.stop();
      if (reply.accepted) (state.surfaces as Record<string, MediaSurface>)[plan.surfaceId].activeObjectId = null;
      hooks.afterStop();
      return reply;
    },
    start: async (plan, input, check) => { events.push("start"); check(); return hooks.start(); } });
  return { state, events, changes, video, stream, hooks, runtime };
}

test("Board targets the real collaboration wall without altering main content", () => {
  const state = context(); occupy(state, "main", "pdf-presentation");
  const decision = planMeetingTool(state, { kind: "board" }); assert.notEqual(decision.kind, "blocked");
  if (decision.kind !== "blocked") { assert.equal(decision.plan.surfaceId, "wall"); assert.equal(decision.kind, "ready"); }
  assert.equal(state.selectedSurfaceId, "main"); assert.equal(state.surfaces!.main.activeObjectId, "pdf-presentation-own");
});
test("sticky replacement requires explicit revision-bound consent and advertised CAS support", () => {
  const state = context(); occupy(state, "wall", "markdown-board", 4);
  const decision = planMeetingTool(state, { kind: "board" }); assert.equal(decision.kind, "confirm");
  assert.equal(decision.plan.previous?.revision, 4);
  state.stopRevisionSupported = false; assert.deepEqual(planMeetingTool(state, { kind: "board" }), { kind: "blocked", reason: "replacement-unsupported" });
  state.stopRevisionSupported = true; state.xrActive = true;
  assert.deepEqual(planMeetingTool(state, { kind: "board" }), { kind: "blocked", reason: "replacement-unavailable-xr" });
});
test("existing whiteboard is focused, never cleared as an implicit start", () => {
  const state = context(); occupy(state, "wall", "whiteboard", 7);
  const decision = planMeetingTool(state, { kind: "board" }); assert.equal(decision.kind, "ready");
  assert.equal(decision.plan.replace, false);
});
test("Guest/Member cannot start, and missing/locked/unknown surfaces remain unavailable", () => {
  const state = context(); state.permissions = getRoomPermissions("member");
  assert.equal(planMeetingTool(state, { kind: "board" }).kind, "blocked");
  state.permissions = getRoomPermissions("host"); state.physicalSurfaceIds = new Set();
  assert.equal(planMeetingTool(state, { kind: "screen" }).kind, "blocked");
  state.physicalSurfaceIds = new Set(["main", "wall"]); (state.surfaces as Record<string, MediaSurface>).wall.lockedByParticipantId = "other";
  assert.deepEqual(planMeetingTool(state, { kind: "board" }), { kind: "blocked", reason: "surface-locked" });
  (state.surfaces as Record<string, MediaSurface>).wall.lockedByParticipantId = null; occupy(state, "wall", "external-custom-tool");
  assert.deepEqual(planMeetingTool(state, { kind: "board" }), { kind: "blocked", reason: "unsupported-content" });
});
test("document selection and unsupported capture are not permission grants", () => {
  const state = context(); state.selectedDocumentChecksum = "different";
  assert.deepEqual(planMeetingTool(state, documentIntent), { kind: "blocked", reason: "document-changed" });
  state.screenSupported = false; assert.deepEqual(planMeetingTool(state, { kind: "screen" }), { kind: "blocked", reason: "capture-unsupported" });
});
test("cancelled confirmation neither captures nor stops current content", async () => {
  const f = fixture(); occupy(f.state, "main", "pdf-presentation");
  await f.runtime.request({ kind: "screen" }); assert.equal(f.runtime.snapshot().phase, "confirm");
  f.runtime.cancel(); await f.runtime.confirm(); assert.deepEqual(f.events, []);
});
test("capture is invoked inline by confirmation before any stop or network start", async () => {
  const f = fixture(); occupy(f.state, "main", "pdf-presentation");
  await f.runtime.request({ kind: "screen" }); const pending = f.runtime.confirm();
  assert.deepEqual(f.events, ["capture"]); await pending;
  assert.deepEqual(f.events, ["capture", "stop-content", "start"]); assert.equal(f.video.readyState, "live"); assert.equal(f.runtime.busy(), false);
});
test("denied capture preserves the PDF", async () => {
  const f = fixture(); occupy(f.state, "main", "pdf-presentation"); f.hooks.capture = async () => { throw new Error("private-browser-error"); };
  await f.runtime.request({ kind: "screen" }); await f.runtime.confirm();
  assert.deepEqual(f.events, ["capture"]); assert.equal(f.state.surfaces!.main.activeObjectId, "pdf-presentation-own");
  assert.equal(f.runtime.snapshot().message, "operation-unconfirmed");
});
test("concurrent edit before confirm opens no picker and stops nothing", async () => {
  const f = fixture(), object = occupy(f.state, "main", "pdf-presentation");
  await f.runtime.request({ kind: "screen" }); object.revision++;
  await f.runtime.confirm(); assert.deepEqual(f.events, []); assert.equal(f.runtime.snapshot().message, "surface-changed");
});
test("role loss/regrant cannot revive a late native picker result", async () => {
  const f = fixture(); let release!: (stream: MediaStream) => void;
  f.hooks.capture = () => new Promise(resolve => { release = resolve; });
  const pending = f.runtime.request({ kind: "screen" });
  f.state.leaseKey = "revoked"; f.runtime.sync(); f.state.leaseKey = "regranted"; f.runtime.sync();
  release(f.stream); await pending;
  assert.deepEqual(f.events, ["capture", "stop-capture"]); assert.equal(f.runtime.snapshot().message, "context-changed");
});
test("browser Stop before replacement leaves current content intact", async () => {
  const f = fixture(); occupy(f.state, "main", "pdf-presentation"); f.video.readyState = "ended";
  await f.runtime.request({ kind: "screen" }); await f.runtime.confirm();
  assert.ok(!f.events.includes("stop-content")); assert.ok(!f.events.includes("start")); assert.equal(f.runtime.snapshot().message, "capture-ended");
});
test("CAS failure disposes capture without starting or retrying a stop", async () => {
  const f = fixture(); occupy(f.state, "main", "pdf-presentation"); f.hooks.stop = async () => ({ accepted: false });
  await f.runtime.request({ kind: "screen" }); await f.runtime.confirm();
  assert.deepEqual(f.events, ["capture", "stop-content", "stop-capture"]); assert.equal(f.runtime.snapshot().message, "stop-unconfirmed");
});
test("permission loss during start disposes the captured stream", async () => {
  const f = fixture(); occupy(f.state, "main", "pdf-presentation");
  f.hooks.start = async () => { f.state.leaseKey = "lost-permission"; f.runtime.sync(); return false; };
  await f.runtime.request({ kind: "screen" }); await f.runtime.confirm();
  assert.equal(f.runtime.snapshot().message, "context-changed"); assert.equal(f.video.readyState, "ended");
  assert.equal(f.events.filter(value => value === "stop-content").length, 1);
});
test("a different object after stop is never stopped or overwritten", async () => {
  const f = fixture(); occupy(f.state, "main", "pdf-presentation");
  f.hooks.afterStop = () => { occupy(f.state, "main", "video-player", 6); };
  await f.runtime.request({ kind: "screen" }); await f.runtime.confirm();
  assert.equal(f.runtime.snapshot().message, "surface-changed"); assert.equal(f.state.surfaces!.main.activeObjectId, "video-player-own");
  assert.ok(!f.events.includes("start")); assert.equal(f.events.filter(event => event === "stop-content").length, 1);
});
test("single flight does not create a second picker while the first is open", async () => {
  const f = fixture(); let release!: (stream: MediaStream) => void; f.hooks.capture = () => new Promise(resolve => { release = resolve; });
  const pending = f.runtime.request({ kind: "screen" }); await f.runtime.request({ kind: "screen" });
  assert.deepEqual(f.events, ["capture"]); release(f.stream); await pending;
});

test("idle sync does not announce a nonexistent cancelled action", () => {
  const state = context(); let renders = 0;
  const runtime = createMeetingToolTransition({ current: () => state, capture: async () => { throw new Error("unused"); },
    stop: async () => ({ accepted: true }), start: async () => true, changed: () => { renders++; runtime.sync(); } });
  runtime.sync(); state.leaseKey = "new-session"; runtime.sync();
  assert.equal(renders, 0); assert.equal(runtime.snapshot().message, null);
});

test("sync updates its lease before a reentrant confirmation render", async () => {
  const state = context(); occupy(state, "main", "pdf-presentation"); let renders = 0;
  const runtime = createMeetingToolTransition({ current: () => state, capture: async () => { throw new Error("unused"); },
    stop: async () => ({ accepted: true }), start: async () => true, changed: () => { renders++; runtime.sync(); } });
  await runtime.request({ kind: "screen" }); state.leaseKey = "new-session"; runtime.sync();
  assert.equal(renders, 2); assert.equal(runtime.snapshot().message, "context-changed");
});

test("media admission failure before Stop preserves the PDF and disposes capture", async () => {
  const f = fixture(); occupy(f.state, "main", "pdf-presentation");
  const runtime = createMeetingToolTransition({ current: () => f.state, capture: async () => { f.events.push("capture"); return f.stream; },
    prepareScreen: async () => { f.events.push("prepare"); throw new Error("media-denied"); },
    stop: async () => { throw new Error("must-not-stop"); }, start: async () => { throw new Error("must-not-start"); }, changed() {} });
  await runtime.request({ kind: "screen" }); await runtime.confirm();
  assert.deepEqual(f.events, ["capture", "prepare", "stop-capture"]); assert.equal(f.state.surfaces!.main.activeObjectId, "pdf-presentation-own");
});

for (const race of ["revoke", "edit", "ended"] as const) test(`${race} during media preparation cannot stop the old PDF`, async () => {
  const f = fixture(), object = occupy(f.state, "main", "pdf-presentation");
  const runtime = createMeetingToolTransition({ current: () => f.state, capture: async () => f.stream,
    prepareScreen: async () => {
      if (race === "revoke") { f.state.leaseKey = "revoked"; runtime.sync(); }
      else if (race === "edit") object.revision++;
      else f.video.readyState = "ended";
    }, stop: async () => { throw new Error("must-not-stop"); }, start: async () => { throw new Error("must-not-start"); }, changed() {} });
  await runtime.request({ kind: "screen" }); await runtime.confirm();
  assert.equal(f.state.surfaces!.main.activeObjectId, object.objectId); assert.equal(f.video.readyState, "ended");
  assert.equal(runtime.snapshot().message, race === "revoke" ? "context-changed" : race === "edit" ? "surface-changed" : "capture-ended");
});

test("document intent survives an unrelated UI document selection during confirmed Stop", async () => {
  const state = context(); const old = occupy(state, "main", "screen-share");
  let starts = 0;
  const runtime = createMeetingToolTransition({ current: () => state, capture: async () => { throw new Error("unused"); },
    stop: async () => {
      state.selectedDocumentId = "different"; state.selectedDocumentChecksum = "different";
      (state.surfaces as Record<string, MediaSurface>).main.activeObjectId = null; return { accepted: true };
    }, start: async (plan, _stream, check) => { check(); assert.deepEqual(plan.intent, documentIntent); starts++; return true; }, changed() {} });
  await runtime.request(documentIntent); await runtime.confirm(); assert.equal(starts, 1); assert.equal(runtime.snapshot().message, null);
  assert.ok(old);
});

test("a committed owner keeps capture ownership despite a late lease change and reentrant sync", async () => {
  const f = fixture();
  const runtime = createMeetingToolTransition({ current: () => f.state, capture: async () => f.stream,
    stop: async () => ({ accepted: true }), start: async () => { f.state.leaseKey = "next-room-revision"; return true; },
    changed: () => runtime.sync() });
  await runtime.request({ kind: "screen" });
  assert.equal(runtime.snapshot().message, null); assert.equal(f.video.readyState, "live");
  assert.deepEqual(f.events, []);
});

test("CAS revision conflict tells the user to review changed content", async () => {
  const state = context(); occupy(state, "wall", "markdown-board", 3);
  const runtime = createMeetingToolTransition({ current: () => state, capture: async () => { throw new Error("unused"); },
    stop: async () => ({ accepted: false, blockedReason: "revision-mismatch" }), start: async () => { throw new Error("must-not-start"); }, changed() {} });
  await runtime.request({ kind: "board" }); await runtime.confirm(); assert.equal(runtime.snapshot().message, "surface-changed");
});
