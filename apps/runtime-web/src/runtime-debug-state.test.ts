import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { createRoomAccessDebugState, getMediaExtensionDebugSnapshot } from "@vrata/shared-types";
import { createEmptyAvatarDiagnostics } from "./avatar/avatar-debug.js";
import { resolveClientCompatibility } from "./client-capabilities.js";
import { createSurfaceInputDebugState } from "./input/surface-input.js";
import { detectBrowserMediaCapabilities } from "./media-capabilities.js";
import { createRuntimeDebugState, type RuntimeDebugStateInput } from "./runtime-debug-state.js";
import { createEmptySceneDiagnostics } from "./scene-debug.js";
import { createUnavailableWebRtcDiagnostics } from "./webrtc-diagnostics.js";
import { createXrRendererWiringDebug } from "./xr.js";

beforeEach((context) => {
  assert("mock" in context);
  context.mock.method(Date, "now", () => 1_700_000_000_000);
});

function createInput(): RuntimeDebugStateInput<{ enterVr: boolean; audioJoin: boolean }> {
  const browserMediaCapabilities = detectBrowserMediaCapabilities({ isSecureContext: false });
  const support = { available: false, canEnterVr: false };
  return {
    participantId: "participant-a",
    latestMode: "desktop",
    displayNameFromQuery: null,
    joinMutedPreference: false,
    activeNotesScope: "shared",
    notesSaveState: "idle",
    selectedDocumentId: "",
    debugSurfaceId: "surface-a",
    shareMockEnabled: false,
    browserMediaCapabilities,
    clientCompatibility: resolveClientCompatibility({
      resolvedJoinMode: "desktop", media: browserMediaCapabilities, xr: support,
      enterVrFeatureEnabled: true, webGlAvailable: true, webSocketAvailable: true,
      touchInputAvailable: false
    }),
    spatialAudioQueryEnabled: true,
    initialLocalPosition: { x: 0, y: 0, z: 6 },
    xrSessionDebug: createXrRendererWiringDebug({
      featureEnabled: true, support, rendererXrEnabled: true,
      animationLoopConfigured: true, presenting: false
    }),
    botMode: "off",
    runtimeFlags: { enterVr: true, audioJoin: true },
    faultConfig: { audio: null, roomState: false, xrUnavailable: false }
  };
}

test("initial diagnostics retain connection, media and recovery defaults", () => {
  const state = createRuntimeDebugState(createInput());
  assert.equal(state.statusLine, "Connecting...");
  assert.equal(state.mode, "desktop");
  assert.equal(state.locomotionMode, "desktop");
  assert.equal(state.roomStateConnected, false);
  assert.equal(state.roomStateMode, "disconnected");
  assert.equal(state.roomStateUrl, "");
  assert.equal(state.audioState, "idle");
  assert.equal(state.screenShareState, "idle");
  assert.equal(state.degradedMode, "none");
  assert.equal(state.retryCount, 0);
  assert.equal(state.lastRecoveryAction, "none");
  assert.equal(state.issueCode, null);
  assert.equal(state.lastReportId, null);
  assert.deepEqual(state.media, {
    audioState: "not_joined", audioJoined: false, muted: true, speaking: false,
    publishedAudio: false, audioSource: "none", subscribedAudioCount: 0,
    webrtc: createUnavailableWebRtcDiagnostics()
  });
});

test("WebRTC diagnostics capture the time of each creation rather than module import", (context) => {
  const now = context.mock.method(Date, "now", () => 101);
  const first = createRuntimeDebugState(createInput());
  now.mock.mockImplementation(() => 202);
  const second = createRuntimeDebugState(createInput());
  assert.equal(first.media.webrtc.capturedAtMs, 101);
  assert.equal(second.media.webrtc.capturedAtMs, 202);
  assert.equal(now.mock.callCount(), 2);
});

test("caller-owned capability, compatibility, XR, flag and fault objects retain identity", () => {
  const input = createInput();
  const before = structuredClone(input);
  const state = createRuntimeDebugState(input);
  assert.deepEqual(input, before);
  assert.equal(state.mediaCapabilities, input.browserMediaCapabilities);
  assert.equal(state.clientCompatibility, input.clientCompatibility);
  assert.equal(state.xrSession, input.xrSessionDebug);
  assert.equal(state.featureFlags, input.runtimeFlags);
  assert.equal(state.faultInjection, input.faultConfig);
  input.runtimeFlags.audioJoin = false;
  input.faultConfig.roomState = true;
  input.xrSessionDebug.transformSyncCount = 7;
  assert.equal(state.featureFlags.audioJoin, false);
  assert.equal(state.faultInjection.roomState, true);
  assert.equal(state.xrSession.transformSyncCount, 7);
});

test("identity and stored preferences are reflected without modifying inputs", () => {
  const input = createInput();
  Object.assign(input, {
    participantId: "another-participant", latestMode: "vr", botMode: "walk",
    displayNameFromQuery: "Guest", joinMutedPreference: true,
    activeNotesScope: "private", notesSaveState: "failed", selectedDocumentId: "document-a"
  });
  const before = structuredClone(input);
  const state = createRuntimeDebugState(input);
  assert.equal(state.participantId, "another-participant");
  assert.equal(state.mode, "vr");
  assert.equal(state.botMode, "walk");
  assert.equal(state.locomotionMode, "desktop");
  assert.equal(state.guestOnboarding.joinMuted, true);
  assert.equal(state.guestOnboarding.displayNameProvided, true);
  assert.equal(state.notes.scope, "private");
  assert.equal(state.notes.saveState, "failed");
  assert.equal(state.documents.selectedDocumentId, "document-a");
  assert.deepEqual(input, before);
});

test("positions are copied and the initial head offset and listener default are preserved", () => {
  const input = createInput();
  input.initialLocalPosition = { x: -3.25, y: 2.5, z: 17 };
  const state = createRuntimeDebugState(input);
  assert.deepEqual(state.localPosition, { x: -3.25, z: 17 });
  assert.deepEqual(state.localPose, {
    root: { x: -3.25, y: 2.5, z: 17, yaw: 0 },
    head: { x: -3.25, y: 4.1, z: 17, yaw: 0, pitch: 0 }
  });
  assert.deepEqual(state.spatialAudio.listener, { x: 0, y: 1.6, z: 6, yaw: 0 });
  input.initialLocalPosition.x = 42;
  assert.equal(state.localPose.root.x, -3.25);
  state.localPose.head.z = -9;
  assert.equal(state.localPose.root.z, 17);
  assert.equal(state.localPosition.z, 17);
  assert.equal(input.initialLocalPosition.z, 17);
});

for (const supported of [false, true]) {
  for (const mock of [false, true]) {
    test(`screen sharing support combines browser=${supported} and mock=${mock}`, () => {
      const input = createInput();
      input.browserMediaCapabilities.screenShare.supported = supported;
      input.shareMockEnabled = mock;
      const state = createRuntimeDebugState(input);
      assert.equal(state.screenShare.supported, supported || mock);
      assert.equal(state.screenShare.active, false);
      assert.equal(state.screenShare.localPublishing, false);
      assert.equal(state.screenShare.errorCode, null);
    });
  }
}

for (const name of [null, "", "Guest", " "]) {
  test(`display-name presence preserves Boolean semantics for ${JSON.stringify(name)}`, () => {
    const input = createInput();
    input.displayNameFromQuery = name;
    assert.equal(createRuntimeDebugState(input).guestOnboarding.displayNameProvided, Boolean(name));
  });
}

for (const enabled of [false, true]) {
  test(`spatial-audio query=${enabled} determines only the initial spatial defaults`, () => {
    const input = createInput();
    input.spatialAudioQueryEnabled = enabled;
    const state = createRuntimeDebugState(input);
    assert.equal(state.spatialAudioState, "idle");
    assert.deepEqual(state.spatialAudio, {
      enabled, fallback: !enabled, mode: enabled ? "idle" : "disabled",
      fallbackReason: enabled ? null : "query_disabled",
      listener: { x: 0, y: 1.6, z: 6, yaw: 0 }, remoteSources: []
    });
  });
}

test("the supplied diagnostic surface ID reaches every initial media section", () => {
  const input = createInput();
  input.debugSurfaceId = "custom-surface";
  const state = createRuntimeDebugState(input);
  for (const section of [state.pdfPresentation, state.documentMedia, state.remoteBrowser,
    state.surfaceAudio, state.whiteboard, state.markdownBoard]) {
    assert.equal(section.surfaceId, "custom-surface");
  }
  assert.equal(state.mediaObjects.selectedSurfaceId, "custom-surface");
  assert.deepEqual(state.surfaceInput, createSurfaceInputDebugState("custom-surface"));
  assert.equal(state.screenShare.selectedSurfaceId, null);
  assert.equal(state.documents.selectedSurfaceId, null);
});

test("initial access, scene, avatar and media extension diagnostics use existing factories", () => {
  const state = createRuntimeDebugState(createInput());
  assert.deepEqual(state.access, {
    ...createRoomAccessDebugState("guest"), token: "", expiresInSeconds: 0,
    roleQueryAllowed: false, lastDeniedPermission: null, lastSurfaceCommandAccepted: null
  });
  assert.deepEqual(state.sceneDebug, createEmptySceneDiagnostics());
  assert.deepEqual(state.avatarDebug, createEmptyAvatarDiagnostics());
  assert.deepEqual(state.mediaObjects.extensions, getMediaExtensionDebugSnapshot());
  assert.equal(state.sceneBundleState, "fallback");
  assert.equal(state.avatarPresenceMode, "baseline");
  assert.equal(state.avatarSnapshot, null);
  assert.equal(state.avatarTransportPreview, null);
  assert.equal(state.xrAvatarDebug, null);
});

test("media objects remain inactive with their original defaults", () => {
  const state = createRuntimeDebugState(createInput());
  assert.equal(state.pdfPresentation.page, 1);
  assert.equal(state.pdfPresentation.pageCount, 0);
  assert.equal(state.pdfPresentation.displayMode, "normal");
  assert.equal(state.documentMedia.playbackState, "paused");
  assert.equal(state.documentMedia.muted, true);
  assert.equal(state.remoteBrowser.experimental, true);
  assert.equal(state.remoteBrowser.enabled, false);
  assert.equal(state.remoteBrowser.active, false);
  assert.equal(state.remoteBrowser.status, "idle");
  assert.equal(state.remoteBrowser.externalVideoCurrentTime, null);
  assert.equal(state.remoteBrowser.mediaHasVideo, false);
  assert.equal(state.remoteBrowser.mediaHasAudio, false);
  assert.equal(state.remoteBrowser.xrKeyboardLayout, "en-US");
  assert.equal(state.remoteBrowser.xrKeyboardOpen, false);
  assert.equal(state.whiteboard.active, false);
  assert.equal(state.markdownBoard.active, false);
  assert.equal(state.mediaObjects.runtimeResetCount, 0);
  assert.equal(state.mediaObjects.lastCommand, null);
  assert.equal(state.mediaObjects.blockedReason, null);
});

test("new calls allocate independent diagnostic objects and collections", () => {
  const input = createInput();
  const first = createRuntimeDebugState(input);
  const second = createRuntimeDebugState(input);
  const borrowed = new Set<object>([
    input.browserMediaCapabilities, input.clientCompatibility, input.xrSessionDebug,
    input.runtimeFlags, input.faultConfig
  ]);
  function compareFresh(left: unknown, right: unknown, path: string): void {
    if (left === null || typeof left !== "object" || borrowed.has(left)) return;
    assert.notEqual(left, right, `shared diagnostic object: ${path}`);
    for (const [key, value] of Object.entries(left)) {
      compareFresh(value, (right as Record<string, unknown>)[key], `${path}.${key}`);
    }
  }
  assert.deepEqual(first, second);
  compareFresh(first, second, "debug");
  first.guestOnboarding.warnings.push("test");
  first.sceneDebug.missingAssets.push("asset");
  first.seatOccupancy.seat = "participant";
  first.mediaObjects.lastRuntimeResetSurfaceIds.push("surface-a");
  assert.deepEqual(second.guestOnboarding.warnings, []);
  assert.deepEqual(second.sceneDebug.missingAssets, []);
  assert.deepEqual(second.seatOccupancy, {});
  assert.deepEqual(second.mediaObjects.lastRuntimeResetSurfaceIds, []);
});

test("initial diagnostics are JSON serializable and preserve the initial XR and pose state", () => {
  const state = createRuntimeDebugState(createInput());
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  assert.equal(state.currentSeatId, null);
  assert.equal(state.pendingSeatId, null);
  assert.deepEqual(state.seatOccupancy, {});
  assert.deepEqual(state.xrAxes, { moveX: 0, moveY: 0, turnX: 0, turnY: 0 });
  assert.deepEqual(state.interactionRay, {
    active: false, mode: "none", targetKind: "none", seatId: null,
    point: null, origin: null, direction: null, source: null
  });
  assert.deepEqual(state.avatarPoseTransport, {
    targetHz: 0, effectiveHz: 0, sendsInLastSecond: 0, lastPoseSentAtMs: 0,
    lastPoseSeq: 0, reconnectRepublishCount: 0, frameBudgetMs: 0, adaptivePlaybackDelayMs: 100
  });
  assert.deepEqual(state.remoteAvatarParticipants, []);
  assert.deepEqual(state.remoteAvatarReliableStates, []);
  assert.deepEqual(state.remoteAvatarPoseFrames, []);
});
