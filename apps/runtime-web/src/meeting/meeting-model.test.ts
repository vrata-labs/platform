import assert from "node:assert/strict";
import test from "node:test";
import { getRoomPermissions, type MediaSurface, type RoomTemplateSurface } from "@vrata/shared-types";
import { MEETING_ACTIONS, meetingActionReason, type MeetingAvailabilityContext } from "./meeting-availability.js";
import { buildMeetingPeople } from "./meeting-people.js";
import { resolveMeetingSurfaceTarget } from "./meeting-surface-target.js";
import { meetingToolMessage } from "./meeting-tool-ui.js";

const surface = (surfaceId: string, allowedObjectTypes = ["whiteboard", "screen-share", "pdf-presentation"]): MediaSurface => ({
  surfaceId, roomId: "room", label: `Label ${surfaceId}`, widthPx: 1920, heightPx: 1080, inputEnabled: true,
  mediaAudioEnabled: false, visible: true, allowedObjectTypes, activeObjectId: null, lockedByParticipantId: null
});
const context = (): MeetingAvailabilityContext => ({ admitted: true, blocked: false, connected: true,
  permissions: getRoomPermissions("host"), features: { audio: true, screenShare: true, documents: true, notes: true, hostControls: true },
  capabilities: { microphone: true, screenCapture: true, speakerSelection: true }, audioJoined: false, audioBusy: false,
  documentSelected: false, documentDisplayable: false, canManagePeople: true, participantSelected: false,
  selectedSurfaceId: "screen", localParticipantId: "self", physicalSurfaceIds: new Set(["screen"]), surfaces: { screen: surface("screen") }, objects: {} });
const disabled = { disabled: true, hidden: false };

test("meeting explanations never override an enabled visible producer, including during stale permission transitions", () => {
  const state = context(); state.blocked = true; state.admitted = false; state.permissions = [];
  for (const action of MEETING_ACTIONS) assert.equal(meetingActionReason(action, { disabled: false, hidden: false }, state), null);
});

test("meeting states distinguish joining, blocked session, role, feature, device and connection failures", () => {
  const state = context(); state.admitted = false;
  assert.match(meetingActionReason("start-share", disabled, state)!, /Join the room/);
  state.blocked = true; assert.match(meetingActionReason("start-share", disabled, state)!, /session is unavailable/);
  state.blocked = false; state.admitted = true; state.permissions = getRoomPermissions("guest"); state.capabilities.screenCapture = false;
  assert.match(meetingActionReason("start-share", { disabled: false, hidden: true }, state)!, /Host or Presenter/);
  state.permissions = getRoomPermissions("host"); assert.match(meetingActionReason("start-share", disabled, state)!, /unsupported on this device/);
  state.features.screenShare = false; assert.match(meetingActionReason("start-share", disabled, state)!, /disabled for this room/);
  state.features.screenShare = true; state.capabilities.screenCapture = true; state.connected = false;
  assert.match(meetingActionReason("start-share", disabled, state)!, /connection unavailable/);
  assert.doesNotMatch(meetingActionReason("notes-editor", disabled, state)!, /connection unavailable/, "HTTP notes do not require the realtime socket");
});

test("audio explanations preserve user intent and identify unsupported device selection", () => {
  const state = context();
  assert.match(meetingActionReason("toggle-mute", disabled, state)!, /Join Audio/);
  state.audioBusy = true; assert.match(meetingActionReason("join-audio", disabled, state)!, /connecting or changing/);
  state.capabilities.speakerSelection = false; assert.match(meetingActionReason("speaker-select", disabled, state)!, /system default/);
  state.capabilities.microphone = false; assert.match(meetingActionReason("join-audio", disabled, state)!, /Microphone input is unavailable/);
});

test("surface explanations use real readiness, allowed types, locks and occupancy without stopping existing objects", () => {
  const state = context(); state.surfaces = null;
  assert.match(meetingActionReason("start-whiteboard", disabled, state)!, /surfaces are still loading/);
  state.surfaces = { screen: surface("screen", ["pdf-presentation"]) };
  assert.match(meetingActionReason("start-whiteboard", disabled, state)!, /compatible surface/);
  state.surfaces.screen.allowedObjectTypes.push("whiteboard"); state.surfaces.screen.lockedByParticipantId = "other";
  assert.match(meetingActionReason("start-whiteboard", disabled, state)!, /locked by another/);
  state.surfaces.screen.lockedByParticipantId = null; state.surfaces.screen.activeObjectId = "existing";
  assert.match(meetingActionReason("start-whiteboard", disabled, state)!, /surface is in use/);
  assert.equal(state.surfaces.screen.activeObjectId, "existing");
  state.surfaces.screen.activeObjectId = null; assert.match(meetingActionReason("draw-whiteboard", disabled, state)!, /No whiteboard is open/);
});

test("tool planner explains replacement blocks for its own target without overriding access or enabled controls", () => {
  const state = context(); state.toolReasons = { "start-share": meetingToolMessage("replacement-unavailable-xr"),
    "start-whiteboard": meetingToolMessage("replacement-unsupported") };
  assert.match(meetingActionReason("start-share", disabled, state)!, /Leave VR/);
  assert.match(meetingActionReason("start-whiteboard", disabled, state)!, /newer room server/);
  assert.equal(meetingActionReason("start-share", { disabled: false, hidden: false }, state), null);
  state.permissions = getRoomPermissions("guest"); assert.match(meetingActionReason("start-share", disabled, state)!, /Host or Presenter/);
});

test("documents and participant controls explain missing selection and do not mistake personal Owner for an ordinary Member", () => {
  const state = context();
  assert.match(meetingActionReason("document-surface-button", disabled, state)!, /select a room document/);
  state.documentSelected = true; assert.match(meetingActionReason("document-surface-button", disabled, state)!, /PDF, image or video/);
  assert.match(meetingActionReason("grant-presenter", disabled, state)!, /Select a participant/);
  state.permissions = getRoomPermissions("member");
  assert.match(meetingActionReason("grant-presenter", disabled, state)!, /Select a participant/, "verified personal Owner can manage while remaining Member");
  state.canManagePeople = false; assert.match(meetingActionReason("grant-presenter", disabled, state)!, /Host or personal-room Owner/);
  state.features.hostControls = false; assert.match(meetingActionReason("grant-presenter", disabled, state)!, /disabled for this room/);
});

test("surface targets use declared purpose and real type support instead of labels or option order", () => {
  const template: RoomTemplateSurface[] = [
    { surfaceId: "wall", label: "Not a magical ID", purpose: "collaboration", allowedObjectTypes: ["whiteboard"] },
    { surfaceId: "display", label: "Anything", purpose: "presentation", allowedObjectTypes: ["pdf-presentation"] }
  ];
  const surfaces = { display: surface("display"), wall: surface("wall") };
  const input = { purpose: "collaboration" as const, objectType: "whiteboard", selectedSurfaceId: "display",
    templateSurfaces: template, surfaces, physicalSurfaceIds: new Set(["display", "wall"]) };
  assert.equal(resolveMeetingSurfaceTarget(input)?.surfaceId, "wall");
  assert.equal(resolveMeetingSurfaceTarget({ ...input, surfaces: { wall: surfaces.wall, display: surfaces.display }, templateSurfaces: [...template].reverse() })?.surfaceId, "wall");
  assert.equal(resolveMeetingSurfaceTarget({ ...input, purpose: "presentation", objectType: "pdf-presentation", selectedSurfaceId: "wall" })?.surfaceId, "display");
});

test("surface targets preserve a compatible explicit choice and fail closed without both physical and logical availability", () => {
  const input = { purpose: "presentation" as const, objectType: "pdf-presentation", selectedSurfaceId: "chosen", templateSurfaces: [],
    surfaces: { first: surface("first"), chosen: surface("chosen") }, physicalSurfaceIds: new Set(["first", "chosen"]) };
  assert.equal(resolveMeetingSurfaceTarget(input)?.surfaceId, "chosen");
  assert.equal(resolveMeetingSurfaceTarget({ ...input, objectTypeAvailable: false }), null);
  assert.equal(resolveMeetingSurfaceTarget({ ...input, physicalSurfaceIds: new Set() }), null);
  assert.equal(resolveMeetingSurfaceTarget({ ...input, surfaces: null }), null);
  assert.equal(resolveMeetingSurfaceTarget({ ...input, surfaces: { chosen: { ...surface("chosen"), visible: false } } }), null);
});

test("Present also finds screen-share, image and video surfaces when PDF is absent or unavailable", () => {
  for (const objectType of ["screen-share", "image-viewer", "video-player"]) {
    const input = { purpose: "presentation" as const, objectType: "pdf-presentation", objectTypeAvailable: false,
      alternativeObjectTypes: ["screen-share", "image-viewer", "video-player"], selectedSurfaceId: "other", templateSurfaces: [],
      surfaces: { only: surface("only", [objectType]) }, physicalSurfaceIds: new Set(["only"]) };
    assert.equal(resolveMeetingSurfaceTarget(input)?.surfaceId, "only");
  }
});

test("meeting people are bounded plain names, not raw IDs, role authority or microphone-level claims", () => {
  const people = buildMeetingPeople([
    { participantId: "secret-looking-id", displayName: "", audioJoined: false },
    { participantId: "self", displayName: "You\nName", audioJoined: true, muted: true },
    { participantId: "on", displayName: "<img src=x onerror=attack()>", activeMedia: { audio: true } },
    { participantId: "on", displayName: "Last name", audioJoined: true, activeMedia: { audio: true } }
  ], "self");
  assert.equal(people.people.length, 3); assert.equal(people.people[0].self, true); assert.equal(people.people[0].name, "You Name");
  assert.equal(people.people.find(person => person.key === "secret-looking-id")!.name, "Participant");
  assert.equal(people.people.find(person => person.key === "on")!.audio, "Mic on");
  assert.equal(people.people[0].audio, "Muted");
  const bounded = buildMeetingPeople(Array.from({ length: 300 }, (_, index) => ({ participantId: String(index), displayName: "x".repeat(1000) })), "none");
  assert.equal(bounded.people.length, 64); assert.equal(bounded.truncated, true); assert.equal(bounded.people[0].name.length, 80);
  assert.throws(() => buildMeetingPeople([], "self", 0), /invalid_meeting_people_limit/);
});
