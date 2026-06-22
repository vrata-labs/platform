import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { Room, RoomEvent, Track } from "livekit-client";
import {
  DEFAULT_MEDIA_SURFACE_ID,
  DISABLED_EXTENSION_CARD_TYPE,
  EXTENSION_TEST_CARD_TYPE,
  LAPTOP_MEDIA_SURFACE_ID,
  MISSING_CAPABILITY_EXTENSION_CARD_TYPE,
  REMOTE_BROWSER_OBJECT_TYPE,
  SCREEN_SHARE_OBJECT_TYPE,
  SURFACE_TEST_CARD_TYPE,
  WHITEBOARD_MEDIA_SURFACE_ID,
  WHITEBOARD_MAX_POINTS_PER_STROKE,
  WHITEBOARD_OBJECT_TYPE,
  createRoomAccessDebugState,
  getMediaExtensionDebugSnapshot,
  hasRoomPermission,
  isMediaObjectTypeAvailable,
  type MediaObjectInstance,
  type RemoteBrowserErrorCode,
  type RemoteBrowserExecutorInputState,
  type RemoteBrowserObjectState,
  type RemoteBrowserPatch,
  type RoomMediaObjectsState,
  type ScreenShareErrorCode,
  type ScreenShareObjectState,
  type SurfaceInputEvent,
  type SurfaceInputButton,
  type SurfaceInputKind,
  type SurfaceInputScrollDelta,
  type SurfaceInputSource,
  type SurfaceTestCardState,
  type WhiteboardStroke,
  type WhiteboardState
} from "@vrata/shared-types";

import { appendBrandingSuffix, applyRoomShellBootState } from "./boot-session.js";
import { bootRuntime, fetchRuntimeSpaces, listPresence, planVoiceSession, removePresence, resolveCurrentSpace, upsertPresence, type PresenceState, type RuntimeSpaceOption } from "./index.js";
import { createMotionTrack, pushMotionSample, sampleMotion, type MotionTrack } from "./motion-state.js";
import { mergePresenceSources } from "./presence-sources.js";
import {
  connectRoomState,
  sendAvatarPoseFrame,
  sendAvatarReliableState,
  sendParticipantUpdate,
  type RoomStateClient,
  type RoomStateSnapshot,
  type SurfaceCommandResult
} from "./room-state-client.js";
import { classifyMediaError, classifyRoomStateError, classifyScreenShareError, createFaultError, getRuntimeIssue, shouldRetryConnection, type RuntimeIssue } from "./runtime-errors.js";
import { canRetry, createReconnectPolicy, getReconnectDelayMs } from "./reconnect.js";
import { applyRuntimeIssueState, clearRuntimeIssueState, createRuntimeUiState } from "./runtime-state.js";
import { applyPassiveMediaRecovery, applyPostBootControls, shouldStartPassiveMedia } from "./runtime-startup.js";
import { describeMediaCapabilityReason, detectBrowserMediaCapabilities, formatUnsupportedMediaCapabilities } from "./media-capabilities.js";
import { collectWebRtcDiagnostics, createUnavailableWebRtcDiagnostics, type WebRtcStatsTransport, type WebRtcTransportRole } from "./webrtc-diagnostics.js";
import { isScreenShareAudioSource, shouldPublishMediaSurfaceAudio } from "./media-surface-audio.js";
import { createMediaSurfaceCommandClient } from "./media/media-surface-commands.js";
import {
  activeMediaObjectForSurface as selectActiveMediaObjectForSurface,
  activeMediaObjectIdForSurface as selectActiveMediaObjectIdForSurface,
  activeRemoteBrowserObjectForSurface as selectActiveRemoteBrowserObjectForSurface,
  activeScreenShareObjectForSurface as selectActiveScreenShareObjectForSurface,
  activeWhiteboardObjectForSurface as selectActiveWhiteboardObjectForSurface,
  remoteBrowserObjectForMediaTrack,
  remoteBrowserObjectNeedsLiveKitRoom,
  resolveScreenShareSurfaceForOwner,
  screenShareObjectForMediaTrack
} from "./media/media-object-state.js";
import { routeMediaObjectSurfaceInput } from "./media/media-object-router.js";
import { createRemoteBrowserObjectRuntime } from "./media/remote-browser-object.js";
import {
  createRemoteBrowserVrKeyboardView,
  cycleRemoteBrowserVrKeyboardLayout,
  planRemoteBrowserVrKeyboardInput,
  resolveRemoteBrowserVrKeyboardHit,
  setRemoteBrowserVrKeyboardActive,
  setRemoteBrowserVrKeyboardOpen,
  setRemoteBrowserVrKeyboardTargets,
  targetFromRemoteBrowserVrKeyboardHit,
  type RemoteBrowserVrKeyboardHit,
  type RemoteBrowserVrKeyboardTarget
} from "./media/remote-browser-vr-keyboard.js";
import { planRemoteBrowserXrPointer } from "./media/remote-browser-xr-input.js";
import { getScreenShareErrorCode } from "./media/screen-share-object.js";
import { createWhiteboardObjectRuntime } from "./media/whiteboard-object.js";
import { applySpatialSettings, createSpatialAudioSettings } from "./spatial-audio.js";
import { captureCanvasDiagnostics, createEmptySceneDiagnostics, inspectSceneObject } from "./scene-debug.js";
import { loadSceneBundle } from "./scene-loader.js";
import { startSceneBundleSession } from "./scene-session.js";
import { detectXrSupport, getEnterVrVisibility } from "./xr.js";
import { createAvatarLoadingDiagnostics, createEmptyAvatarDiagnostics } from "./avatar/avatar-debug.js";
import { createAvatarLipsyncDriver, sampleAvatarLipsyncLevel, updateAvatarLipsyncDriver, type AvatarLipsyncDriver, type AvatarLipsyncSourceState } from "./avatar/avatar-lipsync.js";
import { createAvatarOutboundPublisher, type AvatarOutboundPayload } from "./avatar/avatar-publish.js";
import { createRemoteAvatarRuntime } from "./avatar/remote-avatar-runtime.js";
import { createInitialAvatarRuntimeFlags, resolveAvatarCatalogUrl, resolveAvatarRuntimeFlags } from "./avatar/avatar-runtime.js";
import { resolveSeatRootPosition } from "./avatar/avatar-seating.js";
import { resolveAvatarViewProfile } from "./avatar/avatar-visibility.js";
import { createSyntheticLocalAvatarHandFrame, resolveLocalAvatarHandFrame, type LocalAvatarHandFrameResult } from "./avatar/avatar-xr-hands.js";
import { resolveAvatarXrInput } from "./avatar/avatar-xr-input.js";
import { setAvatarSandboxStatus } from "./avatar/avatar-sandbox.js";
import { resetAvatarSession, startAvatarSandboxSession, startLocalAvatarSession } from "./avatar/avatar-session.js";
import type { LocalAvatarController } from "./avatar/avatar-controller.js";
import type { LocalAvatarSnapshotV1 } from "./avatar/avatar-types.js";
import { createAvatarRegistry } from "./avatar/avatar-registry.js";
import type { SceneBundleSeatAnchor } from "./scene-bundle.js";
import { createLocalPoseController, type Vector3Like } from "./local/local-pose.js";
import { resolveDesktopTouchInputIntents, resolveTouchControlZone, resolveTouchDragMoveVector, resolveXrConfirmInteractionIntent, resolveXrInputIntents, type TouchControlZone } from "./input/input-intents.js";
import type { RuntimeFrameContext } from "./input/runtime-frame-context.js";
import {
  applySurfaceInputResolution,
  createSurfaceInputDebugState,
  createSyntheticSurfaceHit,
  recordSurfaceInputHit,
  resolveSurfaceHitFromRay,
  resolveSurfaceHitFromPlanePoint,
  resolveSurfaceInputEvent,
  tryFocusSurface,
  type ResolvedSurfaceHit
} from "./input/surface-input.js";
import { resolveXrPencilPose, type XrPencilPose } from "./input/xr-pencil.js";
import { executeFrameLocomotionCommands, type FrameLocomotionCommand } from "./locomotion/frame-command-bridge.js";
import { executeFrameLocomotionPipeline, type FrameLocomotionPipelineHandlers } from "./locomotion/frame-locomotion.js";
import { createInteractionCommandPlanner } from "./locomotion/interaction-command-planner.js";
import { createRuntimeCommandExecutor } from "./locomotion/runtime-command-bridge.js";
import {
  applyAcceptedSeatClaimToOccupancy,
  applyForcedSeatOccupancy,
  removeParticipantFromSeatOccupancy
} from "./seating/seat-occupancy.js";
import { createSeatingController } from "./seating/seating-controller.js";
import {
  createSeatAnchorReadModel,
  planMissingCurrentSeatAnchorCommands,
  planSeatAnchorReconciliation
} from "./seating/seat-anchor-reconcile.js";
import { planSeatReclaimOnReconnect, shouldRetrySeatReclaim } from "./seating/seat-reclaim.js";
import { resolveRuntimeInteractionRay, updateInteractionRayState } from "./interaction/interaction-frame.js";
import { clearInteractionRayView, createInteractionRayView, showInteractionRayPointView } from "./interaction/interaction-ray-view.js";
import { createInteractionTargetPerformer } from "./interaction/interaction-perform.js";
import { createSeatMarkerViewController } from "./interaction/seat-marker-view.js";

function fallbackUuid(): string {
  return `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getStoredValue(storage: Storage, key: string, legacyKey: string): string | null {
  const value = storage.getItem(key);
  if (value !== null) {
    return value;
  }
  const legacyValue = storage.getItem(legacyKey);
  if (legacyValue !== null) {
    storage.setItem(key, legacyValue);
  }
  return legacyValue;
}

function getParticipantId(): string {
  const stored = getStoredValue(sessionStorage, "vrata.participantId", "noah.participantId");
  if (stored) {
    return stored;
  }

  const generated = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : fallbackUuid();
  sessionStorage.setItem("vrata.participantId", generated);
  return generated;
}

function mustElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`runtime_dom_missing:${selector}`);
  }
  return element;
}

function parseBotStart(value: string | null): { x: number; z: number } | null {
  if (!value) {
    return null;
  }
  const [xRaw, zRaw] = value.split(",");
  const x = Number.parseFloat(xRaw ?? "");
  const z = Number.parseFloat(zRaw ?? "");
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    return null;
  }
  return { x, z };
}

const apiBaseUrl = window.location.origin;
const roomId = window.location.pathname.split("/").filter(Boolean)[1] ?? "demo-room";
const query = new URLSearchParams(window.location.search);
const debugEnabled = query.get("debug") === "1";
const sceneFitEnabled = debugEnabled && query.get("scenefit") !== "0";
const sceneMaterialDebugMode = debugEnabled ? (query.get("mat") ?? "off") : "off";
const requestedCleanSceneMode = query.get("clean") === "1";
const avatarSandboxEnabled = query.get("avatarsandbox") === "1" || query.get("avatarSandbox") === "1";
const avatarLegIkQueryOverrideEnabled = query.get("avatarik") === "1";
const avatarVrMockEnabled = debugEnabled && query.get("avatarvrmock") === "1";
const presenceXrMockEnabled = debugEnabled && query.get("xrmock") === "1";
const botMode = query.get("bot") ?? "off";
const botSpeed = Math.max(0.1, Number.parseFloat(query.get("botSpeed") ?? "1") || 1);
const botStart = parseBotStart(query.get("botStart"));
const spatialAudioRequested = query.get("spatial") !== "0";
const shareMockEnabled = query.get("sharemock") === "1";
const audioMockEnabled = debugEnabled && query.get("audiomock") === "1";
const failSpaces = query.get("failspaces") === "1";
const roomStateFaultMode = query.get("failroomstate");
const audioFaultMode = query.get("failaudio");
const faultConfig = {
  audio: (audioFaultMode === "connection_failed" ? "media_network_blocked" : audioFaultMode) as RuntimeIssue["code"] | null,
  roomState: roomStateFaultMode === "1" || roomStateFaultMode === "temporary",
  xrUnavailable: query.get("failxr") === "1"
};
const participantId = getParticipantId();
const displayNameFromQuery = query.get("name");
const displayName = displayNameFromQuery ?? getStoredValue(localStorage, "vrata.displayName", "noah.displayName") ?? `Guest-${participantId.slice(0, 4)}`;
if (!displayNameFromQuery) {
  localStorage.setItem("vrata.displayName", displayName);
}
const browserMediaCapabilities = detectBrowserMediaCapabilities({
  isSecureContext: window.isSecureContext,
  mediaDevices: navigator.mediaDevices,
  rtcPeerConnection: globalThis.RTCPeerConnection
});

const roomNameEl = mustElement<HTMLDivElement>("#room-name");
const statusLineEl = mustElement<HTMLDivElement>("#status-line");
const brandingLineEl = mustElement<HTMLDivElement>("#branding-line");
const roomStateLineEl = mustElement<HTMLDivElement>("#room-state-line");
const reportLineEl = mustElement<HTMLDivElement>("#report-line");
const diagnosticsLink = mustElement<HTMLAnchorElement>("#diagnostics-link");
const guestAccessLineEl = mustElement<HTMLDivElement>("#guest-access-line");
const spaceSelect = mustElement<HTMLSelectElement>("#space-select");
const spaceSelectStatusEl = mustElement<HTMLDivElement>("#space-select-status");
const sceneHost = mustElement<HTMLDivElement>("#scene");
const mediaSurfaceSelect = mustElement<HTMLSelectElement>("#media-surface-select");
const joinAudioButton = mustElement<HTMLButtonElement>("#join-audio");
const muteButton = mustElement<HTMLButtonElement>("#toggle-mute");
const startWhiteboardButton = mustElement<HTMLButtonElement>("#start-whiteboard");
const drawWhiteboardButton = mustElement<HTMLButtonElement>("#draw-whiteboard");
const clearWhiteboardButton = mustElement<HTMLButtonElement>("#clear-whiteboard");
const stopWhiteboardButton = mustElement<HTMLButtonElement>("#stop-whiteboard");
const startShareButton = mustElement<HTMLButtonElement>("#start-share");
const stopShareButton = mustElement<HTMLButtonElement>("#stop-share");
const remoteBrowserControlEl = mustElement<HTMLDivElement>("#remote-browser-control");
const remoteBrowserUrlInput = mustElement<HTMLInputElement>("#remote-browser-url");
const openRemoteBrowserButton = mustElement<HTMLButtonElement>("#open-remote-browser");
const takeRemoteBrowserControlButton = mustElement<HTMLButtonElement>("#take-remote-browser-control");
const releaseRemoteBrowserControlButton = mustElement<HTMLButtonElement>("#release-remote-browser-control");
const stopRemoteBrowserButton = mustElement<HTMLButtonElement>("#stop-remote-browser");
const remoteBrowserStatusEl = mustElement<HTMLDivElement>("#remote-browser-status");
const micSelect = mustElement<HTMLSelectElement>("#mic-select");
const speakerSelect = mustElement<HTMLSelectElement>("#speaker-select");
const micLevelFill = mustElement<HTMLDivElement>("#mic-level-fill");
const speakerLevelFill = mustElement<HTMLDivElement>("#speaker-level-fill");
const audioDeviceStatusEl = mustElement<HTMLDivElement>("#audio-device-status");
const surfaceAudioControlEl = mustElement<HTMLDivElement>("#surface-audio-control");
const surfaceAudioCheckbox = mustElement<HTMLInputElement>("#surface-audio-enabled");
const surfaceAudioStatusEl = mustElement<HTMLDivElement>("#surface-audio-status");
const xrDebugPanelEl = mustElement<HTMLDivElement>("#xr-debug-panel");
const debugPanel = mustElement<HTMLPreElement>("#debug-panel");
const avatarSandboxPanel = mustElement<HTMLDivElement>("#avatar-sandbox-panel");
const avatarPresetSelect = mustElement<HTMLSelectElement>("#avatar-preset-select");
const avatarSandboxStatusEl = mustElement<HTMLDivElement>("#avatar-sandbox-status");
const avatarPresetLabel = mustElement<HTMLLabelElement>('label[for="avatar-preset-select"]');

const diagnosticsUrl = new URL("/diagnostics", apiBaseUrl);
diagnosticsUrl.searchParams.set("roomId", roomId);
diagnosticsLink.href = diagnosticsUrl.toString();

if (debugEnabled) {
  debugPanel.hidden = false;
  xrDebugPanelEl.hidden = false;
}

avatarSandboxPanel.hidden = !avatarSandboxEnabled;

void refreshAudioDevices(false).catch((error: unknown) => {
  console.error(error);
  updateAudioDeviceStatus("Audio devices unavailable");
});
if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    void refreshAudioDevices(false).catch((error: unknown) => {
      console.error(error);
      updateAudioDeviceStatus("Audio devices unavailable");
    });
  });
}

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x08111f, 12, 50);
const defaultSceneFog = scene.fog;

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 1.6, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: debugEnabled });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
sceneHost.append(renderer.domElement);

const player = new THREE.Group();
const pitch = new THREE.Group();
pitch.add(camera);
player.add(pitch);
scene.add(player);
const initialLocalPosition = { x: botStart?.x ?? 0, y: 0, z: botStart?.z ?? 6 };
const localPoseController = createLocalPoseController({
  player,
  pitch,
  initialPose: {
    position: initialLocalPosition,
    yaw: 0,
    pitch: 0
  }
});
const WHITEBOARD_PENCIL_TIP_LOCAL_Z = -0.32;
const WHITEBOARD_PENCIL_CONTACT_DISTANCE_M = 0.06;
const WHITEBOARD_PENCIL_GRIP_ROTATION = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 8, 0, 0, "XYZ"));
const xrControllers = [renderer.xr.getController(0), renderer.xr.getController(1)];
const xrControllerGrips = [renderer.xr.getControllerGrip(0), renderer.xr.getControllerGrip(1)];
const whiteboardPencils = xrControllers.map(() => {
  const pencil = new THREE.Group();
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.012, 0.28, 10),
    new THREE.MeshBasicMaterial({ color: 0x2563eb })
  );
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = -0.12;
  const tip = new THREE.Mesh(
    new THREE.ConeGeometry(0.022, 0.07, 10),
    new THREE.MeshBasicMaterial({ color: 0x111827 })
  );
  tip.rotation.x = -Math.PI / 2;
  tip.position.z = -0.285;
  pencil.add(shaft, tip);
  pencil.visible = false;
  return pencil;
});
for (const controller of xrControllers) {
  controller.addEventListener("connected", (event) => {
    const payload = (event as { data?: { handedness?: string } }).data;
    controller.userData.handedness = payload?.handedness ?? "";
  });
  controller.addEventListener("disconnected", () => {
    controller.userData.handedness = "";
  });
  scene.add(controller);
}
for (const [index, pencil] of whiteboardPencils.entries()) {
  pencil.userData.controllerIndex = index;
  scene.add(pencil);
}
for (const grip of xrControllerGrips) {
  scene.add(grip);
}

for (const controller of xrControllers) {
  controller.addEventListener("selectstart", () => {
    if (!renderer.xr.isPresenting) {
      return;
    }
    xrSelectEventCount += 1;
    xrSelectEventPending = true;
  });
}

scene.add(new THREE.HemisphereLight(0xcbe9ff, 0x152033, 1.4));
const directional = new THREE.DirectionalLight(0xffffff, 1.4);
directional.position.set(5, 9, 3);
scene.add(directional);
const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
ambientLight.visible = false;
scene.add(ambientLight);

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40, 10, 10),
  new THREE.MeshStandardMaterial({ color: 0x163354, metalness: 0.1, roughness: 0.9, wireframe: false })
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

const interactionRayView = createInteractionRayView(scene);

const seatMarkerView = createSeatMarkerViewController();
scene.add(seatMarkerView.root);

const grid = new THREE.GridHelper(40, 40, 0x5fc8ff, 0x31587f);
grid.position.y = 0.01;
scene.add(grid);

const wallMaterial = new THREE.MeshBasicMaterial({ color: 0x244266, wireframe: true, transparent: true, opacity: 0.35 });
const roomBox = new THREE.Mesh(new THREE.BoxGeometry(14, 5, 14), wallMaterial);
roomBox.position.set(0, 2.5, 0);
scene.add(roomBox);

const DEBUG_SURFACE_ID = DEFAULT_MEDIA_SURFACE_ID;
const DEBUG_SURFACE_WIDTH_M = 5.8;
const DEBUG_SURFACE_HEIGHT_M = 3.3;
const WHITEBOARD_SURFACE_WIDTH_M = 3.2;
const WHITEBOARD_SURFACE_HEIGHT_M = 2.0;
const LAPTOP_SURFACE_WIDTH_M = 1.9;
const LAPTOP_SURFACE_HEIGHT_M = 1.1;
function createMediaSurfaceMesh(widthM: number, heightM: number, color = 0xffffff): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(widthM, heightM),
    new THREE.MeshBasicMaterial({ color, toneMapped: false })
  );
}
const displaySurface = new THREE.Mesh(
  new THREE.PlaneGeometry(DEBUG_SURFACE_WIDTH_M, DEBUG_SURFACE_HEIGHT_M),
  new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
);
displaySurface.position.set(0, 2.2, -6.6);
scene.add(displaySurface);
const whiteboardSurface = createMediaSurfaceMesh(WHITEBOARD_SURFACE_WIDTH_M, WHITEBOARD_SURFACE_HEIGHT_M, 0xf8fafc);
whiteboardSurface.position.set(-4.6, 2.0, -5.8);
whiteboardSurface.rotation.y = 0.18;
scene.add(whiteboardSurface);
const laptopSurface = createMediaSurfaceMesh(LAPTOP_SURFACE_WIDTH_M, LAPTOP_SURFACE_HEIGHT_M, 0xf8fbff);
laptopSurface.position.set(3.7, 1.45, -4.2);
laptopSurface.rotation.y = -0.28;
scene.add(laptopSurface);
const remoteBrowserVrKeyboardView = createRemoteBrowserVrKeyboardView();
displaySurface.add(remoteBrowserVrKeyboardView.root);

const whiteboardPreviewPositions = new Float32Array(WHITEBOARD_MAX_POINTS_PER_STROKE * 3);
const whiteboardPreviewGeometry = new THREE.BufferGeometry();
const whiteboardPreviewPositionAttribute = new THREE.BufferAttribute(whiteboardPreviewPositions, 3);
whiteboardPreviewPositionAttribute.setUsage(THREE.DynamicDrawUsage);
whiteboardPreviewGeometry.setAttribute("position", whiteboardPreviewPositionAttribute);
whiteboardPreviewGeometry.setDrawRange(0, 0);
const whiteboardPreviewLine = new THREE.Line(
  whiteboardPreviewGeometry,
  new THREE.LineBasicMaterial({ color: 0x2563eb, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false })
);
whiteboardPreviewLine.position.z = 0.018;
whiteboardPreviewLine.renderOrder = 40;
whiteboardPreviewLine.frustumCulled = false;
whiteboardPreviewLine.visible = false;
displaySurface.add(whiteboardPreviewLine);

const DEBUG_SURFACE_WIDTH_PX = 1920;
const DEBUG_SURFACE_HEIGHT_PX = 1080;
displaySurface.userData.surfaceId = DEBUG_SURFACE_ID;
whiteboardSurface.userData.surfaceId = WHITEBOARD_MEDIA_SURFACE_ID;
laptopSurface.userData.surfaceId = LAPTOP_MEDIA_SURFACE_ID;

interface RuntimeMediaSurfaceView {
  surfaceId: string;
  object: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  widthPx: number;
  heightPx: number;
  widthM: number;
  heightM: number;
}

const mediaSurfaceViews = new Map<string, RuntimeMediaSurfaceView>([
  [DEBUG_SURFACE_ID, { surfaceId: DEBUG_SURFACE_ID, object: displaySurface, widthPx: DEBUG_SURFACE_WIDTH_PX, heightPx: DEBUG_SURFACE_HEIGHT_PX, widthM: DEBUG_SURFACE_WIDTH_M, heightM: DEBUG_SURFACE_HEIGHT_M }],
  [WHITEBOARD_MEDIA_SURFACE_ID, { surfaceId: WHITEBOARD_MEDIA_SURFACE_ID, object: whiteboardSurface, widthPx: DEBUG_SURFACE_WIDTH_PX, heightPx: DEBUG_SURFACE_HEIGHT_PX, widthM: WHITEBOARD_SURFACE_WIDTH_M, heightM: WHITEBOARD_SURFACE_HEIGHT_M }],
  [LAPTOP_MEDIA_SURFACE_ID, { surfaceId: LAPTOP_MEDIA_SURFACE_ID, object: laptopSurface, widthPx: 1280, heightPx: 720, widthM: LAPTOP_SURFACE_WIDTH_M, heightM: LAPTOP_SURFACE_HEIGHT_M }]
]);

const fallbackEnvironment: THREE.Object3D[] = [floor, grid, roomBox];

const bodyGeometry = new THREE.CapsuleGeometry(0.24, 0.8, 6, 12);
const headGeometry = new THREE.SphereGeometry(0.18, 20, 20);
const API_PRESENCE_SYNC_INTERVAL_MS = 1000;
const API_PRESENCE_REFRESH_INTERVAL_MS = 1000;
const XR_REMOTE_BROWSER_SCROLL_AXIS_THRESHOLD = 0.22;
const XR_REMOTE_BROWSER_SCROLL_INTERVAL_MS = 80;
const XR_REMOTE_BROWSER_SCROLL_DELTA_PX = 360;
const XR_REMOTE_BROWSER_KEYBOARD_RAY_END_OFFSET_M = 0.03;
const REMOTE_BROWSER_HOVER_MOVE_INTERVAL_MS = 50;

const keyState: Record<string, boolean> = {};
let pointerActive = false;
let whiteboardPointerActive = false;
let remoteBrowserPointerActive = false;
let whiteboardDrawToolActive = false;
let xrWhiteboardPointerActive = false;
let lastXrWhiteboardHit: ResolvedSurfaceHit | null = null;
let xrRemoteBrowserPointerActive = false;
let lastXrRemoteBrowserHit: ResolvedSurfaceHit | null = null;
let lastXrRemoteBrowserScrollAtMs = 0;
let remoteBrowserVrKeyboardOpen = false;
let remoteBrowserVrKeyboardPress: RemoteBrowserVrKeyboardHit | null = null;
let lastRemoteBrowserHoverMoveAtMs = 0;
let pointerMovedSinceDown = false;
let suppressPointerClick = false;
let pointerHoveringScene = false;
let pointerDownAtMs = 0;
let pointerDownClientX = 0;
let pointerDownClientY = 0;
let livekitRoom: Room | null = null;
let microphoneEnabled = false;
let xrTurnCooldown = 0;
let xrTurnArmed = true;
let mobileTouchActive = false;
let mobileTouchIdentifier: number | null = null;
let mobileTouchZone: TouchControlZone | null = null;
let mobileTouchMovedSinceStart = false;
let mobileTouchStartClientX = 0;
let mobileTouchStartClientY = 0;
let mobileTouchLastClientX = 0;
let mobileTouchLastClientY = 0;
const mobileTouchVector = { x: 0, z: 0 };
let diagnosticsAccumulator = 0;
let latestMode: PresenceState["mode"] = presenceXrMockEnabled ? "vr" : /android|iphone|ipad/i.test(navigator.userAgent) ? "mobile" : "desktop";

type ScreenShareRuntimeEntry = {
  objectId: string;
  surfaceId: string;
  ownerParticipantId: string | null;
  mediaTrackSid: string | null;
  remote: boolean;
  track: Track | null;
  element: HTMLVideoElement | null;
  texture: THREE.Texture | null;
  stream: MediaStream | null;
  publishedTracks: MediaStreamTrack[];
  stopping: boolean;
};

const screenShareRuntimeByObjectId = new Map<string, ScreenShareRuntimeEntry>();
type RemoteBrowserVideoEntry = {
  objectId: string;
  surfaceId: string;
  track: Track;
  element: HTMLVideoElement;
  texture: THREE.Texture;
  trackSid: string;
  playError: string | null;
  frameCount: number;
  lastFrameAtMs: number;
  presentedFrames: number;
};

const remoteBrowserVideoByObjectId = new Map<string, RemoteBrowserVideoEntry>();
let lastScreenShareStoppedAtMs = 0;
let mediaRoomReady = false;
let mediaDiagnosticsTransports: WebRtcStatsTransport[] = [];
const mediaTransportDiagnosticsRooms = new WeakSet<Room>();
let remoteBrowserMediaRoomPromise: Promise<void> | null = null;
let roomStateClient: RoomStateClient | null = null;
let roomStateAccessToken = "";
let roomStateConnected = false;
let latestRealtimeParticipants: PresenceState[] = [];
let latestFallbackParticipants: PresenceState[] = [];
const retainedDisplayTextures = new Set<THREE.Texture>();
const debugTextureIds = new WeakMap<THREE.Texture, number>();
let nextDebugTextureId = 1;
let lastApiPresenceSyncAtMs = 0;
let lastApiPresenceRefreshAtMs = 0;
let apiPresenceSyncInFlight = false;
let apiPresenceRefreshInFlight = false;
let roomStateReconnectTimer: number | null = null;
let seatReclaimRetryTimer: number | null = null;
let xrSelectPressedLastFrame = false;
let xrSelectEventPending = false;
let xrSelectEventCount = 0;
let xrRayVisibleLatched = false;
let lastXrTelemetryReportAt = 0;
let lastXrTelemetryKinds: string[] = [];
let audioContext: AudioContext | null = null;
let syntheticXrState: {
  rightController: { x: number; y: number; z: number };
  rightGrip: { x: number; y: number; z: number } | null;
  rayDirection: { x: number; y: number; z: number };
  axes: { moveX: number; moveY: number; turnX: number; turnY: number };
  triggerPressed: boolean;
  rayVisible: boolean;
} | null = null;
let activeSceneBundleRoot: THREE.Object3D | null = null;
let avatarSandboxRegistry: ReturnType<typeof createAvatarRegistry> | null = null;
let localAvatarController: LocalAvatarController | null = null;
let localBodyMesh: THREE.Mesh | null = null;
let localHeadMesh: THREE.Mesh | null = null;
const seatingController = createSeatingController({ participantId });
let lastAppliedSeatLockId: string | null = null;
let lastRuntimeFrameContext: RuntimeFrameContext | null = null;
const localAvatarHandFrameCache = new WeakMap<RuntimeFrameContext, LocalAvatarHandFrameResult | null>();
const interactionCommandPlanner = createInteractionCommandPlanner();
let forcedTestInteractionRay: THREE.Ray | null = null;
let forcedTestInteractionSeatId: string | null = null;
let forcedTestSeatId: string | null = null;
let sceneTeleportFloorY = 0;
let sceneSeatAnchors: SceneBundleSeatAnchor[] = [];
let sceneSeatAnchorMap = createSeatAnchorReadModel([]).anchorMap;
let sceneAnchorsReady = true;
let roomSeatOccupancy: Record<string, string> = {};
let roomMediaObjects: RoomMediaObjectsState | null = null;
let selectedMediaSurfaceId = DEBUG_SURFACE_ID;
const mediaSurfaceCommands = createMediaSurfaceCommandClient({
  participantId,
  getClient: () => roomStateClient,
  isConnected: () => roomStateConnected,
  createConnectionError: () => createFaultError("ConnectionError", "room_state_failed")
});
const whiteboardRuntimes = new Map<string, ReturnType<typeof createWhiteboardObjectRuntime>>();
const remoteBrowserRuntimes = new Map<string, ReturnType<typeof createRemoteBrowserObjectRuntime>>();

function getWhiteboardRuntime(surfaceId: string): ReturnType<typeof createWhiteboardObjectRuntime> {
  const existing = whiteboardRuntimes.get(surfaceId);
  if (existing) {
    return existing;
  }
  const surface = getMediaSurfaceView(surfaceId);
  const runtime = createWhiteboardObjectRuntime({
    participantId,
    surfaceId,
    widthPx: surface.widthPx,
    heightPx: surface.heightPx,
    getPermissions: () => debugState.access.permissions,
    getLatestObject: (targetSurfaceId) => activeWhiteboardObjectForSurface(targetSurfaceId),
    patchObject: (objectId, targetSurfaceId, expectedRevision, patch) => mediaSurfaceCommands.patchWhiteboardObject(objectId, targetSurfaceId, expectedRevision, patch),
    applyTexture: (texture) => applySurfaceTexture(surfaceId, texture),
    applyPreview: (stroke) => applyWhiteboardPreviewOverlay(surfaceId, stroke),
    onBlocked: (blockedReason, errorCode) => {
      debugState.mediaObjects.blockedReason = blockedReason;
      debugState.whiteboard.errorCode = errorCode;
    }
  });
  whiteboardRuntimes.set(surfaceId, runtime);
  retainedDisplayTextures.add(runtime.texture);
  return runtime;
}

function currentWhiteboardObject(): MediaObjectInstance<WhiteboardState> | null {
  return activeWhiteboardObjectForSurface(selectedMediaSurfaceId) ?? findActiveWhiteboardObject();
}

function getRemoteBrowserRuntime(surfaceId: string): ReturnType<typeof createRemoteBrowserObjectRuntime> {
  const existing = remoteBrowserRuntimes.get(surfaceId);
  if (existing) {
    return existing;
  }
  const surface = getMediaSurfaceView(surfaceId);
  const runtime = createRemoteBrowserObjectRuntime({
    apiBaseUrl,
    roomId,
    participantId,
    getSessionToken: () => roomStateAccessToken,
    surfaceId,
    widthPx: surface.widthPx,
    heightPx: surface.heightPx,
    getPermissions: () => debugState.access.permissions,
    getLatestObject: (targetSurfaceId) => activeRemoteBrowserObjectForSurface(targetSurfaceId),
    patchObject: (objectId, targetSurfaceId, expectedRevision, patch) => mediaSurfaceCommands.patchRemoteBrowserObject(objectId, targetSurfaceId, expectedRevision, patch),
    isExternalVideoActive: (object) => Boolean(remoteBrowserVideoEntryForObject(object.objectId)?.element),
    applyTexture: (texture) => applySurfaceTexture(surfaceId, texture),
    onBlocked: (blockedReason, errorCode) => {
      debugState.mediaObjects.blockedReason = blockedReason;
      debugState.remoteBrowser.errorCode = errorCode as RemoteBrowserErrorCode | string | null;
    }
  });
  remoteBrowserRuntimes.set(surfaceId, runtime);
  retainedDisplayTextures.add(runtime.texture);
  return runtime;
}

function currentRemoteBrowserObject(): MediaObjectInstance<RemoteBrowserObjectState> | null {
  return activeRemoteBrowserObjectForSurface(selectedMediaSurfaceId) ?? findActiveRemoteBrowserObject();
}

function activeWhiteboardObjects(): Array<MediaObjectInstance<WhiteboardState>> {
  if (!roomMediaObjects) {
    return [];
  }
  const objects: Array<MediaObjectInstance<WhiteboardState>> = [];
  for (const surfaceId of Object.keys(roomMediaObjects.surfaces)) {
    const object = activeWhiteboardObjectForSurface(surfaceId);
    if (object) {
      objects.push(object);
    }
  }
  return objects;
}

function syncWhiteboardSurfaceTextures(): void {
  const activeSurfaceIds = new Set<string>();
  for (const object of activeWhiteboardObjects()) {
    if (!mediaSurfaceViews.has(object.surfaceId)) {
      continue;
    }
    activeSurfaceIds.add(object.surfaceId);
    getWhiteboardRuntime(object.surfaceId).render(object.state);
  }
  for (const [surfaceId, runtime] of whiteboardRuntimes) {
    if (!activeSurfaceIds.has(surfaceId)) {
      runtime.clearPreview();
      const material = getMediaSurfaceView(surfaceId).object.material;
      if (material instanceof THREE.MeshBasicMaterial && runtime.ownsTexture(material.map)) {
        applySurfaceTexture(surfaceId, null);
      }
    }
  }
}

function activeRemoteBrowserObjects(): Array<MediaObjectInstance<RemoteBrowserObjectState>> {
  if (!roomMediaObjects) {
    return [];
  }
  const objects: Array<MediaObjectInstance<RemoteBrowserObjectState>> = [];
  for (const surfaceId of Object.keys(roomMediaObjects.surfaces)) {
    const object = activeRemoteBrowserObjectForSurface(surfaceId);
    if (object) {
      objects.push(object);
    }
  }
  return objects;
}

function syncRemoteBrowserSurfaceTextures(): void {
  const activeSurfaceIds = new Set<string>();
  syncRemoteBrowserVideoRuntimeWithObjects();
  for (const object of activeRemoteBrowserObjects()) {
    if (!mediaSurfaceViews.has(object.surfaceId)) {
      continue;
    }
    activeSurfaceIds.add(object.surfaceId);
    getRemoteBrowserRuntime(object.surfaceId).sync(object);
  }
  for (const [surfaceId, runtime] of remoteBrowserRuntimes) {
    if (activeSurfaceIds.has(surfaceId)) {
      continue;
    }
    runtime.close();
    const material = getMediaSurfaceView(surfaceId).object.material;
    if (material instanceof THREE.MeshBasicMaterial && runtime.ownsTexture(material.map)) {
      applySurfaceTexture(surfaceId, null);
    }
  }
}

let surfaceAudioCommandPending = false;
let surfaceAudioPendingEnabled: boolean | null = null;
const pointerNdc = new THREE.Vector2(0, 0);
const interactionRaycaster = new THREE.Raycaster();
const surfaceInputRaycaster = new THREE.Raycaster();
const remoteBrowserVrKeyboardRaycaster = new THREE.Raycaster();
const cameraWorldPosition = new THREE.Vector3();
const forcedInteractionDirection = new THREE.Vector3();
const avatarOutboundPublisher = createAvatarOutboundPublisher();
let lastAvatarMove = { x: 0, z: 0 };
let lastAvatarTurnRate = 0;
let currentBotMove = { x: 0, z: 0 };
let surfaceInputSeq = 0;
let lastAvatarXrInputProfile: string | null = null;
let lastAvatarPoseSentAtMs = 0;
let preferredMicDeviceId = getStoredValue(localStorage, "vrata.audioinput", "noah.audioinput") ?? "default";
let preferredSpeakerDeviceId = getStoredValue(localStorage, "vrata.audiooutput", "noah.audiooutput") ?? "default";
let audioInputDevices: MediaDeviceInfo[] = [];
let audioOutputDevices: MediaDeviceInfo[] = [];
let localMicLevel = 0;
let speakerOutputLevel = 0;
const avatarPoseSendTimestamps: number[] = [];
const recentFrameBudgetMs: number[] = [];
const roomStateReconnectPolicy = createReconnectPolicy({
  maxRetries: Number.parseInt(query.get("roomstateretries") ?? "3", 10),
  baseDelayMs: Number.parseInt(query.get("roomstatedelay") ?? "1000", 10),
  maxDelayMs: Number.parseInt(query.get("roomstatemaxdelay") ?? "8000", 10)
});
const botStartedAtSeconds = performance.now() / 1000;
const botInitialPosition = { x: initialLocalPosition.x, z: initialLocalPosition.z };

interface RemoteAudioNode {
  participantId: string;
  element: HTMLMediaElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
  panner: PannerNode | null;
  sampleBuffer: Uint8Array;
  lipsync: AvatarLipsyncDriver;
  trackId: string;
}

interface MediaSurfaceAudioNode {
  surfaceId: string;
  element: HTMLMediaElement;
  source: MediaStreamAudioSourceNode | null;
  analyser: AnalyserNode | null;
  sampleBuffer: Uint8Array | null;
  trackId: string;
}

interface LocalAudioNode {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  sampleBuffer: Uint8Array;
  lipsync: AvatarLipsyncDriver;
  trackId: string;
}

interface MockAudioSource {
  oscillator: OscillatorNode;
  gain: GainNode;
  destination: MediaStreamAudioDestinationNode;
  track: MediaStreamTrack;
}

const remoteAudioNodes = new Map<string, RemoteAudioNode>();
const mediaSurfaceAudioNodes = new Map<string, MediaSurfaceAudioNode>();
let localAudioNode: LocalAudioNode | null = null;
let mockAudioSource: MockAudioSource | null = null;
const localAvatarLipsync = createAvatarLipsyncDriver();
let runtimeUiState = createRuntimeUiState();
let runtimeFlags = {
  enterVr: true,
  audioJoin: true,
  screenShare: true,
  roomStateRealtime: true,
  remoteDiagnostics: true,
  sceneBundles: true,
  ...createInitialAvatarRuntimeFlags(),
  avatarFallbackCapsulesEnabled: true
};
let effectiveCleanSceneMode = requestedCleanSceneMode;
let availableSpaces: RuntimeSpaceOption[] = [];
const remoteAvatarRuntime = createRemoteAvatarRuntime({
  scene,
  bodyGeometry,
  headGeometry,
  localParticipantId: participantId
});

function setFallbackEnvironmentVisible(visible: boolean): void {
  for (const object of fallbackEnvironment) {
    object.visible = visible;
  }
}

function applyCleanSceneMode(enabled: boolean): void {
  ambientLight.visible = enabled;
  directional.visible = !enabled;
  scene.fog = enabled ? null : defaultSceneFog;
  floor.visible = !enabled;
  grid.visible = !enabled;
  roomBox.visible = !enabled;
  for (const surface of mediaSurfaceViews.values()) {
    surface.object.visible = true;
  }
}

function updateLocalPositionDebug(): void {
  const pose = localPoseController.getPose();
  debugState.localPosition = {
    x: Number(pose.position.x.toFixed(2)),
    z: Number(pose.position.z.toFixed(2))
  };
  updateLocalPresenceDiagnostics();
}

function roundDebugNumber(value: number, decimals = 3): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function resolveNonXrHeadWorldPosition(pose: ReturnType<typeof localPoseController.getPose>, headHeight = 1.6): THREE.Vector3 {
  return new THREE.Vector3(pose.position.x, pose.position.y + headHeight, pose.position.z);
}

function updateLocalPresenceDiagnostics(): void {
  const pose = localPoseController.getPose();
  const useTrackedHead = renderer.xr.isPresenting && !presenceXrMockEnabled;
  const headWorld = useTrackedHead ? camera.getWorldPosition(new THREE.Vector3()) : resolveNonXrHeadWorldPosition(pose);
  const headYaw = useTrackedHead ? getCameraWorldYaw() : pose.yaw;
  const headPitch = useTrackedHead ? getCameraWorldPitch() : pose.pitch;
  debugState.mode = latestMode;
  debugState.localPose = {
    root: {
      x: roundDebugNumber(pose.position.x),
      y: roundDebugNumber(pose.position.y),
      z: roundDebugNumber(pose.position.z),
      yaw: roundDebugNumber(pose.yaw)
    },
    head: {
      x: roundDebugNumber(headWorld.x),
      y: roundDebugNumber(headWorld.y),
      z: roundDebugNumber(headWorld.z),
      yaw: roundDebugNumber(headYaw),
      pitch: roundDebugNumber(headPitch)
    }
  };
}

function deriveMediaDebugAudioState(): "not_joined" | "joining" | "joined" | "muted" | "degraded" | "failed" {
  if (debugState.audioState === "joining") {
    return "joining";
  }
  if (debugState.issueCode === "mic_denied" || debugState.issueCode === "no_audio_device") {
    return "degraded";
  }
  if (debugState.issueCode === "audio_unsupported" || debugState.issueCode === "livekit_failed" || debugState.issueCode === "media_network_blocked" || debugState.audioState === "disabled") {
    return "failed";
  }
  if (!livekitRoom) {
    return "not_joined";
  }
  if (!microphoneEnabled) {
    return "muted";
  }
  return "joined";
}

function updateMediaDiagnostics(): void {
  debugState.media = {
    audioState: deriveMediaDebugAudioState(),
    muted: !microphoneEnabled,
    publishedAudio: Boolean(livekitRoom && microphoneEnabled),
    audioSource: livekitRoom && microphoneEnabled ? audioMockEnabled ? "mock" : "microphone" : "none",
    subscribedAudioCount: remoteAudioNodes.size,
    webrtc: debugState.media.webrtc
  };
  const activeRemoteBrowser = currentRemoteBrowserObject();
  const remoteBrowserRuntime = getRemoteBrowserRuntime(activeRemoteBrowser?.surfaceId ?? selectedMediaSurfaceId);
  if (activeRemoteBrowser) {
    remoteBrowserRuntime.sync(activeRemoteBrowser);
  }
  debugState.remoteBrowser = {
    ...debugState.remoteBrowser,
    ...remoteBrowserRuntime.createDebugSnapshot(activeRemoteBrowser),
    ...createRemoteBrowserExternalVideoDebugSnapshot(activeRemoteBrowser)
  };
}

async function refreshWebRtcDiagnostics(): Promise<void> {
  debugState.media.webrtc = await collectWebRtcDiagnostics(mediaDiagnosticsTransports);
}

function syncRemoteAudioDiagnostics(): void {
  debugState.remoteParticipants = debugState.remoteParticipants.map((participant) => ({
    ...participant,
    hasAudioNode: remoteAudioNodes.has(participant.participantId),
    activeAudio: participant.activeAudio || remoteAudioNodes.has(participant.participantId)
  }));
}

function getCurrentSeatId(): string | null {
  return seatingController.getCurrentSeatId();
}

function getPendingSeatId(): string | null {
  return seatingController.getPendingSeatId();
}

function syncSeatDebugState(): void {
  const snapshot = seatingController.getSnapshot();
  debugState.currentSeatId = snapshot.currentSeatId;
  debugState.pendingSeatId = snapshot.pendingSeatId;
}

function applySceneDebugFit(bounds: NonNullable<typeof debugState.sceneDebug.boundingBox>): void {
  const horizontalSize = Math.max(bounds.size.x, bounds.size.z, 1);
  const distance = Math.max(horizontalSize * 0.65, 12);
  // Keep the current spawn height; debug fit should reframe x/z and look-at,
  // not launch the player up to the scene's vertical center.
  const currentPose = localPoseController.getPose();
  const targetY = currentPose.position.y;

  const cameraWorld = new THREE.Vector3();
  camera.getWorldPosition(cameraWorld);
  const target = new THREE.Vector3(bounds.center.x, bounds.center.y, bounds.center.z);
  const delta = target.sub(cameraWorld);
  const yaw = Math.atan2(delta.x, delta.z) + Math.PI;
  const horizontalDistance = Math.max(0.001, Math.hypot(delta.x, delta.z));
  const pitchAngle = THREE.MathUtils.clamp(-Math.atan2(delta.y, horizontalDistance), -1.1, 1.1);
  localPoseController.setPose({
    position: { x: bounds.center.x, y: targetY, z: bounds.center.z + distance },
    yaw,
    pitch: pitchAngle
  }, "debug_fit");
  updateLocalPositionDebug();
}

function applySceneMaterialDebugMode(root: THREE.Object3D, mode: string): void {
  if (mode === "off") {
    return;
  }
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }
    if (mode === "basic") {
      child.material = new THREE.MeshBasicMaterial({ color: 0xf2efe8, wireframe: false });
      return;
    }
    if (mode === "wire") {
      child.material = new THREE.MeshBasicMaterial({ color: 0xf2efe8, wireframe: true });
    }
  });
}

function applySnapshotParticipants(people: PresenceState[]): void {
  remoteAvatarRuntime.applySnapshotParticipants(people, debugState);
  debugState.lastPresenceRefreshAt = Date.now();
}

function applyMergedPresenceParticipants(): void {
  applySnapshotParticipants(mergePresenceSources(latestRealtimeParticipants, latestFallbackParticipants));
}

function clearInteractionVisuals(): void {
  clearInteractionRayView({
    view: interactionRayView,
    state: debugState.interactionRay,
    markTelemetry: markXrTelemetry
  });
  updateSeatMarkerVisuals(performance.now() / 1000);
}

function updateSeatMarkerVisuals(timeSeconds: number): void {
  seatMarkerView.update({
    hoveredSeatId: debugState.interactionRay.seatId,
    currentSeatId: getCurrentSeatId(),
    pendingSeatId: getPendingSeatId(),
    occupancy: roomSeatOccupancy,
    timeSeconds
  });
}

function setSceneSeatAnchors(anchors: SceneBundleSeatAnchor[], teleportFloorY = 0): void {
  const readModel = createSeatAnchorReadModel(anchors, teleportFloorY);
  sceneSeatAnchors = readModel.anchors;
  sceneSeatAnchorMap = readModel.anchorMap;
  seatMarkerView.rebuild(readModel.anchors);
  sceneTeleportFloorY = readModel.teleportFloorY;
  sceneAnchorsReady = true;
  const reconciliation = seatingController.reconcileAnchors(readModel.availableSeatIds);
  syncSeatDebugState();
  const plan = planSeatAnchorReconciliation({
    releases: reconciliation.commands,
    seatOccupancy: roomSeatOccupancy,
    participantId
  });
  roomSeatOccupancy = plan.seatOccupancy;
  if (plan.resetSeatLock) {
    lastAppliedSeatLockId = null;
  }
  if (plan.commands.length > 0) {
    debugState.seatOccupancy = { ...roomSeatOccupancy };
    executeRuntimeCommandList(plan.commands);
  }
  updateSeatMarkerVisuals(performance.now() / 1000);
}

function releaseCurrentSeatLocally(): void {
  forcedTestSeatId = null;
  roomSeatOccupancy = removeParticipantFromSeatOccupancy(roomSeatOccupancy, participantId);
  seatingController.releaseLocal();
  lastAppliedSeatLockId = null;
  syncSeatDebugState();
  debugState.seatOccupancy = { ...roomSeatOccupancy };
  updateSeatMarkerVisuals(performance.now() / 1000);
}

function syncSeatStateFromOccupancy(): void {
  roomSeatOccupancy = applyForcedSeatOccupancy(roomSeatOccupancy, { forcedSeatId: forcedTestSeatId, participantId });
  debugState.seatOccupancy = { ...roomSeatOccupancy };
  seatingController.applyOccupancy({ seatOccupancy: roomSeatOccupancy, forcedSeatId: forcedTestSeatId });
  syncSeatDebugState();
  updateSeatMarkerVisuals(performance.now() / 1000);
  const currentSeatId = getCurrentSeatId();
  if (!currentSeatId) {
    lastAppliedSeatLockId = null;
    return;
  }
  const commands = planMissingCurrentSeatAnchorCommands({
    currentSeatId,
    anchorsReady: sceneAnchorsReady,
    seatAnchorMap: sceneSeatAnchorMap
  });
  if (commands.length > 0) {
    executeRuntimeCommandList(commands);
  }
}

function activeMediaObjectForSurface(surfaceId: string): MediaObjectInstance | null {
  return selectActiveMediaObjectForSurface(roomMediaObjects, surfaceId);
}

function activeMediaObjectIdForSurface(surfaceId: string): string | undefined {
  return selectActiveMediaObjectIdForSurface(roomMediaObjects, surfaceId);
}

function activeScreenShareObjectForSurface(surfaceId: string): MediaObjectInstance<ScreenShareObjectState> | null {
  return selectActiveScreenShareObjectForSurface(roomMediaObjects, surfaceId);
}

function activeWhiteboardObjectForSurface(surfaceId: string): MediaObjectInstance<WhiteboardState> | null {
  return selectActiveWhiteboardObjectForSurface(roomMediaObjects, surfaceId);
}

function activeRemoteBrowserObjectForSurface(surfaceId: string): MediaObjectInstance<RemoteBrowserObjectState> | null {
  return selectActiveRemoteBrowserObjectForSurface(roomMediaObjects, surfaceId);
}

function findActiveObjectByType<State>(type: string): MediaObjectInstance<State> | null {
  if (!roomMediaObjects) {
    return null;
  }
  for (const object of Object.values(roomMediaObjects.objects)) {
    if (object.type === type && roomMediaObjects.surfaces[object.surfaceId]?.activeObjectId === object.objectId) {
      return object as MediaObjectInstance<State>;
    }
  }
  return null;
}

function findActiveScreenShareObject(): MediaObjectInstance<ScreenShareObjectState> | null {
  return findActiveObjectByType<ScreenShareObjectState>(SCREEN_SHARE_OBJECT_TYPE);
}

function findLocalActiveScreenShareObject(surfaceId?: string): MediaObjectInstance<ScreenShareObjectState> | null {
  if (!roomMediaObjects) {
    return null;
  }
  for (const object of Object.values(roomMediaObjects.objects)) {
    if (object.type !== SCREEN_SHARE_OBJECT_TYPE || object.ownerParticipantId !== participantId) {
      continue;
    }
    if (surfaceId && object.surfaceId !== surfaceId) {
      continue;
    }
    if (roomMediaObjects.surfaces[object.surfaceId]?.activeObjectId === object.objectId) {
      return object as MediaObjectInstance<ScreenShareObjectState>;
    }
  }
  return null;
}

function findActiveWhiteboardObject(): MediaObjectInstance<WhiteboardState> | null {
  return findActiveObjectByType<WhiteboardState>(WHITEBOARD_OBJECT_TYPE);
}

function findActiveRemoteBrowserObject(): MediaObjectInstance<RemoteBrowserObjectState> | null {
  return findActiveObjectByType<RemoteBrowserObjectState>(REMOTE_BROWSER_OBJECT_TYPE);
}

function findRemoteBrowserObjectNeedingLiveKitRoom(): MediaObjectInstance<RemoteBrowserObjectState> | null {
  return activeRemoteBrowserObjects().find((object) => remoteBrowserObjectNeedsLiveKitRoom(object)) ?? null;
}

function syncMediaSurfaceObjectIds(): void {
  for (const surface of mediaSurfaceViews.values()) {
    surface.object.userData.objectId = activeMediaObjectIdForSurface(surface.surfaceId) ?? null;
  }
}

function getMediaSurfaceView(surfaceId: string): RuntimeMediaSurfaceView {
  return mediaSurfaceViews.get(surfaceId) ?? mediaSurfaceViews.get(DEBUG_SURFACE_ID)!;
}

function getSelectedMediaSurfaceView(): RuntimeMediaSurfaceView {
  return getMediaSurfaceView(selectedMediaSurfaceId);
}

function getKnownMediaSurfaceIds(): string[] {
  const ids = new Set<string>([DEBUG_SURFACE_ID, WHITEBOARD_MEDIA_SURFACE_ID, LAPTOP_MEDIA_SURFACE_ID]);
  for (const surfaceId of Object.keys(roomMediaObjects?.surfaces ?? {})) {
    ids.add(surfaceId);
  }
  return Array.from(ids);
}

function getMediaSurfaceLabel(surfaceId: string): string {
  return roomMediaObjects?.surfaces[surfaceId]?.label
    ?? (surfaceId === DEBUG_SURFACE_ID ? "Main screen" : surfaceId === WHITEBOARD_MEDIA_SURFACE_ID ? "Whiteboard wall" : surfaceId === LAPTOP_MEDIA_SURFACE_ID ? "Laptop screen" : surfaceId);
}

function surfaceAllowsObject(surfaceId: string, objectType: string): boolean {
  const surface = roomMediaObjects?.surfaces[surfaceId];
  return surface?.allowedObjectTypes.includes(objectType) ?? true;
}

function selectMediaSurface(surfaceId: string): boolean {
  if (!mediaSurfaceViews.has(surfaceId) && !roomMediaObjects?.surfaces[surfaceId]) {
    return false;
  }
  selectedMediaSurfaceId = surfaceId;
  mediaSurfaceSelect.value = surfaceId;
  syncMediaObjectsDebugState();
  return true;
}

function syncMediaSurfaceSelector(): void {
  const surfaceIds = getKnownMediaSurfaceIds();
  if (!surfaceIds.includes(selectedMediaSurfaceId)) {
    selectedMediaSurfaceId = DEBUG_SURFACE_ID;
  }
  mediaSurfaceSelect.replaceChildren();
  for (const surfaceId of surfaceIds) {
    const option = document.createElement("option");
    option.value = surfaceId;
    option.textContent = getMediaSurfaceLabel(surfaceId);
    option.selected = surfaceId === selectedMediaSurfaceId;
    mediaSurfaceSelect.appendChild(option);
  }
  mediaSurfaceSelect.disabled = surfaceIds.length < 2;
}

async function setMediaSurfaceAudioEnabled(surfaceId: string, enabled: boolean): Promise<SurfaceCommandResult> {
  return mediaSurfaceCommands.setMediaSurfaceAudioEnabled(surfaceId, enabled);
}

function canConfigureSurfaceAudio(): boolean {
  return hasRoomPermission(debugState.access.permissions, "surface.configure-audio");
}

function syncSurfaceAudioControl(): void {
  const surface = roomMediaObjects?.surfaces[selectedMediaSurfaceId] ?? null;
  const canConfigure = canConfigureSurfaceAudio();
  const mediaAudioEnabled = surfaceAudioPendingEnabled ?? surface?.mediaAudioEnabled === true;
  surfaceAudioControlEl.hidden = !canConfigure;
  surfaceAudioCheckbox.checked = mediaAudioEnabled;
  surfaceAudioCheckbox.disabled = !canConfigure || !roomStateConnected || !surface || surfaceAudioCommandPending;
  debugState.surfaceAudio = {
    surfaceId: surface?.surfaceId ?? selectedMediaSurfaceId,
    mediaAudioEnabled,
    canConfigure,
    pending: surfaceAudioCommandPending,
    subscribedAudioCount: mediaSurfaceAudioNodes.size
  };
  if (!surface) {
    surfaceAudioStatusEl.textContent = "Media surface unavailable";
  } else if (surfaceAudioCommandPending) {
    surfaceAudioStatusEl.textContent = "Updating media surface audio...";
  } else {
    surfaceAudioStatusEl.textContent = surface.mediaAudioEnabled
      ? "Media audio will be requested when a share starts"
      : "Media audio is muted for new media on this surface";
  }
}

function normalizeRemoteBrowserUrlInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return new URL("/remote-browser-demo.html", apiBaseUrl).toString();
  }
  return new URL(trimmed, apiBaseUrl).toString();
}

function canUseRemoteBrowserOpenControl(): boolean {
  return roomStateConnected
    && hasRoomPermission(debugState.access.permissions, "remote-browser.open-url")
    && surfaceAllowsObject(selectedMediaSurfaceId, REMOTE_BROWSER_OBJECT_TYPE);
}

function syncRemoteBrowserControls(): void {
  const activeObject = activeMediaObjectForSurface(selectedMediaSurfaceId);
  const remoteBrowser = activeRemoteBrowserObjectForSurface(selectedMediaSurfaceId);
  const remoteBrowserRuntime = getRemoteBrowserRuntime(selectedMediaSurfaceId);
  const snapshot = remoteBrowserRuntime.createDebugSnapshot(remoteBrowser);
  debugState.remoteBrowser = { ...debugState.remoteBrowser, ...snapshot, ...createRemoteBrowserExternalVideoDebugSnapshot(remoteBrowser) };
  const canOpen = canUseRemoteBrowserOpenControl();
  const canInput = hasRoomPermission(debugState.access.permissions, "remote-browser.input");
  const hasOtherObject = Boolean(activeObject && activeObject.type !== REMOTE_BROWSER_OBJECT_TYPE);
  const hasControl = snapshot.localHasControl;
  remoteBrowserControlEl.hidden = !debugState.access.canCreateRemoteBrowser && !remoteBrowser;
  remoteBrowserUrlInput.disabled = !canOpen || hasOtherObject;
  openRemoteBrowserButton.disabled = !canOpen || hasOtherObject;
  takeRemoteBrowserControlButton.disabled = !remoteBrowser || !canInput || !roomStateConnected || !hasControl || remoteBrowser.state.controllerParticipantId === participantId;
  releaseRemoteBrowserControlButton.disabled = !remoteBrowser || !canInput || !roomStateConnected || remoteBrowser.state.controllerParticipantId !== participantId;
  stopRemoteBrowserButton.disabled = !remoteBrowser || !hasRoomPermission(debugState.access.permissions, "remote-browser.stop") || !roomStateConnected;
  if (hasOtherObject) {
    remoteBrowserStatusEl.textContent = `Surface occupied by ${activeObject?.type ?? "object"}`;
  } else if (!remoteBrowser) {
    remoteBrowserStatusEl.textContent = canOpen ? "Remote browser idle" : "Host role required";
  } else if (snapshot.errorCode) {
    remoteBrowserStatusEl.textContent = `Remote browser issue: ${snapshot.errorCode}`;
  } else if (snapshot.frameConnected) {
    remoteBrowserStatusEl.textContent = `Remote browser streaming${snapshot.currentUrl ? `: ${snapshot.currentUrl}` : ""}`;
  } else if (remoteBrowser.state.executorSessionId) {
    remoteBrowserStatusEl.textContent = "Remote browser waiting for frames";
  } else {
    remoteBrowserStatusEl.textContent = "Remote browser ready for URL";
  }
}

function syncMediaObjectsDebugState(): void {
  syncMediaSurfaceSelector();
  const surfaces = roomMediaObjects ? Object.values(roomMediaObjects.surfaces) : [];
  const objects = roomMediaObjects ? Object.values(roomMediaObjects.objects) : [];
  debugState.mediaObjects.surfaces = surfaces.map((surface) => ({
    surfaceId: surface.surfaceId,
    label: getMediaSurfaceLabel(surface.surfaceId),
    allowedObjectTypes: [...surface.allowedObjectTypes],
    activeObjectId: surface.activeObjectId,
    activeObjectType: surface.activeObjectId ? roomMediaObjects?.objects[surface.activeObjectId]?.type ?? null : null,
    inputEnabled: surface.inputEnabled,
    mediaAudioEnabled: surface.mediaAudioEnabled,
    lockedByParticipantId: surface.lockedByParticipantId,
    visible: surface.visible,
    runtimeVisible: getMediaSurfaceView(surface.surfaceId).object.visible,
    textureId: getSurfaceTextureDebugId(surface.surfaceId)
  }));
  debugState.mediaObjects.objects = objects.map((object) => ({
    objectId: object.objectId,
    type: object.type,
    surfaceId: object.surfaceId,
    ownerParticipantId: object.ownerParticipantId,
    state: object.state,
    revision: object.revision,
    status: object.status
  }));
  debugState.mediaObjects.selectedSurfaceId = selectedMediaSurfaceId;
  debugState.mediaObjects.extensions = getMediaExtensionDebugSnapshot();
  debugState.mediaObjects.availableObjectTypes = (roomMediaObjects?.surfaces[selectedMediaSurfaceId]?.allowedObjectTypes ?? [])
    .filter((objectType) => isMediaObjectTypeAvailable(objectType));
  const activeObject = activeMediaObjectForSurface(selectedMediaSurfaceId);
  debugState.mediaObjects.activeTestCardClickCount = activeObject?.type === SURFACE_TEST_CARD_TYPE
    ? ((activeObject.state as SurfaceTestCardState).clickCount ?? 0)
    : null;
  const activeWhiteboard = currentWhiteboardObject();
  const activeWhiteboardRuntime = getWhiteboardRuntime(activeWhiteboard?.surfaceId ?? selectedMediaSurfaceId);
  debugState.whiteboard = {
    ...activeWhiteboardRuntime.createDebugSnapshot(activeWhiteboard),
    drawToolActive: whiteboardDrawToolActive,
    xrPointerActive: xrWhiteboardPointerActive,
    xrPencilVisible: whiteboardPencils.some((pencil) => pencil.visible)
  };
  syncWhiteboardSurfaceTextures();
  syncRemoteBrowserSurfaceTextures();
  syncScreenShareRuntimeWithObjects();
  const activeScreenShare = activeScreenShareObjectForSurface(selectedMediaSurfaceId) ?? findActiveScreenShareObject();
  const screenShareState = activeScreenShare?.state ?? null;
  const localPublishing = hasLocalScreenSharePublishing();
  const remoteSubscribedTrackCount = remoteScreenShareTrackCount();
  debugState.screenShare = {
    supported: shareMockEnabled || browserMediaCapabilities.screenShare.supported,
    active: screenShareState?.status === "active",
    localPublishing,
    selectedSurfaceId: screenShareState?.surfaceId ?? null,
    publishedTrackSid: screenShareState?.mediaTrackSid ?? null,
    remoteSubscribedTrackCount: screenShareState?.mediaTrackSid && screenShareState.ownerParticipantId !== participantId
      ? Math.max(remoteSubscribedTrackCount, 1)
      : remoteSubscribedTrackCount,
    mediaAudioEnabled: shouldPublishMediaSurfaceAudio(roomMediaObjects, activeScreenShare?.surfaceId ?? selectedMediaSurfaceId),
    errorCode: screenShareState?.errorCode ?? null
  };
  if (localPublishing) {
    debugState.screenShareState = "sharing";
  } else if (screenShareState?.status === "active") {
    debugState.screenShareState = "receiving";
  } else if (!screenShareState && lastScreenShareStoppedAtMs > 0 && Date.now() - lastScreenShareStoppedAtMs < 10000) {
    debugState.screenShareState = "stopped";
  } else if (!screenShareState && (debugState.screenShareState === "receiving" || debugState.screenShareState === "active" || debugState.screenShareState === "sharing")) {
    debugState.screenShareState = "idle";
  }
  startShareButton.disabled = !canUseScreenShareControl();
  stopShareButton.disabled = !canStopLocalScreenShare();
  syncWhiteboardControls();
  syncRemoteBrowserControls();
  syncSurfaceAudioControl();
  syncMediaSurfaceObjectIds();
}

function routeSurfaceInputToMediaObject(event: SurfaceInputEvent): boolean {
  if (!roomStateClient || !roomStateConnected) {
    return false;
  }
  const object = event.objectId ? roomMediaObjects?.objects[event.objectId] : activeMediaObjectForSurface(event.surfaceId);
  return routeMediaObjectSurfaceInput({
    event,
    object,
    routeWhiteboardInput: (surfaceEvent, whiteboardObject) => getWhiteboardRuntime(whiteboardObject.surfaceId).routeInput(surfaceEvent, whiteboardObject),
    routeRemoteBrowserInput: (surfaceEvent, remoteBrowserObject) => getRemoteBrowserRuntime(remoteBrowserObject.surfaceId).routeInput(surfaceEvent, remoteBrowserObject),
    sendTestCardPatch: (testCardObject, surfaceEvent) => mediaSurfaceCommands.sendPatchObjectState("patch", {
      surfaceId: testCardObject.surfaceId,
      objectId: testCardObject.objectId,
      expectedRevision: testCardObject.revision,
      patch: {
        type: "increment-click-count",
        inputEventId: surfaceEvent.eventId
      }
    })
  });
}

function handleRoomSnapshot(snapshot: RoomStateSnapshot): void {
  roomSeatOccupancy = { ...(snapshot.seatOccupancy ?? {}) };
  roomMediaObjects = snapshot.mediaObjects;
  syncSeatStateFromOccupancy();
  syncMediaObjectsDebugState();
  ensureRemoteBrowserLiveKitRoom();
  syncRemoteBrowserLiveKitTracks();
  syncScreenShareLiveKitTracks();
  latestRealtimeParticipants = snapshot.participants;
  applyMergedPresenceParticipants();
}

function updatePointerNdcFromClientPosition(clientX: number, clientY: number): void {
  const rect = renderer.domElement.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }
  pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -(((clientY - rect.top) / rect.height) * 2 - 1);
}

function forceInteractionRayAtWorldPoint(worldPoint: THREE.Vector3): boolean {
  camera.getWorldPosition(cameraWorldPosition);
  forcedInteractionDirection.copy(worldPoint).sub(cameraWorldPosition);
  if (forcedInteractionDirection.lengthSq() <= 1e-6) {
    return false;
  }
  forcedInteractionDirection.normalize();
  forcedTestInteractionRay = new THREE.Ray(cameraWorldPosition.clone(), forcedInteractionDirection.clone());
  pointerHoveringScene = true;
  return true;
}

function applyRoomTransformToTarget(target: { x: number; y: number; z: number } | null): { x: number; y: number; z: number } | null {
  if (!target) {
    return null;
  }
  const pose = localPoseController.getPose();
  return {
    x: target.x * Math.cos(pose.yaw) + target.z * Math.sin(pose.yaw) + pose.position.x,
    y: target.y + pose.position.y,
    z: -target.x * Math.sin(pose.yaw) + target.z * Math.cos(pose.yaw) + pose.position.z
  };
}

function applyYawAroundXrCamera(nextYaw: number): void {
  localPoseController.setYaw(nextYaw, "snap_turn", {
    preserveCameraXz: renderer.xr.isPresenting && !getCurrentSeatId(),
    camera
  });
}

function setPlayerPositionForFloorTeleport(floorPoint: Vector3Like): void {
  localPoseController.teleportToFloor(floorPoint, sceneTeleportFloorY, "teleport", {
    preserveCameraOffset: renderer.xr.isPresenting,
    camera
  });
}

const executeRuntimeCommandList = createRuntimeCommandExecutor({
  seatingController,
  getRoomStateClient: () => roomStateClient,
  isRoomStateConnected: () => roomStateConnected,
  syncSeatDebugState,
  releaseLocalSeat: releaseCurrentSeatLocally,
  lockToSeat(position, reason, options) {
    localPoseController.lockToSeat(position, reason, options);
  },
  moveFlatTo(position, reason) {
    localPoseController.moveFlatTo(position, reason);
  },
  applySnapTurnYaw: applyYawAroundXrCamera,
  setXrInputProfile(profile) {
    lastAvatarXrInputProfile = profile;
  },
  setDebugXrAxes(axes) {
    debugState.xrAxes = axes;
  },
  setXrRayVisibleLatched(visible) {
    xrRayVisibleLatched = visible;
  },
  setXrTurnCooldown(seconds) {
    xrTurnCooldown = seconds;
  },
  setXrTurnArmed(armed) {
    xrTurnArmed = armed;
  },
  setXrSelectPressedLastFrame(pressed) {
    xrSelectPressedLastFrame = pressed;
  },
  clearXrAvatarDebug() {
    debugState.xrAvatarDebug = null;
  },
  setDebugLocomotionMode(mode) {
    debugState.locomotionMode = mode;
  },
  setLastAppliedSeatLockId(seatId) {
    lastAppliedSeatLockId = seatId;
  },
  setAvatarMovement(move, turnRate) {
    lastAvatarMove = move;
    lastAvatarTurnRate = turnRate;
  },
  updateLocalPositionDebug,
  teleportToFloor(point) {
    setPlayerPositionForFloorTeleport(point);
    updateLocalPositionDebug();
  },
  setStatus,
  markTelemetry: markXrTelemetry
});

const interactionTargetPerformer = createInteractionTargetPerformer({
  planner: interactionCommandPlanner,
  executeCommands: executeRuntimeCommandList,
  getContext: () => ({
    currentSeatId: getCurrentSeatId(),
    pendingSeatId: getPendingSeatId(),
    floorY: sceneTeleportFloorY,
    seatingAvailable: runtimeFlags.avatarSeatingEnabled && Boolean(roomStateClient && roomStateConnected),
    nowMs: performance.now()
  })
});

function getInteractionFrameInput(frameContext: RuntimeFrameContext, options: { forceXrAimRay?: boolean } = {}) {
  return {
    frameContext,
    localAvatarHandFrame: getFrameLocalAvatarHandFrame(frameContext),
    forcedRay: forcedTestInteractionRay,
    forceXrAimRay: options.forceXrAimRay,
    forcedSeatId: forcedTestInteractionSeatId,
    avatarVrMockEnabled,
    syntheticXrState,
    xrPresenting: renderer.xr.isPresenting,
    xrControllerGrips,
    xrControllers,
    playerPosition: localPoseController.getPosition(),
    playerYaw: localPoseController.getYaw(),
    pointerHoveringScene,
    pointerNdc,
    camera,
    raycaster: interactionRaycaster,
    seatMarkerHitMeshes: seatMarkerView.hitMeshes,
    seatAnchorMap: sceneSeatAnchorMap,
    seatAnchors: sceneSeatAnchors,
    teleportFloorY: sceneTeleportFloorY,
    maxDistance: 18,
    view: interactionRayView,
    state: debugState.interactionRay,
    markTelemetry: markXrTelemetry,
    updateSeatMarkerVisuals,
    nowSeconds: () => performance.now() / 1000
  };
}

function createFrameLocalAvatarHandFrame(frameContext: RuntimeFrameContext): LocalAvatarHandFrameResult | null {
  if (avatarVrMockEnabled && syntheticXrState) {
    return createSyntheticLocalAvatarHandFrame({
      rightController: syntheticXrState.rightController,
      rightGrip: syntheticXrState.rightGrip,
      rayDirection: syntheticXrState.rayDirection
    });
  }

  if (frameContext.source !== "xr" || !renderer.xr.isPresenting) {
    return null;
  }

  const pose = localPoseController.getPose();
  return resolveLocalAvatarHandFrame({
    presenting: renderer.xr.isPresenting,
    inputSources: frameContext.xr?.inputSources ?? [],
    grips: xrControllerGrips,
    controllers: xrControllers,
    xrFrame: frameContext.xr?.frame,
    referenceSpace: frameContext.xr?.referenceSpace ?? null,
    playerOffset: {
      x: pose.position.x,
      y: pose.position.y,
      z: pose.position.z
    },
    playerYaw: pose.yaw
  });
}

function getFrameLocalAvatarHandFrame(frameContext: RuntimeFrameContext): LocalAvatarHandFrameResult | null {
  if (localAvatarHandFrameCache.has(frameContext)) {
    return localAvatarHandFrameCache.get(frameContext) ?? null;
  }
  const handFrame = createFrameLocalAvatarHandFrame(frameContext);
  localAvatarHandFrameCache.set(frameContext, handFrame);
  return handFrame;
}

function confirmInteractionTarget(frameContext: RuntimeFrameContext): void {
  const whiteboardXrDrawInput = canUseWhiteboardXrDrawInput(frameContext);
  if (whiteboardXrDrawInput) {
    const hit = resolveDebugSurfaceHitFromXrPencil(frameContext, "xr-controller");
    if (hit) {
      xrWhiteboardPointerActive = commitDebugSurfaceInput({
        hit,
        source: "xr-controller",
        kind: "pointer-down",
        clientTimeMs: frameContext.nowMs,
        button: "primary"
      });
      lastXrWhiteboardHit = xrWhiteboardPointerActive ? hit : null;
      syncWhiteboardPencilVisuals(frameContext, xrWhiteboardPointerActive);
      if (xrWhiteboardPointerActive) {
        return;
      }
    }
  }
  if (resolveRemoteBrowserXrInputTarget(frameContext)) {
    return;
  }
  if (!whiteboardXrDrawInput) {
    commitDebugSurfaceInputFromFrameRay(frameContext, "pointer-down");
  }
  const target = updateInteractionRayState(getInteractionFrameInput(frameContext));
  interactionTargetPerformer.performTarget(target);
  forcedTestInteractionSeatId = null;
}

function updateWhiteboardXrDrawInput(frameContext: RuntimeFrameContext): void {
  const canDraw = canUseWhiteboardXrDrawInput(frameContext);
  if (!canDraw) {
    if (xrWhiteboardPointerActive) {
      cancelWhiteboardPreview();
    }
    xrWhiteboardPointerActive = false;
    lastXrWhiteboardHit = null;
    syncWhiteboardPencilVisuals(frameContext, false);
    return;
  }
  const hit = resolveDebugSurfaceHitFromXrPencil(frameContext, "xr-controller");
  if (!xrWhiteboardPointerActive) {
    syncWhiteboardPencilVisuals(frameContext, true);
    if (frameContext.xr?.triggerPressed && hit) {
      xrWhiteboardPointerActive = commitDebugSurfaceInput({
        hit,
        source: "xr-controller",
        kind: "pointer-down",
        clientTimeMs: frameContext.nowMs,
        button: "primary"
      });
      lastXrWhiteboardHit = xrWhiteboardPointerActive ? hit : null;
    }
    return;
  }
  if (!frameContext.xr?.triggerPressed) {
    const committed = lastXrWhiteboardHit
      ? commitDebugSurfaceInput({
        hit: hit ?? lastXrWhiteboardHit,
        source: "xr-controller",
        kind: "pointer-up",
        clientTimeMs: frameContext.nowMs,
        button: "primary"
      })
      : false;
    if (!committed) {
      cancelWhiteboardPreview();
    }
    xrWhiteboardPointerActive = false;
    lastXrWhiteboardHit = null;
    syncWhiteboardPencilVisuals(frameContext, true);
    return;
  }
  const moved = hit
    ? commitDebugSurfaceInput({
      hit,
      source: "xr-controller",
      kind: "pointer-move",
      clientTimeMs: frameContext.nowMs,
      button: "primary"
    })
    : false;
  if (!moved) {
    if (lastXrWhiteboardHit) {
      commitDebugSurfaceInput({
        hit: lastXrWhiteboardHit,
        source: "xr-controller",
        kind: "pointer-up",
        clientTimeMs: frameContext.nowMs,
        button: "primary"
      });
    } else {
      cancelWhiteboardPreview();
    }
    xrWhiteboardPointerActive = false;
    lastXrWhiteboardHit = null;
    syncWhiteboardPencilVisuals(frameContext, true);
    return;
  }
  lastXrWhiteboardHit = hit;
  syncWhiteboardPencilVisuals(frameContext, xrWhiteboardPointerActive);
}

function executeFrameRuntimeCommandList(frameContext: RuntimeFrameContext, commands: FrameLocomotionCommand[]): void {
  executeFrameLocomotionCommands(commands, {
    executeRuntimeCommands: executeRuntimeCommandList,
    confirmInteractionTarget() {
      confirmInteractionTarget(frameContext);
    }
  });
}

function resolveNonFrameInteractionContext(): RuntimeFrameContext | null {
  if (renderer.xr.isPresenting || (avatarVrMockEnabled && syntheticXrState)) {
    return lastRuntimeFrameContext?.source === "xr" ? lastRuntimeFrameContext : null;
  }
  return sampleRuntimeFrameContext(0, Date.now());
}

function confirmLatestInteractionTarget(): void {
  const frameContext = resolveNonFrameInteractionContext();
  if (!frameContext) {
    return;
  }
  confirmInteractionTarget(frameContext);
}

function supportsAudioOutputSelection(): boolean {
  const context = audioContext as AudioContext & { setSinkId?: (deviceId: string) => Promise<void> } | null;
  return Boolean(context?.setSinkId) || "setSinkId" in HTMLMediaElement.prototype;
}

function canUseScreenShareControl(): boolean {
  const activeObject = activeMediaObjectForSurface(selectedMediaSurfaceId);
  return debugState.access.canStartScreenShare
    && roomStateConnected
    && !activeObject
    && surfaceAllowsObject(selectedMediaSurfaceId, SCREEN_SHARE_OBJECT_TYPE)
    && (shareMockEnabled || (runtimeFlags.screenShare && browserMediaCapabilities.screenShare.supported));
}

function canUseWhiteboardControl(): boolean {
  const activeObject = activeMediaObjectForSurface(selectedMediaSurfaceId);
  return debugState.access.canCreateWhiteboard
    && roomStateConnected
    && !activeObject
    && surfaceAllowsObject(selectedMediaSurfaceId, WHITEBOARD_OBJECT_TYPE);
}

function canClearWhiteboardControl(): boolean {
  return hasRoomPermission(debugState.access.permissions, "whiteboard.clear")
    && roomStateConnected
    && Boolean(activeWhiteboardObjectForSurface(selectedMediaSurfaceId));
}

function canStopWhiteboardControl(): boolean {
  return hasRoomPermission(debugState.access.permissions, "surface.stop-object")
    && roomStateConnected
    && Boolean(activeWhiteboardObjectForSurface(selectedMediaSurfaceId));
}

function canUseWhiteboardDrawTool(): boolean {
  return hasRoomPermission(debugState.access.permissions, "whiteboard.draw")
    && roomStateConnected
    && Boolean(currentWhiteboardObject());
}

function syncWhiteboardControls(): void {
  const canDraw = canUseWhiteboardDrawTool();
  if (!canDraw) {
    whiteboardDrawToolActive = false;
    whiteboardPointerActive = false;
    xrWhiteboardPointerActive = false;
    syncWhiteboardPencilVisuals(lastRuntimeFrameContext, false);
  }
  startWhiteboardButton.hidden = !debugState.access.canCreateWhiteboard;
  drawWhiteboardButton.hidden = !hasRoomPermission(debugState.access.permissions, "whiteboard.draw");
  clearWhiteboardButton.hidden = !hasRoomPermission(debugState.access.permissions, "whiteboard.clear");
  stopWhiteboardButton.hidden = !hasRoomPermission(debugState.access.permissions, "surface.stop-object");
  startWhiteboardButton.disabled = !canUseWhiteboardControl();
  drawWhiteboardButton.disabled = !canDraw;
  drawWhiteboardButton.textContent = whiteboardDrawToolActive ? "Draw: On" : "Draw: Off";
  drawWhiteboardButton.setAttribute("aria-pressed", whiteboardDrawToolActive ? "true" : "false");
  drawWhiteboardButton.classList.toggle("tool-active", whiteboardDrawToolActive);
  renderer.domElement.style.cursor = whiteboardDrawToolActive ? "crosshair" : "";
  clearWhiteboardButton.disabled = !canClearWhiteboardControl();
  stopWhiteboardButton.disabled = !canStopWhiteboardControl();
}

function canStopLocalScreenShare(): boolean {
  const activeObject = activeScreenShareObjectForSurface(selectedMediaSurfaceId) ?? findLocalActiveScreenShareObject();
  return debugState.access.canStartScreenShare
    && roomStateConnected
    && Boolean(activeObject && activeObject.ownerParticipantId === participantId);
}

function surfaceInputSourceFromPointer(event: PointerEvent): SurfaceInputSource {
  return event.pointerType === "touch" ? "touch" : "mouse";
}

function surfaceInputButtonFromPointer(button: number): SurfaceInputButton | undefined {
  if (button === 0) {
    return "primary";
  }
  if (button === 1) {
    return "middle";
  }
  if (button === 2) {
    return "secondary";
  }
  return undefined;
}

function resolveDebugSurfaceHit(ray: THREE.Ray, source: SurfaceInputSource): ResolvedSurfaceHit | null {
  return resolveSurfaceHitFromRay({
    ray,
    raycaster: surfaceInputRaycaster,
    source,
    surfaces: Array.from(mediaSurfaceViews.values()).map((surface) => ({
      surfaceId: surface.surfaceId,
      objectId: activeMediaObjectIdForSurface(surface.surfaceId),
      object: surface.object,
      widthPx: surface.widthPx,
      heightPx: surface.heightPx,
      inputEnabled: debugState.surfaceInput.enabled && surface.object.visible && roomMediaObjects?.surfaces[surface.surfaceId]?.visible !== false
    }))
  });
}

function resolveDebugSurfaceHitFromPointer(clientX: number, clientY: number, source: SurfaceInputSource): ResolvedSurfaceHit | null {
  updatePointerNdcFromClientPosition(clientX, clientY);
  surfaceInputRaycaster.setFromCamera(pointerNdc, camera);
  return resolveDebugSurfaceHit(surfaceInputRaycaster.ray.clone(), source);
}

function resolveDebugSurfaceRayHit(frameContext: RuntimeFrameContext, source: SurfaceInputSource, options: { forceXrAimRay?: boolean } = {}): { ray: THREE.Ray; hit: ResolvedSurfaceHit } | null {
  const resolvedRay = resolveRuntimeInteractionRay(getInteractionFrameInput(frameContext, options));
  if (!resolvedRay) {
    return null;
  }
  const hit = resolveDebugSurfaceHit(resolvedRay.ray, source);
  return hit ? { ray: resolvedRay.ray, hit } : null;
}

function resolveDebugSurfaceHitFromFrameRay(frameContext: RuntimeFrameContext, source: SurfaceInputSource, options: { forceXrAimRay?: boolean } = {}): ResolvedSurfaceHit | null {
  return resolveDebugSurfaceRayHit(frameContext, source, options)?.hit ?? null;
}

function resolveWhiteboardPencilPose(frameContext: RuntimeFrameContext): XrPencilPose | null {
  const handFrame = getFrameLocalAvatarHandFrame(frameContext);
  return resolveXrPencilPose({
    handPose: handFrame?.worldHandPoses.rightHand ?? null,
    tipLocalZ: WHITEBOARD_PENCIL_TIP_LOCAL_Z,
    orientationOffset: WHITEBOARD_PENCIL_GRIP_ROTATION
  });
}

function resolveDebugSurfaceHitFromXrPencil(frameContext: RuntimeFrameContext, source: SurfaceInputSource): ResolvedSurfaceHit | null {
  const pencilPose = resolveWhiteboardPencilPose(frameContext);
  if (!pencilPose) {
    return null;
  }
  for (const surface of mediaSurfaceViews.values()) {
    surface.object.updateMatrixWorld(true);
  }
  return resolveSurfaceHitFromPlanePoint({
    point: pencilPose.tipWorld,
    source,
    surfaces: Array.from(mediaSurfaceViews.values()).map((surface) => ({
      surfaceId: surface.surfaceId,
      objectId: activeMediaObjectIdForSurface(surface.surfaceId),
      object: surface.object,
      widthPx: surface.widthPx,
      heightPx: surface.heightPx,
      widthM: surface.widthM,
      heightM: surface.heightM,
      maxDistanceM: WHITEBOARD_PENCIL_CONTACT_DISTANCE_M,
      inputEnabled: debugState.surfaceInput.enabled && surface.object.visible && roomMediaObjects?.surfaces[surface.surfaceId]?.visible !== false
    }))
  });
}

function renderActiveWhiteboardAfterPreviewChange(): void {
  const object = currentWhiteboardObject();
  if (object) {
    getWhiteboardRuntime(object.surfaceId).render(object.state);
  }
}

function cancelWhiteboardPreview(): void {
  for (const runtime of whiteboardRuntimes.values()) {
    runtime.clearPreview();
  }
  renderActiveWhiteboardAfterPreviewChange();
}

function attachWhiteboardPreviewToSurface(surfaceId: string): RuntimeMediaSurfaceView {
  const surface = getMediaSurfaceView(surfaceId);
  if (whiteboardPreviewLine.parent !== surface.object) {
    surface.object.add(whiteboardPreviewLine);
    whiteboardPreviewLine.position.set(0, 0, 0.018);
  }
  return surface;
}

function applyWhiteboardPreviewOverlay(surfaceId: string, stroke: WhiteboardStroke | null): void {
  const points = stroke?.points ?? [];
  if (points.length < 2) {
    whiteboardPreviewGeometry.setDrawRange(0, 0);
    whiteboardPreviewLine.visible = false;
    return;
  }

  const surface = attachWhiteboardPreviewToSurface(surfaceId);
  const count = Math.min(points.length, WHITEBOARD_MAX_POINTS_PER_STROKE);
  for (let index = 0; index < count; index += 1) {
    const point = points[index]!;
    const offset = index * 3;
    whiteboardPreviewPositions[offset] = (point.u - 0.5) * surface.widthM;
    whiteboardPreviewPositions[offset + 1] = (0.5 - point.v) * surface.heightM;
    whiteboardPreviewPositions[offset + 2] = 0;
  }
  whiteboardPreviewPositionAttribute.needsUpdate = true;
  whiteboardPreviewGeometry.setDrawRange(0, count);
  whiteboardPreviewLine.visible = true;
}

function syncWhiteboardPencilVisuals(frameContext: RuntimeFrameContext | null, visible: boolean): void {
  const pencilPose = visible && frameContext ? resolveWhiteboardPencilPose(frameContext) : null;
  for (const [index, pencil] of whiteboardPencils.entries()) {
    const pencilVisible = Boolean(pencilPose && index === pencilPose.sourceIndex);
    pencil.visible = pencilVisible;
    if (pencilVisible && pencilPose) {
      pencil.position.copy(pencilPose.anchorWorld);
      pencil.quaternion.copy(pencilPose.orientationWorld);
    }
  }
  debugState.whiteboard.xrPencilVisible = whiteboardPencils.some((pencil) => pencil.visible);
}

function canUseWhiteboardXrDrawInput(frameContext: RuntimeFrameContext): boolean {
  return frameContext.source === "xr"
    && whiteboardDrawToolActive
    && hasRoomPermission(debugState.access.permissions, "whiteboard.draw")
    && roomStateConnected
    && Boolean(currentWhiteboardObject());
}

function commitDebugSurfaceInput(input: {
  hit: ResolvedSurfaceHit | null;
  source: SurfaceInputSource;
  kind: SurfaceInputKind;
  clientTimeMs: number;
  button?: SurfaceInputButton;
  pressure?: number;
  key?: string;
  text?: string;
  scrollDelta?: SurfaceInputScrollDelta;
  routeMediaObjectInput?: boolean;
}): boolean {
  recordSurfaceInputHit(debugState.surfaceInput, input.hit);
  surfaceInputSeq += 1;
  const resolution = resolveSurfaceInputEvent({
    roomId,
    participantId,
    permissions: debugState.access.permissions,
    hit: input.hit,
    kind: input.kind,
    source: input.source,
    clientTimeMs: input.clientTimeMs,
    seq: surfaceInputSeq,
    focusedSurfaceId: debugState.surfaceInput.focusedSurfaceId,
    button: input.button,
    pressure: input.pressure,
    key: input.key,
    text: input.text,
    scrollDelta: input.scrollDelta
  });
  const resolvedEvent = resolution.accepted && !resolution.event.objectId
    ? { ...resolution.event, objectId: activeMediaObjectIdForSurface(resolution.event.surfaceId) }
    : resolution.accepted
      ? resolution.event
      : null;
  applySurfaceInputResolution(debugState.surfaceInput, resolvedEvent ? { accepted: true, event: resolvedEvent } : resolution);
  if (resolvedEvent && input.routeMediaObjectInput !== false) {
    routeSurfaceInputToMediaObject(resolvedEvent);
  }
  const activeObject = resolvedEvent ? activeMediaObjectForSurface(resolvedEvent.surfaceId) : null;
  const shouldFocusSurface = input.kind === "click" || (input.kind === "pointer-down" && activeObject?.type === REMOTE_BROWSER_OBJECT_TYPE);
  if (resolvedEvent && shouldFocusSurface && hasRoomPermission(debugState.access.permissions, "surface.select")) {
    tryFocusSurface({ state: debugState.surfaceInput, permissions: debugState.access.permissions, hit: input.hit });
  }
  return Boolean(resolvedEvent);
}

function commitDebugSurfaceInputFromPointer(event: PointerEvent, kind: SurfaceInputKind): boolean {
  const source = surfaceInputSourceFromPointer(event);
  const hit = resolveDebugSurfaceHitFromPointer(event.clientX, event.clientY, source);
  return commitDebugSurfaceInput({
    hit,
    source,
    kind,
    clientTimeMs: Date.now(),
    button: surfaceInputButtonFromPointer(event.button),
    pressure: event.pressure
  });
}

function commitRemoteBrowserHoverMoveFromPointer(event: PointerEvent): boolean {
  if (event.pointerType === "touch" || renderer.xr.isPresenting) {
    return false;
  }
  const nowMs = Date.now();
  if (nowMs - lastRemoteBrowserHoverMoveAtMs < REMOTE_BROWSER_HOVER_MOVE_INTERVAL_MS) {
    return false;
  }
  const hit = resolveDebugSurfaceHitFromPointer(event.clientX, event.clientY, "mouse");
  if (!hit || !activeRemoteBrowserObjectForSurface(hit.surfaceId)) {
    return false;
  }
  const committed = commitDebugSurfaceInput({
    hit,
    source: "mouse",
    kind: "pointer-move",
    clientTimeMs: nowMs,
    button: surfaceInputButtonFromPointer(event.button),
    pressure: event.pressure
  });
  if (committed) {
    lastRemoteBrowserHoverMoveAtMs = nowMs;
  }
  return committed;
}

function commitDebugSurfaceInputFromFocusedKeyboard(kind: Extract<SurfaceInputKind, "key-down" | "key-up">, event: KeyboardEvent): boolean {
  const focusedSurfaceId = debugState.surfaceInput.focusedSurfaceId;
  if (!focusedSurfaceId) {
    return false;
  }
  const surface = getMediaSurfaceView(focusedSurfaceId);
  const uv = debugState.surfaceInput.lastHit?.uv ?? { u: 0.5, v: 0.5 };
  const hit = createSyntheticSurfaceHit({
    surfaceId: focusedSurfaceId,
    objectId: activeMediaObjectIdForSurface(focusedSurfaceId),
    source: "keyboard",
    uv,
    widthPx: surface.widthPx,
    heightPx: surface.heightPx,
    inputEnabled: debugState.surfaceInput.enabled && surface.object.visible
  });
  return commitDebugSurfaceInput({
    hit,
    source: "keyboard",
    kind,
    clientTimeMs: Date.now(),
    key: event.key,
    text: event.key.length === 1 ? event.key : undefined
  });
}

function clampScrollDeltaPx(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Number(Math.max(-1600, Math.min(1600, value)).toFixed(2));
}

function scrollDeltaFromWheelEvent(event: WheelEvent): SurfaceInputScrollDelta {
  const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 40
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? DEBUG_SURFACE_HEIGHT_PX
      : 1;
  return {
    x: clampScrollDeltaPx(event.deltaX * scale),
    y: clampScrollDeltaPx(event.deltaY * scale)
  };
}

function commitDebugSurfaceInputFromFrameRay(frameContext: RuntimeFrameContext, kind: SurfaceInputKind): boolean {
  const source: SurfaceInputSource = frameContext.source === "xr" ? "xr-controller" : "mouse";
  const hit = resolveDebugSurfaceHitFromFrameRay(frameContext, source);
  if (!hit) {
    return false;
  }
  const activeObject = activeMediaObjectForSurface(hit.surfaceId);
  const whiteboardXrToolCanDraw = frameContext.source === "xr" && whiteboardDrawToolActive && canUseWhiteboardDrawTool();
  return commitDebugSurfaceInput({
    hit,
    source,
    kind,
    clientTimeMs: frameContext.nowMs,
    button: "primary",
    routeMediaObjectInput: activeObject?.type !== WHITEBOARD_OBJECT_TYPE || whiteboardXrToolCanDraw
  });
}

function isRemoteBrowserXrInputActive(frameContext: RuntimeFrameContext): boolean {
  return frameContext.source === "xr"
    && Boolean(findActiveRemoteBrowserObject())
    && debugState.surfaceInput.enabled
    && Array.from(mediaSurfaceViews.values()).some((surface) => surface.object.visible);
}

function remoteBrowserVrKeyboardTargetDebugId(target: RemoteBrowserVrKeyboardTarget | null): string | null {
  return target?.kind === "toggle" ? "toggle" : target?.keyId ?? null;
}

function syncRemoteBrowserVrKeyboardState(active: boolean): void {
  if (!active) {
    remoteBrowserVrKeyboardOpen = false;
    remoteBrowserVrKeyboardPress = null;
  }
  setRemoteBrowserVrKeyboardActive(remoteBrowserVrKeyboardView, active);
  setRemoteBrowserVrKeyboardOpen(remoteBrowserVrKeyboardView, active && remoteBrowserVrKeyboardOpen);
  debugState.remoteBrowser.xrKeyboardToggleVisible = active;
  debugState.remoteBrowser.xrKeyboardVisible = active && remoteBrowserVrKeyboardOpen;
  debugState.remoteBrowser.xrKeyboardOpen = active && remoteBrowserVrKeyboardOpen;
  debugState.remoteBrowser.xrKeyboardLayout = remoteBrowserVrKeyboardView.currentLayoutId;
  if (!active) {
    debugState.remoteBrowser.xrKeyboardHoveredKey = null;
    debugState.remoteBrowser.xrKeyboardHoveredTarget = null;
    debugState.remoteBrowser.xrKeyboardPressedTarget = null;
  }
}

function resolveRemoteBrowserXrRay(frameContext: RuntimeFrameContext): { ray: THREE.Ray } | null {
  if (!isRemoteBrowserXrInputActive(frameContext)) {
    return null;
  }
  return resolveRuntimeInteractionRay(getInteractionFrameInput(frameContext, { forceXrAimRay: true }));
}

function resolveRemoteBrowserXrInputTarget(frameContext: RuntimeFrameContext): {
  ray: THREE.Ray;
  keyboardHit: RemoteBrowserVrKeyboardHit | null;
  surfaceHit: ResolvedSurfaceHit | null;
} | null {
  const browserActive = isRemoteBrowserXrInputActive(frameContext);
  syncRemoteBrowserVrKeyboardState(browserActive);
  if (!browserActive) {
    return null;
  }
  const resolvedRay = resolveRemoteBrowserXrRay(frameContext);
  if (!resolvedRay) {
    return null;
  }
  const keyboardHit = resolveRemoteBrowserVrKeyboardHit({
    view: remoteBrowserVrKeyboardView,
    ray: resolvedRay.ray,
    raycaster: remoteBrowserVrKeyboardRaycaster
  });
  const surfaceHit = keyboardHit ? null : resolveDebugSurfaceHit(resolvedRay.ray, "xr-controller");
  return keyboardHit || surfaceHit
    ? { ray: resolvedRay.ray, keyboardHit, surfaceHit }
    : null;
}

function showRemoteBrowserXrRayPoint(input: { ray: THREE.Ray; point: THREE.Vector3; targetKind: "surface" | "keyboard"; color: number; visualEndOffsetM?: number; showReticle?: boolean }): void {
  showInteractionRayPointView({
    view: interactionRayView,
    state: debugState.interactionRay,
    ray: input.ray,
    point: input.point,
    targetKind: input.targetKind,
    mode: "xr-right-stick",
    color: input.color,
    visualEndOffsetM: input.visualEndOffsetM,
    showReticle: input.showReticle,
    markTelemetry: markXrTelemetry
  });
}

function showRemoteBrowserXrSurfaceRay(ray: THREE.Ray, hit: ResolvedSurfaceHit): void {
  showRemoteBrowserXrRayPoint({
    ray,
    point: typeof hit.distanceM === "number" ? ray.at(hit.distanceM, new THREE.Vector3()) : ray.at(3, new THREE.Vector3()),
    targetKind: "surface",
    color: 0xffc857
  });
}

function showRemoteBrowserVrKeyboardRay(ray: THREE.Ray, hit: RemoteBrowserVrKeyboardHit): void {
  showRemoteBrowserXrRayPoint({
    ray,
    point: hit.point,
    targetKind: "keyboard",
    color: 0xff8c42,
    visualEndOffsetM: XR_REMOTE_BROWSER_KEYBOARD_RAY_END_OFFSET_M,
    showReticle: false
  });
}

function commitRemoteBrowserXrScrollInput(frameContext: RuntimeFrameContext, hit: ResolvedSurfaceHit | null, triggerPressed: boolean): boolean {
  if (!hit || triggerPressed) {
    return false;
  }
  const axis = frameContext.xr?.sanitizedAxes.turnY ?? 0;
  if (Math.abs(axis) < XR_REMOTE_BROWSER_SCROLL_AXIS_THRESHOLD) {
    return false;
  }
  if (frameContext.nowMs - lastXrRemoteBrowserScrollAtMs < XR_REMOTE_BROWSER_SCROLL_INTERVAL_MS) {
    return false;
  }
  lastXrRemoteBrowserScrollAtMs = frameContext.nowMs;
  return commitDebugSurfaceInput({
    hit,
    source: "xr-controller",
    kind: "scroll",
    clientTimeMs: frameContext.nowMs,
    scrollDelta: {
      x: 0,
      y: clampScrollDeltaPx(axis * XR_REMOTE_BROWSER_SCROLL_DELTA_PX)
    }
  });
}

function commitRemoteBrowserVrKeyboardInput(input: { keyId: string | null; key?: string; text?: string }, nowMs: number): boolean {
  if (!input.keyId || (!input.key && !input.text)) {
    return false;
  }
  const remoteBrowser = activeRemoteBrowserObjectForSurface(selectedMediaSurfaceId) ?? findActiveRemoteBrowserObject();
  const surfaceId = remoteBrowser?.surfaceId ?? selectedMediaSurfaceId;
  const surface = getMediaSurfaceView(surfaceId);
  const uv = debugState.surfaceInput.lastHit?.surfaceId === surfaceId
    ? debugState.surfaceInput.lastHit.uv
    : { u: 0.5, v: 0.5 };
  const hit = createSyntheticSurfaceHit({
    surfaceId,
    objectId: activeMediaObjectIdForSurface(surfaceId),
    source: "keyboard",
    uv,
    widthPx: surface.widthPx,
    heightPx: surface.heightPx,
    inputEnabled: debugState.surfaceInput.enabled && surface.object.visible
  });
  if (debugState.surfaceInput.focusedSurfaceId !== surfaceId) {
    tryFocusSurface({ state: debugState.surfaceInput, permissions: debugState.access.permissions, hit });
  }
  const committed = commitDebugSurfaceInput({
    hit,
    source: "keyboard",
    kind: "key-down",
    clientTimeMs: nowMs,
    key: input.key,
    text: input.text
  });
  if (committed) {
    debugState.remoteBrowser.xrKeyboardLastKey = input.keyId;
  }
  return committed;
}

function handleRemoteBrowserVrKeyboardHit(hit: RemoteBrowserVrKeyboardHit, nowMs: number): boolean {
  const plan = planRemoteBrowserVrKeyboardInput({
    keyboardActive: true,
    confirmInteraction: true,
    hit
  });
  if (plan.toggleKeyboard) {
    remoteBrowserVrKeyboardOpen = !remoteBrowserVrKeyboardOpen;
    syncRemoteBrowserVrKeyboardState(true);
    debugState.remoteBrowser.xrKeyboardLastKey = "toggle";
    return true;
  }
  if (plan.layoutNext) {
    const layoutId = cycleRemoteBrowserVrKeyboardLayout(remoteBrowserVrKeyboardView);
    debugState.remoteBrowser.xrKeyboardLayout = layoutId;
    debugState.remoteBrowser.xrKeyboardLastKey = plan.keyId;
    return true;
  }
  return commitRemoteBrowserVrKeyboardInput(plan, nowMs);
}

function updateRemoteBrowserXrInput(frameContext: RuntimeFrameContext): boolean {
  const pointerWasActive = xrRemoteBrowserPointerActive;
  const browserActive = isRemoteBrowserXrInputActive(frameContext);
  const triggerPressed = Boolean(frameContext.xr?.triggerPressed);
  if (!triggerPressed && remoteBrowserVrKeyboardPress) {
    remoteBrowserVrKeyboardPress = null;
  }
  const target = browserActive ? resolveRemoteBrowserXrInputTarget(frameContext) : null;
  if (!browserActive) {
    syncRemoteBrowserVrKeyboardState(false);
  }
  const keyboardHit = target?.keyboardHit ?? null;
  const visibleKeyboardHit = remoteBrowserVrKeyboardPress ?? keyboardHit;
  const pressedTarget = targetFromRemoteBrowserVrKeyboardHit(remoteBrowserVrKeyboardPress);
  const hoveredTarget = targetFromRemoteBrowserVrKeyboardHit(keyboardHit);
  const surfaceHit = visibleKeyboardHit ? null : target?.surfaceHit ?? null;
  const fallbackRay = !target && remoteBrowserVrKeyboardPress && browserActive ? resolveRemoteBrowserXrRay(frameContext) : null;
  const ray = target?.ray ?? fallbackRay?.ray ?? null;
  setRemoteBrowserVrKeyboardTargets(remoteBrowserVrKeyboardView, hoveredTarget, pressedTarget);
  debugState.remoteBrowser.xrKeyboardHoveredKey = keyboardHit?.kind === "key" ? keyboardHit.key.id : null;
  debugState.remoteBrowser.xrKeyboardHoveredTarget = remoteBrowserVrKeyboardTargetDebugId(hoveredTarget);
  debugState.remoteBrowser.xrKeyboardPressedTarget = remoteBrowserVrKeyboardTargetDebugId(pressedTarget);
  if (ray && visibleKeyboardHit) {
    showRemoteBrowserVrKeyboardRay(ray, visibleKeyboardHit);
  } else if (target && surfaceHit) {
    showRemoteBrowserXrSurfaceRay(target.ray, surfaceHit);
  }
  const scrollCommitted = commitRemoteBrowserXrScrollInput(frameContext, surfaceHit, triggerPressed);
  const plan = planRemoteBrowserXrPointer({
    browserActive,
    pointerActive: xrRemoteBrowserPointerActive,
    triggerPressed,
    confirmInteraction: visibleKeyboardHit ? false : frameContext.intents.confirmInteraction,
    hasHit: Boolean(surfaceHit),
    hasLastHit: Boolean(lastXrRemoteBrowserHit)
  });
  const hit = plan.useLastHit ? lastXrRemoteBrowserHit : surfaceHit;
  const committed = plan.kind
    ? commitDebugSurfaceInput({
      hit,
      source: "xr-controller",
      kind: plan.kind,
      clientTimeMs: frameContext.nowMs,
      button: "primary"
    })
    : false;
  xrRemoteBrowserPointerActive = plan.nextPointerActive && (!plan.kind || committed);
  if (xrRemoteBrowserPointerActive && surfaceHit) {
    lastXrRemoteBrowserHit = surfaceHit;
  } else if (!xrRemoteBrowserPointerActive) {
    lastXrRemoteBrowserHit = null;
  }
  if (!xrRemoteBrowserPointerActive && keyboardHit && frameContext.intents.confirmInteraction && !remoteBrowserVrKeyboardPress) {
    remoteBrowserVrKeyboardPress = keyboardHit;
    handleRemoteBrowserVrKeyboardHit(keyboardHit, frameContext.nowMs);
  }
  return Boolean(visibleKeyboardHit || surfaceHit) || pointerWasActive || xrRemoteBrowserPointerActive || scrollCommitted;
}

function formatDeviceLabel(device: MediaDeviceInfo, fallbackLabel: string, index: number): string {
  return device.label || `${fallbackLabel} ${index + 1}`;
}

function renderAudioDeviceOptions(select: HTMLSelectElement, devices: MediaDeviceInfo[], selectedId: string, fallbackLabel: string): void {
  select.replaceChildren();
  const defaultOption = document.createElement("option");
  defaultOption.value = "default";
  defaultOption.textContent = `System default ${fallbackLabel.toLowerCase()}`;
  defaultOption.selected = selectedId === "default" || !devices.some((device) => device.deviceId === selectedId);
  select.appendChild(defaultOption);
  devices.forEach((device, index) => {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = formatDeviceLabel(device, fallbackLabel, index);
    option.selected = device.deviceId === selectedId;
    select.appendChild(option);
  });
}

function updateAudioMeter(fill: HTMLDivElement, level: number): void {
  fill.style.width = `${Math.round(Math.max(0, Math.min(1, level)) * 100)}%`;
}

function updateAudioDeviceStatus(message: string): void {
  audioDeviceStatusEl.textContent = message;
}

function applySurfaceTexture(surfaceId: string, texture: THREE.Texture | null): void {
  const material = getMediaSurfaceView(surfaceId).object.material;
  if (!(material instanceof THREE.MeshBasicMaterial)) {
    return;
  }
  if (material.map === texture) {
    if (texture && material.color.getHex() !== 0xffffff) {
      material.color.setHex(0xffffff);
    }
    return;
  }
  if (material.map && material.map !== texture && !retainedDisplayTextures.has(material.map)) {
    material.map.dispose();
  }
  material.color.setHex(0xffffff);
  material.map = texture;
  material.needsUpdate = true;
}

function getSurfaceTextureDebugId(surfaceId: string): number | null {
  const material = getMediaSurfaceView(surfaceId).object.material;
  const texture = material instanceof THREE.MeshBasicMaterial ? material.map : null;
  if (!texture) {
    return null;
  }
  const existing = debugTextureIds.get(texture);
  if (existing) {
    return existing;
  }
  const next = nextDebugTextureId;
  nextDebugTextureId += 1;
  debugTextureIds.set(texture, next);
  return next;
}

function applyDisplayTexture(texture: THREE.Texture | null): void {
  applySurfaceTexture(DEBUG_SURFACE_ID, texture);
}

function findSurfaceWithTexture(predicate: (texture: THREE.Texture | null) => boolean): RuntimeMediaSurfaceView | null {
  for (const surface of mediaSurfaceViews.values()) {
    const material = surface.object.material;
    if (material instanceof THREE.MeshBasicMaterial && predicate(material.map)) {
      return surface;
    }
  }
  return null;
}

function clearSurfaceTextureWhere(predicate: (texture: THREE.Texture | null) => boolean): void {
  for (const surface of mediaSurfaceViews.values()) {
    const material = surface.object.material;
    if (material instanceof THREE.MeshBasicMaterial && predicate(material.map)) {
      applySurfaceTexture(surface.surfaceId, null);
    }
  }
}

type SurfaceTextureSample = { clip: { sx: number; sy: number; sw: number; sh: number }; samples: Array<[number, number, number]> };

function sampleTextureImage(image: unknown, center: { u: number; v: number }, size: { width: number; height: number }): SurfaceTextureSample | null {
  if (!(image instanceof HTMLCanvasElement) && !(image instanceof HTMLVideoElement) && !(image instanceof HTMLImageElement) && !(typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap)) {
    return null;
  }
  const imageWidth = image instanceof HTMLVideoElement
    ? image.videoWidth
    : image instanceof HTMLImageElement
      ? image.naturalWidth || image.width
      : image.width;
  const imageHeight = image instanceof HTMLVideoElement
    ? image.videoHeight
    : image instanceof HTMLImageElement
      ? image.naturalHeight || image.height
      : image.height;
  if (imageWidth <= 0 || imageHeight <= 0) {
    return null;
  }

  const scratch = document.createElement("canvas");
  scratch.width = imageWidth;
  scratch.height = imageHeight;
  const context = scratch.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return null;
  }
  try {
    context.drawImage(image, 0, 0, imageWidth, imageHeight);
  } catch {
    return null;
  }

  const clampedU = Math.max(0, Math.min(1, center.u));
  const clampedV = Math.max(0, Math.min(1, center.v));
  const sw = Math.max(1, Math.floor(imageWidth * Math.max(0.001, Math.min(1, size.width))));
  const sh = Math.max(1, Math.floor(imageHeight * Math.max(0.001, Math.min(1, size.height))));
  const sx = Math.max(0, Math.min(imageWidth - sw, Math.floor(clampedU * imageWidth - sw / 2)));
  const sy = Math.max(0, Math.min(imageHeight - sh, Math.floor((1 - clampedV) * imageHeight - sh / 2)));
  const data = context.getImageData(sx, sy, sw, sh).data;
  const samples: Array<[number, number, number]> = [];
  for (let sampleIndex = 0; sampleIndex < 128; sampleIndex += 1) {
    const x = Math.min(sw - 1, Math.floor(((sampleIndex % 16) + 0.5) * sw / 16));
    const y = Math.min(sh - 1, Math.floor((Math.floor(sampleIndex / 16) + 0.5) * sh / 8));
    const pixelIndex = (y * sw + x) * 4;
    samples.push([data[pixelIndex] ?? 0, data[pixelIndex + 1] ?? 0, data[pixelIndex + 2] ?? 0]);
  }
  return { clip: { sx, sy, sw, sh }, samples };
}

function sampleMediaSurfaceTexture(surfaceId: string, center: { u: number; v: number }, size: { width: number; height: number }): SurfaceTextureSample | null {
  const material = getMediaSurfaceView(surfaceId).object.material;
  const image = material instanceof THREE.MeshBasicMaterial ? material.map?.image : null;
  return sampleTextureImage(image, center, size);
}

function ensureAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

async function refreshAudioDevices(requestPermissions = false): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    audioInputDevices = [];
    audioOutputDevices = [];
    renderAudioDeviceOptions(micSelect, audioInputDevices, preferredMicDeviceId, "Microphone");
    renderAudioDeviceOptions(speakerSelect, audioOutputDevices, preferredSpeakerDeviceId, "Speaker");
    speakerSelect.disabled = true;
    updateAudioDeviceStatus(formatUnsupportedMediaCapabilities(browserMediaCapabilities) || "Audio devices unavailable");
    return;
  }

  try {
    const [inputs, outputs] = await Promise.all([
      Room.getLocalDevices("audioinput", requestPermissions),
      Room.getLocalDevices("audiooutput", false)
    ]);
    audioInputDevices = inputs;
    audioOutputDevices = outputs;
  } catch {
    const devices = await navigator.mediaDevices.enumerateDevices();
    audioInputDevices = devices.filter((device) => device.kind === "audioinput");
    audioOutputDevices = devices.filter((device) => device.kind === "audiooutput");
  }

  renderAudioDeviceOptions(micSelect, audioInputDevices, preferredMicDeviceId, "Microphone");
  renderAudioDeviceOptions(speakerSelect, audioOutputDevices, preferredSpeakerDeviceId, "Speaker");
  speakerSelect.disabled = !supportsAudioOutputSelection();
  const unsupportedStatus = formatUnsupportedMediaCapabilities(browserMediaCapabilities);
  const deviceStatus =
    `Inputs: ${audioInputDevices.length || 1}, outputs: ${audioOutputDevices.length || 1}${supportsAudioOutputSelection() ? "" : " (speaker switching unsupported here)"}`;
  updateAudioDeviceStatus(
    unsupportedStatus ? `${deviceStatus}; ${unsupportedStatus}` : deviceStatus
  );
}

function syncMediaCapabilityControls(): void {
  const unsupportedStatus = formatUnsupportedMediaCapabilities(browserMediaCapabilities);
  if (unsupportedStatus) {
    updateAudioDeviceStatus(unsupportedStatus);
  }

  startShareButton.hidden = !debugState.access.canStartScreenShare;
  stopShareButton.hidden = !debugState.access.canStartScreenShare;
  startWhiteboardButton.hidden = !debugState.access.canCreateWhiteboard;
  clearWhiteboardButton.hidden = !hasRoomPermission(debugState.access.permissions, "whiteboard.clear");
  stopWhiteboardButton.hidden = !hasRoomPermission(debugState.access.permissions, "surface.stop-object");
  remoteBrowserControlEl.hidden = !debugState.access.canCreateRemoteBrowser && !activeRemoteBrowserObjectForSurface(selectedMediaSurfaceId) && !findActiveRemoteBrowserObject();
  if (!debugState.access.canStartScreenShare) {
    startShareButton.disabled = true;
    startShareButton.title = "Host role required";
    stopShareButton.disabled = true;
  }
  if (!debugState.access.canCreateWhiteboard) {
    startWhiteboardButton.disabled = true;
    startWhiteboardButton.title = "Host role required";
  }
  if (!hasRoomPermission(debugState.access.permissions, "surface.stop-object")) {
    stopWhiteboardButton.disabled = true;
  }

  if (runtimeFlags.audioJoin && !audioMockEnabled && !browserMediaCapabilities.audioInput.supported) {
    joinAudioButton.disabled = true;
    joinAudioButton.textContent = "Audio Unsupported";
    joinAudioButton.title = `Microphone unsupported: ${describeMediaCapabilityReason(browserMediaCapabilities.audioInput.reason)}`;
    muteButton.disabled = true;
  }

  if (debugState.access.canStartScreenShare && runtimeFlags.screenShare && !shareMockEnabled && !browserMediaCapabilities.screenShare.supported) {
    startShareButton.disabled = true;
    startShareButton.textContent = "Share Unsupported";
    startShareButton.title = `Screen share unsupported: ${describeMediaCapabilityReason(browserMediaCapabilities.screenShare.reason)}`;
    stopShareButton.disabled = true;
    debugState.screenShareState = "unsupported";
  }
  syncSurfaceAudioControl();
  syncWhiteboardControls();
  syncRemoteBrowserControls();
}

async function applyPreferredAudioDevices(room: Room): Promise<void> {
  if (preferredMicDeviceId !== "default") {
    await room.switchActiveDevice("audioinput", preferredMicDeviceId).catch(() => undefined);
  }
  if (supportsAudioOutputSelection()) {
    const audioOutputId = preferredSpeakerDeviceId === "default" ? "default" : preferredSpeakerDeviceId;
    await room.switchActiveDevice("audiooutput", audioOutputId).catch(() => undefined);
    const context = audioContext as AudioContext & { setSinkId?: (deviceId: string) => Promise<void> } | null;
    if (context?.setSinkId) {
      await context.setSinkId(audioOutputId).catch(() => undefined);
    }
  }
}

async function resumeAudioContext(): Promise<void> {
  const context = ensureAudioContext();
  if (context.state === "suspended") {
    await context.resume();
  }
}

function createAudioAnalyser(context: AudioContext): {
  analyser: AnalyserNode;
  sampleBuffer: Uint8Array;
  lipsync: AvatarLipsyncDriver;
} {
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.35;
  return {
    analyser,
    sampleBuffer: new Uint8Array(analyser.fftSize),
    lipsync: createAvatarLipsyncDriver()
  };
}

function createMockAudioSource(): MockAudioSource {
  const context = ensureAudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const destination = context.createMediaStreamDestination();
  oscillator.type = "sine";
  oscillator.frequency.value = 440;
  gain.gain.value = 0.08;
  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start();
  const track = destination.stream.getAudioTracks()[0];
  if (!track) {
    throw createFaultError("NotFoundError", "no_audio_device");
  }
  return { oscillator, gain, destination, track };
}

function getMockAudioSource(): MockAudioSource {
  if (!mockAudioSource || mockAudioSource.track.readyState === "ended") {
    mockAudioSource = createMockAudioSource();
  }
  mockAudioSource.track.enabled = true;
  return mockAudioSource;
}

function stopMockAudioSource(): void {
  if (!mockAudioSource) {
    return;
  }
  mockAudioSource.oscillator.stop();
  mockAudioSource.oscillator.disconnect();
  mockAudioSource.gain.disconnect();
  mockAudioSource.track.stop();
  mockAudioSource = null;
}

function disconnectLocalAudioTrack(): void {
  if (!localAudioNode) {
    return;
  }
  localAudioNode.source.disconnect();
  localAudioNode = null;
}

function getLocalMicrophoneMediaTrack(room: Room): MediaStreamTrack | null {
  const publication = Array.from(room.localParticipant.trackPublications.values()).find((item) => item.source === Track.Source.Microphone);
  if (!publication) {
    return null;
  }
  const track = (publication as {
    track?: { mediaStreamTrack?: MediaStreamTrack };
    audioTrack?: { mediaStreamTrack?: MediaStreamTrack };
  }).audioTrack?.mediaStreamTrack ?? (publication as { track?: { mediaStreamTrack?: MediaStreamTrack } }).track?.mediaStreamTrack;
  return track ?? null;
}

async function publishMockMicrophoneTrack(room: Room): Promise<void> {
  const source = getMockAudioSource();
  const existingTrack = getLocalMicrophoneMediaTrack(room);
  if (existingTrack?.id === source.track.id) {
    return;
  }
  const localParticipant = room.localParticipant as {
    publishTrack?: (track: MediaStreamTrack, options?: { name?: string; source?: Track.Source }) => Promise<unknown> | unknown;
  };
  if (!localParticipant.publishTrack) {
    throw createFaultError("NotSupportedError", "audio_unsupported:publishTrack_missing");
  }
  await Promise.resolve(localParticipant.publishTrack(source.track, {
    name: "vrata-audio-mock",
    source: Track.Source.Microphone
  }));
}

function connectLocalAudioTrack(room: Room): void {
  const track = getLocalMicrophoneMediaTrack(room);
  if (!track) {
    disconnectLocalAudioTrack();
    return;
  }
  if (localAudioNode?.trackId === track.id) {
    return;
  }
  disconnectLocalAudioTrack();
  const context = ensureAudioContext();
  void resumeAudioContext();
  const analyserSetup = createAudioAnalyser(context);
  const source = context.createMediaStreamSource(new MediaStream([track]));
  source.connect(analyserSetup.analyser);
  localAudioNode = {
    source,
    analyser: analyserSetup.analyser,
    sampleBuffer: analyserSetup.sampleBuffer,
    lipsync: analyserSetup.lipsync,
    trackId: track.id
  };
}

function connectRemoteAudioTrack(track: Track, participantId: string): void {
  const mediaStreamTrack = (track as { mediaStreamTrack?: MediaStreamTrack }).mediaStreamTrack;
  const existing = remoteAudioNodes.get(participantId);
  if (existing?.trackId === mediaStreamTrack?.id) {
    return;
  }
  if (existing) {
    disconnectRemoteAudioElement(participantId);
  }
  const context = ensureAudioContext();
  void resumeAudioContext();
  const analyserSetup = createAudioAnalyser(context);
  const element = track.attach() as HTMLMediaElement & { playsInline?: boolean };
  element.autoplay = true;
  element.playsInline = true;
  element.style.display = "none";
  document.body.appendChild(element);
  void element.play().catch(() => undefined);
  const source = context.createMediaElementSource(element);
  const gain = context.createGain();
  const panner = spatialAudioRequested ? context.createPanner() : null;
  if (panner) {
    applySpatialSettings(panner, createSpatialAudioSettings());
  }
  source.connect(gain);
  gain.connect(analyserSetup.analyser);
  if (panner) {
    analyserSetup.analyser.connect(panner);
    panner.connect(context.destination);
  } else {
    analyserSetup.analyser.connect(context.destination);
  }
  remoteAudioNodes.set(participantId, {
    participantId,
    element,
    source,
    gain,
    analyser: analyserSetup.analyser,
    panner,
    sampleBuffer: analyserSetup.sampleBuffer,
    lipsync: analyserSetup.lipsync,
    trackId: mediaStreamTrack?.id ?? participantId
  });
  debugState.spatialAudioState = panner ? "active" : "fallback";
}

function getTrackNodeId(track: Track, fallback: string): string {
  return (track as { sid?: string; mediaStreamTrack?: MediaStreamTrack }).sid
    ?? (track as { mediaStreamTrack?: MediaStreamTrack }).mediaStreamTrack?.id
    ?? fallback;
}

function getPublicationTrackSid(publication: unknown, track: Track, fallback: string): string {
  return (publication as { trackSid?: string; sid?: string } | null)?.trackSid
    ?? (publication as { sid?: string } | null)?.sid
    ?? getTrackNodeId(track, fallback);
}

function screenShareEntries(): ScreenShareRuntimeEntry[] {
  return Array.from(screenShareRuntimeByObjectId.values());
}

function hasLocalScreenSharePublishing(): boolean {
  return screenShareEntries().some((entry) => !entry.remote);
}

function remoteScreenShareTrackCount(): number {
  return screenShareEntries().filter((entry) => entry.remote && (entry.track || entry.element)).length;
}

function localScreenShareEntryForSurface(surfaceId: string): ScreenShareRuntimeEntry | null {
  return screenShareEntries().find((entry) => !entry.remote && entry.surfaceId === surfaceId) ?? null;
}

function anyLocalScreenShareEntry(): ScreenShareRuntimeEntry | null {
  return screenShareEntries().find((entry) => !entry.remote) ?? null;
}

function screenShareEntryForTrack(track: Track): ScreenShareRuntimeEntry | null {
  return screenShareEntries().find((entry) => entry.track === track) ?? null;
}

function screenShareEntryForObject(objectId: string | null | undefined): ScreenShareRuntimeEntry | null {
  return objectId ? screenShareRuntimeByObjectId.get(objectId) ?? null : null;
}

function createScreenShareVideoTexture(element: HTMLVideoElement): THREE.VideoTexture {
  const texture = new THREE.VideoTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function clearScreenShareEntryTexture(entry: ScreenShareRuntimeEntry): void {
  if (!entry.texture) {
    return;
  }
  const material = getMediaSurfaceView(entry.surfaceId).object.material;
  if (material instanceof THREE.MeshBasicMaterial && material.map === entry.texture) {
    applySurfaceTexture(entry.surfaceId, null);
  } else if (!retainedDisplayTextures.has(entry.texture)) {
    entry.texture.dispose();
  }
  entry.texture = null;
}

function moveScreenShareEntryToSurface(entry: ScreenShareRuntimeEntry, surfaceId: string): void {
  if (entry.surfaceId === surfaceId) {
    return;
  }
  const texture = entry.texture;
  if (texture) {
    const material = getMediaSurfaceView(entry.surfaceId).object.material;
    if (material instanceof THREE.MeshBasicMaterial && material.map === texture) {
      retainedDisplayTextures.add(texture);
      applySurfaceTexture(entry.surfaceId, null);
      retainedDisplayTextures.delete(texture);
    }
    applySurfaceTexture(surfaceId, texture);
  }
  entry.surfaceId = surfaceId;
}

function registerScreenShareEntry(entry: ScreenShareRuntimeEntry): ScreenShareRuntimeEntry {
  const existing = screenShareRuntimeByObjectId.get(entry.objectId);
  if (existing && existing !== entry) {
    detachScreenShareEntry(existing);
  }
  screenShareRuntimeByObjectId.set(entry.objectId, entry);
  return entry;
}

function detachScreenShareEntry(entry: ScreenShareRuntimeEntry): void {
  entry.stopping = true;
  if (entry.track) {
    entry.track.detach().forEach((element) => element.remove());
    entry.track = null;
  }
  if (entry.element) {
    entry.element.remove();
    entry.element = null;
  }
  clearScreenShareEntryTexture(entry);
  entry.stream?.getTracks().forEach((track) => track.stop());
  entry.stream = null;
  entry.publishedTracks.forEach((track) => {
    if (track.readyState !== "ended") {
      track.stop();
    }
  });
  entry.publishedTracks = [];
  screenShareRuntimeByObjectId.delete(entry.objectId);
  debugState.screenShare.remoteSubscribedTrackCount = remoteScreenShareTrackCount();
  if (!hasLocalScreenSharePublishing() && remoteScreenShareTrackCount() === 0 && debugState.screenShareState !== "stopped") {
    debugState.screenShareState = "idle";
  }
}

async function unpublishScreenShareEntry(entry: ScreenShareRuntimeEntry): Promise<void> {
  const localParticipant = livekitRoom?.localParticipant as {
    unpublishTrack?: (track: MediaStreamTrack, stopOnUnpublish?: boolean) => Promise<unknown> | unknown;
  } | undefined;
  if (!localParticipant?.unpublishTrack) {
    return;
  }
  await Promise.all(entry.publishedTracks.map((track) => Promise.resolve(localParticipant.unpublishTrack!(track, true)).catch(() => undefined)));
}

function handleLocalScreenShareTrackEnded(objectId: string, surfaceId: string): void {
  const entry = screenShareRuntimeByObjectId.get(objectId);
  if (!entry || entry.remote || entry.stopping) {
    return;
  }
  entry.stopping = true;
  void unpublishScreenShareEntry(entry).finally(() => {
    detachScreenShareEntry(entry);
    debugState.screenShareState = "stopped";
    lastScreenShareStoppedAtMs = Date.now();
    debugState.screenShare.active = hasLocalScreenSharePublishing();
    debugState.screenShare.localPublishing = hasLocalScreenSharePublishing();
    debugState.screenShare.publishedTrackSid = null;
    startShareButton.disabled = !canUseScreenShareControl();
    stopShareButton.disabled = !canStopLocalScreenShare();
    void mediaSurfaceCommands.stopScreenShareObject(objectId, surfaceId).catch(() => undefined);
    void reportDiagnostics("screenshare_track_ended");
  });
}

function bindLocalScreenShareTrackEnd(objectId: string, surfaceId: string, tracks: MediaStreamTrack[]): void {
  for (const track of tracks) {
    track.addEventListener("ended", () => handleLocalScreenShareTrackEnded(objectId, surfaceId), { once: true });
  }
}

function isActiveScreenShareObject(object: MediaObjectInstance<ScreenShareObjectState> | null | undefined): object is MediaObjectInstance<ScreenShareObjectState> {
  return isCurrentScreenShareObject(object)
    && object.state.status === "active";
}

function isCurrentScreenShareObject(object: MediaObjectInstance<ScreenShareObjectState> | null | undefined): object is MediaObjectInstance<ScreenShareObjectState> {
  if (!object) {
    return false;
  }
  return object.type === SCREEN_SHARE_OBJECT_TYPE
    && object.state.status !== "stopped"
    && object.state.status !== "failed"
    && roomMediaObjects?.surfaces[object.surfaceId]?.activeObjectId === object.objectId;
}

function syncScreenShareRuntimeWithObjects(): void {
  if (!roomMediaObjects) {
    return;
  }
  for (const entry of screenShareEntries()) {
    const currentObject = roomMediaObjects.objects[entry.objectId] as MediaObjectInstance<ScreenShareObjectState> | undefined;
    const matchedObject = isCurrentScreenShareObject(currentObject)
      ? currentObject
      : screenShareObjectForMediaTrack(roomMediaObjects, entry.ownerParticipantId, entry.mediaTrackSid);
    if (!isCurrentScreenShareObject(matchedObject)) {
      detachScreenShareEntry(entry);
      continue;
    }
    if (matchedObject.objectId !== entry.objectId) {
      screenShareRuntimeByObjectId.delete(entry.objectId);
      entry.objectId = matchedObject.objectId;
      screenShareRuntimeByObjectId.set(entry.objectId, entry);
    }
    entry.ownerParticipantId = matchedObject.ownerParticipantId;
    entry.mediaTrackSid = matchedObject.state.mediaTrackSid ?? entry.mediaTrackSid;
    moveScreenShareEntryToSurface(entry, matchedObject.surfaceId);
  }
}

function prepareHiddenVideoElement(element: HTMLVideoElement, options: { muted: boolean }): void {
  element.autoplay = true;
  element.muted = options.muted;
  element.playsInline = true;
  element.style.position = "fixed";
  element.style.left = "-1px";
  element.style.top = "-1px";
  element.style.width = "1px";
  element.style.height = "1px";
  element.style.opacity = "0";
  element.style.pointerEvents = "none";
}

function startHiddenVideoPlayback(element: HTMLVideoElement, onError?: (error: string | null) => void): void {
  const play = () => {
    void element.play().then(() => {
      onError?.(null);
    }).catch((error: unknown) => {
      const message = error instanceof Error ? `${error.name}:${error.message}` : "video_play_failed";
      onError?.(message);
    });
  };
  play();
  element.addEventListener("loadedmetadata", play, { once: true });
  element.addEventListener("canplay", play, { once: true });
}

function remoteBrowserVideoEntryForObject(objectId: string | null | undefined): RemoteBrowserVideoEntry | null {
  return objectId ? remoteBrowserVideoByObjectId.get(objectId) ?? null : null;
}

function remoteBrowserVideoEntryForTrack(track: Track): RemoteBrowserVideoEntry | null {
  for (const entry of remoteBrowserVideoByObjectId.values()) {
    if (entry.track === track) {
      return entry;
    }
  }
  return null;
}

function createRemoteBrowserVideoTexture(element: HTMLVideoElement): THREE.VideoTexture {
  const texture = new THREE.VideoTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function moveRemoteBrowserVideoEntryToSurface(entry: RemoteBrowserVideoEntry, surfaceId: string): void {
  if (entry.surfaceId === surfaceId) {
    return;
  }
  const material = getMediaSurfaceView(entry.surfaceId).object.material;
  if (material instanceof THREE.MeshBasicMaterial && material.map === entry.texture) {
    retainedDisplayTextures.add(entry.texture);
    applySurfaceTexture(entry.surfaceId, null);
    retainedDisplayTextures.delete(entry.texture);
  }
  applySurfaceTexture(surfaceId, entry.texture);
  entry.surfaceId = surfaceId;
}

function detachRemoteBrowserVideoEntry(entry: RemoteBrowserVideoEntry): void {
  entry.track.detach().forEach((element) => element.remove());
  entry.element.remove();
  const material = getMediaSurfaceView(entry.surfaceId).object.material;
  if (material instanceof THREE.MeshBasicMaterial && material.map === entry.texture) {
    applySurfaceTexture(entry.surfaceId, null);
  } else if (!retainedDisplayTextures.has(entry.texture)) {
    entry.texture.dispose();
  }
  remoteBrowserVideoByObjectId.delete(entry.objectId);
  const object = activeRemoteBrowserObjectForSurface(entry.surfaceId);
  if (object) {
    getRemoteBrowserRuntime(entry.surfaceId).sync(object);
  }
}

function isCurrentRemoteBrowserObject(object: MediaObjectInstance<RemoteBrowserObjectState> | null | undefined): object is MediaObjectInstance<RemoteBrowserObjectState> {
  if (!object) {
    return false;
  }
  return object.type === REMOTE_BROWSER_OBJECT_TYPE
    && object.state.status !== "stopped"
    && object.state.status !== "failed"
    && roomMediaObjects?.surfaces[object.surfaceId]?.activeObjectId === object.objectId;
}

function syncRemoteBrowserVideoRuntimeWithObjects(): void {
  if (!roomMediaObjects) {
    return;
  }
  for (const entry of Array.from(remoteBrowserVideoByObjectId.values())) {
    const object = roomMediaObjects.objects[entry.objectId] as MediaObjectInstance<RemoteBrowserObjectState> | undefined;
    if (!isCurrentRemoteBrowserObject(object) || (object.state.mediaTrackSid && object.state.mediaTrackSid !== entry.trackSid)) {
      detachRemoteBrowserVideoEntry(entry);
      continue;
    }
    moveRemoteBrowserVideoEntryToSurface(entry, object.surfaceId);
  }
}

function startRemoteBrowserExternalVideoFrameDiagnostics(entry: RemoteBrowserVideoEntry): void {
  const element = entry.element;
  const video = element as HTMLVideoElement & {
    requestVideoFrameCallback?: (callback: (now: number, metadata: { presentedFrames?: number }) => void) => number;
  };
  if (!video.requestVideoFrameCallback) {
    return;
  }
  const onFrame = (_now: number, metadata: { presentedFrames?: number }) => {
    if (remoteBrowserVideoByObjectId.get(entry.objectId) !== entry) {
      return;
    }
    entry.frameCount += 1;
    entry.lastFrameAtMs = Date.now();
    entry.presentedFrames = metadata.presentedFrames ?? entry.presentedFrames;
    video.requestVideoFrameCallback?.(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
}

function createRemoteBrowserExternalVideoDebugSnapshot(object: MediaObjectInstance<RemoteBrowserObjectState> | null): {
  externalVideoAttached: boolean;
  externalVideoObjectId: string | null;
  externalVideoTrackSid: string | null;
  externalVideoPaused: boolean | null;
  externalVideoReadyState: number | null;
  externalVideoCurrentTime: number | null;
  externalVideoWidth: number;
  externalVideoHeight: number;
  externalVideoMuted: boolean | null;
  externalVideoAutoplay: boolean | null;
  externalVideoPlayError: string | null;
  externalVideoFrameCount: number;
  externalVideoLastFrameAtMs: number;
  externalVideoPresentedFrames: number;
} {
  const entry = remoteBrowserVideoEntryForObject(object?.objectId);
  const element = entry?.element ?? null;
  return {
    externalVideoAttached: Boolean(element),
    externalVideoObjectId: entry?.objectId ?? null,
    externalVideoTrackSid: entry?.trackSid ?? null,
    externalVideoPaused: element?.paused ?? null,
    externalVideoReadyState: element?.readyState ?? null,
    externalVideoCurrentTime: element ? Number(element.currentTime.toFixed(3)) : null,
    externalVideoWidth: element?.videoWidth ?? 0,
    externalVideoHeight: element?.videoHeight ?? 0,
    externalVideoMuted: element?.muted ?? null,
    externalVideoAutoplay: element?.autoplay ?? null,
    externalVideoPlayError: entry?.playError ?? null,
    externalVideoFrameCount: entry?.frameCount ?? 0,
    externalVideoLastFrameAtMs: entry?.lastFrameAtMs ?? 0,
    externalVideoPresentedFrames: entry?.presentedFrames ?? 0
  };
}

function resolveRemoteBrowserObjectForTrack(participantIdentity: string | null | undefined, publication: unknown, track: Track, kind: "audio" | "video"): MediaObjectInstance<RemoteBrowserObjectState> | null {
  const trackSid = getPublicationTrackSid(publication, track, "");
  return remoteBrowserObjectForMediaTrack(roomMediaObjects, participantIdentity, trackSid || null, kind);
}

function getPublicationName(publication: unknown): string | null {
  const name = (publication as { trackName?: unknown; name?: unknown } | null)?.trackName
    ?? (publication as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : null;
}

function screenShareObjectForPublicationName(name: string | null): MediaObjectInstance<ScreenShareObjectState> | null {
  const match = /^screen-share:([^:]+):(video|audio)$/.exec(name ?? "");
  if (!match || !roomMediaObjects) {
    return null;
  }
  const object = roomMediaObjects.objects[match[1]!];
  return isCurrentScreenShareObject(object as MediaObjectInstance<ScreenShareObjectState> | undefined)
    ? object as MediaObjectInstance<ScreenShareObjectState>
    : null;
}

function resolveScreenShareObjectForTrack(participantIdentity: string | null | undefined, publication: unknown, track: Track): MediaObjectInstance<ScreenShareObjectState> | null {
  const publicationNamedObject = screenShareObjectForPublicationName(getPublicationName(publication));
  if (publicationNamedObject) {
    return publicationNamedObject;
  }
  const trackSid = getPublicationTrackSid(publication, track, "");
  return screenShareObjectForMediaTrack(roomMediaObjects, participantIdentity, trackSid || null);
}

function syncRemoteBrowserLiveKitTracks(): void {
  if (!livekitRoom) {
    return;
  }
  for (const participant of livekitRoom.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      const videoTrack = (publication as { videoTrack?: Track; track?: Track }).videoTrack ?? ((publication as { kind?: unknown }).kind === Track.Kind.Video ? (publication as { track?: Track }).track : undefined);
      if (videoTrack) {
        const object = resolveRemoteBrowserObjectForTrack(participant.identity, publication, videoTrack, "video");
        if (object) {
          attachRemoteBrowserVideoTrack(videoTrack, object, publication);
        }
      }
      const audioTrack = (publication as { audioTrack?: Track; track?: Track }).audioTrack ?? ((publication as { kind?: unknown }).kind === Track.Kind.Audio ? (publication as { track?: Track }).track : undefined);
      if (audioTrack) {
        const object = resolveRemoteBrowserObjectForTrack(participant.identity, publication, audioTrack, "audio");
        if (object) {
          connectMediaSurfaceAudioTrack(audioTrack, object.surfaceId);
          debugState.remoteBrowser.mediaHasAudio = true;
        }
      }
    }
  }
}

function syncScreenShareLiveKitTracks(): void {
  if (!livekitRoom) {
    return;
  }
  for (const participant of livekitRoom.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      const videoTrack = (publication as { videoTrack?: Track; track?: Track }).videoTrack ?? ((publication as { kind?: unknown }).kind === Track.Kind.Video ? (publication as { track?: Track }).track : undefined);
      if (videoTrack && !resolveRemoteBrowserObjectForTrack(participant.identity, publication, videoTrack, "video")) {
        const object = resolveScreenShareObjectForTrack(participant.identity, publication, videoTrack);
        if (object) {
          attachVideoTrack(videoTrack, {
            remote: true,
            objectId: object.objectId,
            surfaceId: object.surfaceId,
            ownerParticipantId: object.ownerParticipantId,
            mediaTrackSid: object.state.mediaTrackSid ?? getPublicationTrackSid(publication, videoTrack, object.objectId)
          });
        }
      }
      const audioTrack = (publication as { audioTrack?: Track; track?: Track }).audioTrack ?? ((publication as { kind?: unknown }).kind === Track.Kind.Audio ? (publication as { track?: Track }).track : undefined);
      if (audioTrack && isScreenShareAudioSource((publication as { source?: unknown }).source)) {
        const object = resolveScreenShareObjectForTrack(participant.identity, publication, audioTrack);
        connectMediaSurfaceAudioTrack(audioTrack, object?.surfaceId ?? resolveScreenShareSurfaceForParticipant(participant.identity));
      }
    }
  }
}

function ensureRemoteBrowserLiveKitRoom(): void {
  const remoteBrowser = findRemoteBrowserObjectNeedingLiveKitRoom();
  if (!remoteBrowser) {
    return;
  }
  if (livekitRoom) {
    syncRemoteBrowserLiveKitTracks();
    return;
  }
  if (remoteBrowserMediaRoomPromise) {
    return;
  }
  remoteBrowserMediaRoomPromise = ensureMediaRoom()
    .then(() => {
      syncRemoteBrowserLiveKitTracks();
    })
    .catch((error: unknown) => {
      console.error(error);
      const object = currentRemoteBrowserObject();
      getRemoteBrowserRuntime(object?.surfaceId ?? selectedMediaSurfaceId).setError(error instanceof Error ? error.message : "remote_browser_livekit_connect_failed");
    })
    .finally(() => {
      remoteBrowserMediaRoomPromise = null;
    });
}

function resolveScreenShareSurfaceForParticipant(ownerParticipantId: string | null | undefined): string {
  return resolveScreenShareSurfaceForOwner(roomMediaObjects, ownerParticipantId, DEBUG_SURFACE_ID);
}

function connectMediaSurfaceAudioTrack(track: Track, surfaceId: string): void {
  const trackId = getTrackNodeId(track, `${surfaceId}:screen-share-audio`);
  const existing = mediaSurfaceAudioNodes.get(surfaceId);
  if (existing?.trackId === trackId) {
    return;
  }
  if (existing) {
    disconnectMediaSurfaceAudioTrack(surfaceId);
  }
  const element = track.attach() as HTMLMediaElement & { playsInline?: boolean };
  element.autoplay = true;
  element.playsInline = true;
  element.style.display = "none";
  document.body.appendChild(element);
  void element.play().catch(() => undefined);
  const mediaStreamTrack = (track as { mediaStreamTrack?: MediaStreamTrack }).mediaStreamTrack;
  const context = mediaStreamTrack ? ensureAudioContext() : null;
  const analyserSetup = context ? createAudioAnalyser(context) : null;
  const source = context && mediaStreamTrack ? context.createMediaStreamSource(new MediaStream([mediaStreamTrack])) : null;
  if (source && analyserSetup) {
    void resumeAudioContext();
    source.connect(analyserSetup.analyser);
  }
  mediaSurfaceAudioNodes.set(surfaceId, {
    surfaceId,
    element,
    source,
    analyser: analyserSetup?.analyser ?? null,
    sampleBuffer: analyserSetup?.sampleBuffer ?? null,
    trackId
  });
  syncSurfaceAudioControl();
}

function disconnectMediaSurfaceAudioTrack(surfaceId: string): void {
  const node = mediaSurfaceAudioNodes.get(surfaceId);
  if (!node) {
    return;
  }
  node.element.remove();
  node.source?.disconnect();
  node.analyser?.disconnect();
  mediaSurfaceAudioNodes.delete(surfaceId);
  syncSurfaceAudioControl();
}

function disconnectMediaSurfaceAudioTrackByTrack(track: Track): void {
  const trackId = getTrackNodeId(track, "");
  for (const [surfaceId, node] of mediaSurfaceAudioNodes.entries()) {
    if (!trackId || node.trackId === trackId) {
      disconnectMediaSurfaceAudioTrack(surfaceId);
    }
  }
}

function disconnectRemoteAudioElement(participantId: string): void {
  const node = remoteAudioNodes.get(participantId);
  if (!node) {
    return;
  }
  node.element.remove();
  node.source.disconnect();
  node.gain.disconnect();
  node.analyser.disconnect();
  node.panner?.disconnect();
  remoteAvatarRuntime.setParticipantLipsync(participantId, {
    mouthAmount: 0,
    speakingActive: false,
    sourceState: "missing"
  }, debugState);
  remoteAudioNodes.delete(participantId);
  if (remoteAudioNodes.size === 0) {
    debugState.spatialAudioState = "idle";
  }
}

function updateSpatialAudio(): void {
  const listenerPosition = new THREE.Vector3();
  camera.getWorldPosition(listenerPosition);
  const listenerYaw = getCameraWorldYaw();
  debugState.spatialAudio = {
    enabled: spatialAudioRequested,
    fallback: !spatialAudioRequested || !audioContext,
    listener: {
      x: roundDebugNumber(listenerPosition.x),
      y: roundDebugNumber(listenerPosition.y),
      z: roundDebugNumber(listenerPosition.z),
      yaw: roundDebugNumber(listenerYaw)
    },
    remoteSources: debugState.remoteParticipants.map((participant) => {
      const target = remoteAvatarRuntime.getAudioTarget(participant.participantId);
      const audioNode = remoteAudioNodes.get(participant.participantId);
      const remoteParticipant = livekitRoom?.remoteParticipants.get(participant.participantId);
      return {
        participantId: participant.participantId,
        x: roundDebugNumber(target?.x ?? participant.head.x),
        y: roundDebugNumber(target?.y ?? participant.head.y),
        z: roundDebugNumber(target?.z ?? participant.head.z),
        attachedTo: "head" as const,
        hasAudioNode: Boolean(audioNode),
        pannerActive: Boolean(audioNode?.panner),
        audioLevel: roundDebugNumber(remoteParticipant?.audioLevel ?? 0)
      };
    })
  };

  if (!audioContext || !spatialAudioRequested) {
    return;
  }
  const listener = audioContext.listener;
  listener.positionX.value = listenerPosition.x;
  listener.positionY.value = listenerPosition.y;
  listener.positionZ.value = listenerPosition.z;

  for (const [participantId, node] of remoteAudioNodes.entries()) {
    const target = remoteAvatarRuntime.getAudioTarget(participantId);
    if (!target || !node.panner) {
      continue;
    }
    node.panner.positionX.value = target.x;
    node.panner.positionY.value = target.y;
    node.panner.positionZ.value = target.z;
  }
}

function updateAudioUi(): void {
  updateAudioMeter(micLevelFill, localMicLevel);
  updateAudioMeter(speakerLevelFill, speakerOutputLevel);
}

function updateAvatarLipsync(deltaSeconds: number): void {
  if (livekitRoom && microphoneEnabled && !localAudioNode) {
    connectLocalAudioTrack(livekitRoom);
  }
  const localSourceState: AvatarLipsyncSourceState = !livekitRoom
    ? "idle"
    : !microphoneEnabled
      ? "muted"
      : localAudioNode
        ? "active"
        : "missing";
  const localLevel = localAudioNode
    ? sampleAvatarLipsyncLevel(localAudioNode.analyser, localAudioNode.sampleBuffer)
    : 0;
  localMicLevel = localLevel;
  debugState.localMicLevel = Number(localMicLevel.toFixed(3));
  const localLipsync = updateAvatarLipsyncDriver(localAudioNode?.lipsync ?? localAvatarLipsync, {
    deltaSeconds,
    level: localLevel,
    sourceState: localSourceState
  });
  if (localAvatarController) {
    localAvatarController.diagnostics.mouthAmount = Number(localLipsync.mouthAmount.toFixed(3));
    localAvatarController.diagnostics.speakingActive = localLipsync.speakingActive;
    localAvatarController.diagnostics.lipsyncSourceState = localLipsync.sourceState;
  }

  if (!livekitRoom) {
    speakerOutputLevel = 0;
    debugState.speakerOutputLevel = 0;
    return;
  }

  let maxSpeakerLevel = 0;
  for (const participant of livekitRoom.remoteParticipants.values()) {
    maxSpeakerLevel = Math.max(maxSpeakerLevel, participant.audioLevel ?? 0);
  }
  for (const node of mediaSurfaceAudioNodes.values()) {
    if (node.analyser && node.sampleBuffer) {
      maxSpeakerLevel = Math.max(maxSpeakerLevel, sampleAvatarLipsyncLevel(node.analyser, node.sampleBuffer));
    }
  }
  speakerOutputLevel = maxSpeakerLevel;
  debugState.speakerOutputLevel = Number(speakerOutputLevel.toFixed(3));

  for (const [remoteParticipantId, participant] of livekitRoom.remoteParticipants.entries()) {
    const node = remoteAudioNodes.get(remoteParticipantId);
    const sourceState: AvatarLipsyncSourceState = node
      ? participant.isMicrophoneEnabled
        ? "active"
        : "muted"
      : "missing";
    const level = participant.audioLevel ?? 0;
    const lipsync = updateAvatarLipsyncDriver(node?.lipsync ?? createAvatarLipsyncDriver(), {
      deltaSeconds,
      level,
      sourceState
    });
    remoteAvatarRuntime.setParticipantLipsync(remoteParticipantId, lipsync, debugState);
  }
}

const debugState = {
  participantId,
  mode: latestMode,
  remoteAvatarCount: 0,
  remoteAvatarReliableCount: 0,
  remoteAvatarPoseCount: 0,
  statusLine: "Connecting...",
  lastReportId: null as string | null,
  lastReportRequestId: null as string | null,
  locomotionMode: "desktop",
  roomStateConnected: false,
  roomStateUrl: "",
  roomStateMode: "disconnected",
  audioState: "idle",
  localMicLevel: 0,
  speakerOutputLevel: 0,
  media: {
    audioState: "not_joined" as "not_joined" | "joining" | "joined" | "muted" | "degraded" | "failed",
    muted: true,
    publishedAudio: false,
    audioSource: "none" as "none" | "microphone" | "mock",
    subscribedAudioCount: 0,
    webrtc: createUnavailableWebRtcDiagnostics()
  },
  access: {
    ...createRoomAccessDebugState("guest"),
    token: "",
    expiresInSeconds: 0,
    roleQueryAllowed: false,
    lastDeniedPermission: null as string | null,
    lastSurfaceCommandAccepted: null as boolean | null
  },
  screenShareState: "idle",
  screenShare: {
    supported: shareMockEnabled || browserMediaCapabilities.screenShare.supported,
    active: false,
    localPublishing: false,
    selectedSurfaceId: null as string | null,
    publishedTrackSid: null as string | null,
    remoteSubscribedTrackCount: 0,
    mediaAudioEnabled: false,
    errorCode: null as ScreenShareErrorCode | null
  },
  remoteBrowser: {
    objectId: null as string | null,
    surfaceId: DEBUG_SURFACE_ID,
    active: false,
    status: "idle" as RemoteBrowserObjectState["status"] | "idle",
    currentUrl: null as string | null,
    controllerParticipantId: null as string | null,
    executorSessionId: null as string | null,
    frameStreamId: null as string | null,
    mediaParticipantId: null as string | null,
    mediaTrackSid: null as string | null,
    audioTrackSid: null as string | null,
    streamStartedAtMs: null as number | null,
    streamUpdatedAtMs: null as number | null,
    frameConnected: false,
    frameStreamUrl: null as string | null,
    lastFrameAtMs: 0,
    frameSize: null as { width: number; height: number } | null,
    localCanOpen: false,
    localCanInput: false,
    localHasControl: false,
    lastInputSeq: 0,
    lastExecutorInput: null as RemoteBrowserExecutorInputState | null,
    errorCode: null as RemoteBrowserErrorCode | string | null,
    mediaState: "idle" as string,
    mediaConnected: false,
    mediaHasVideo: false,
    mediaHasAudio: false,
    mediaPeerConnectionState: null as RTCPeerConnectionState | null,
    mediaErrorCode: null as string | null,
    mediaSourceRect: null as null | { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number },
    mediaCompositeHoldActive: false,
    externalVideoAttached: false,
    externalVideoObjectId: null as string | null,
    externalVideoTrackSid: null as string | null,
    externalVideoPaused: null as boolean | null,
    externalVideoReadyState: null as number | null,
    externalVideoCurrentTime: null as number | null,
    externalVideoWidth: 0,
    externalVideoHeight: 0,
    externalVideoMuted: null as boolean | null,
    externalVideoAutoplay: null as boolean | null,
    externalVideoPlayError: null as string | null,
    externalVideoFrameCount: 0,
    externalVideoLastFrameAtMs: 0,
    externalVideoPresentedFrames: 0,
    xrKeyboardToggleVisible: false,
    xrKeyboardVisible: false,
    xrKeyboardOpen: false,
    xrKeyboardLayout: "en-US" as string,
    xrKeyboardHoveredKey: null as string | null,
    xrKeyboardHoveredTarget: null as string | null,
    xrKeyboardPressedTarget: null as string | null,
    xrKeyboardLastKey: null as string | null
  },
  surfaceAudio: {
    surfaceId: DEBUG_SURFACE_ID,
    mediaAudioEnabled: false,
    canConfigure: false,
    pending: false,
    subscribedAudioCount: 0
  },
  whiteboard: {
    objectId: null as string | null,
    surfaceId: DEBUG_SURFACE_ID,
    active: false,
    strokeCount: 0,
    revision: 0,
    localCanDraw: false,
    localCanClear: false,
    drawToolActive: false,
    xrPointerActive: false,
    xrPencilVisible: false,
    localPreviewPointCount: 0,
    lastInputSource: null as SurfaceInputSource | null,
    lastPoint: null as null | { u: number; v: number },
    errorCode: null as string | null
  },
  mediaCapabilities: browserMediaCapabilities,
  spatialAudioState: "idle",
  spatialAudio: {
    enabled: spatialAudioRequested,
    fallback: !spatialAudioRequested,
    listener: { x: 0, y: 1.6, z: 6, yaw: 0 },
    remoteSources: [] as Array<{
      participantId: string;
      x: number;
      y: number;
      z: number;
      attachedTo: "head" | "body" | "root";
      hasAudioNode: boolean;
      pannerActive: boolean;
      audioLevel: number;
    }>
  },
  localPosition: { x: initialLocalPosition.x, z: initialLocalPosition.z },
  localPose: {
    root: { x: initialLocalPosition.x, y: initialLocalPosition.y, z: initialLocalPosition.z, yaw: 0 },
    head: { x: initialLocalPosition.x, y: initialLocalPosition.y + 1.6, z: initialLocalPosition.z, yaw: 0, pitch: 0 }
  },
  xrAxes: { moveX: 0, moveY: 0, turnX: 0, turnY: 0 },
  botMode,
  issueCode: null as RuntimeIssue["code"] | null,
  issueSeverity: null as RuntimeIssue["severity"] | null,
  degradedMode: "none",
  retryCount: 0,
  lastRecoveryAction: "none",
  featureFlags: runtimeFlags,
  faultInjection: faultConfig,
  lastPresenceSyncAt: 0,
  lastPresenceRefreshAt: 0,
  remoteTargets: [] as Array<{ id: string; x: number; z: number }>,
  remoteParticipants: [] as Array<{
    participantId: string;
    mode: PresenceState["mode"];
    root: { x: number; y: number; z: number; yaw: number };
    body: { x: number; y: number; z: number; yaw: number };
    head: { x: number; y: number; z: number; yaw: number; pitch: number };
    lastSeq: number;
    staleMs: number;
    updateHz: number;
    interpolationDelayMs: number;
    maxObservedJumpM: number;
    muted: boolean;
    activeAudio: boolean;
    hasVisualEntity: boolean;
    hasAudioNode: boolean;
    appliedRootYaw: number;
    appliedHeadYaw: number;
  }>,
  sceneBundleUrl: null as string | null,
  sceneBundleState: "fallback" as "fallback" | "loaded" | "failed",
  sceneDebug: createEmptySceneDiagnostics(),
  spaceSelectorState: "loading" as "loading" | "ready" | "empty" | "unavailable",
  availableSpaceCount: 0,
  avatarDebug: createEmptyAvatarDiagnostics(),
  avatarPresenceMode: "baseline" as "baseline" | "experimental-leg-ik",
  avatarSnapshot: null as LocalAvatarSnapshotV1 | null,
  avatarTransportPreview: null as AvatarOutboundPayload | null,
  avatarPoseTransport: {
    targetHz: 0,
    effectiveHz: 0,
    sendsInLastSecond: 0,
    lastPoseSentAtMs: 0,
    lastPoseSeq: 0,
    reconnectRepublishCount: 0,
    frameBudgetMs: 0,
    adaptivePlaybackDelayMs: 100
  },
  xrAvatarDebug: null as null | {
    profile: string | null;
    playerRoot: { x: number; y: number; z: number; yaw: number };
    headWorld: { x: number; y: number; z: number };
    leftGrip: { x: number; y: number; z: number } | null;
    rightGrip: { x: number; y: number; z: number } | null;
    leftController: { x: number; y: number; z: number } | null;
    rightController: { x: number; y: number; z: number } | null;
    leftResolved: { x: number; y: number; z: number } | null;
    rightResolved: { x: number; y: number; z: number } | null;
    rightHandWorld: { x: number; y: number; z: number } | null;
    rightControllerWorld: { x: number; y: number; z: number } | null;
  },
  remoteAvatarReliableStates: [] as Array<{ participantId: string; avatarId: string; inputMode: string; updatedAt: string }>,
  remoteAvatarPoseFrames: [] as Array<{ participantId: string; seq: number; locomotionMode: number; sentAtMs: number }>,
  currentSeatId: null as string | null,
  pendingSeatId: null as string | null,
  seatOccupancy: {} as Record<string, string>,
  interactionRay: {
    active: false,
    mode: "none" as "none" | "cursor" | "xr-right-stick",
    targetKind: "none" as "none" | "floor" | "seat" | "surface" | "keyboard",
    seatId: null as string | null,
    point: null as null | { x: number; y: number; z: number },
    origin: null as null | { x: number; y: number; z: number },
    direction: null as null | { x: number; y: number; z: number },
    source: null as null | { index: number; handedness: string | null }
  },
  surfaceInput: createSurfaceInputDebugState(DEBUG_SURFACE_ID),
  mediaObjects: {
    selectedSurfaceId: DEBUG_SURFACE_ID,
    surfaces: [] as Array<{
      surfaceId: string;
      label?: string;
      allowedObjectTypes: string[];
      activeObjectId: string | null;
      activeObjectType: string | null;
      inputEnabled: boolean;
      mediaAudioEnabled: boolean;
      lockedByParticipantId: string | null;
      visible: boolean;
      runtimeVisible: boolean;
    }>,
    objects: [] as Array<{
      objectId: string;
      type: string;
      surfaceId: string;
      ownerParticipantId: string;
      state: unknown;
      revision: number;
      status: string;
    }>,
    extensions: getMediaExtensionDebugSnapshot(),
    availableObjectTypes: [] as string[],
    lastCommand: null as SurfaceCommandResult | null,
    blockedReason: null as string | null,
    activeTestCardClickCount: null as number | null
  },
  remoteAvatarParticipants: [] as Array<{
    participantId: string;
    avatarId: string | null;
    inputMode: string | null;
    presenceSeen: boolean;
    hasReliableState: boolean;
    hasPoseFrame: boolean;
    leftHandVisible: boolean;
    rightHandVisible: boolean;
    poseBufferDepth: number;
    droppedStaleCount: number;
    droppedReorderCount: number;
    lastPoseSeq: number | null;
    poseAgeMs: number | null;
    playbackDelayMs: number;
    mouthAmount: number;
    speakingActive: boolean;
    lipsyncSourceState: AvatarLipsyncSourceState | null;
  }>
};

const floorMaterial = floor.material as THREE.MeshStandardMaterial;

(window as Window & { __VRATA_DEBUG__?: typeof debugState }).__VRATA_DEBUG__ = debugState;
(window as Window & { __NOAH_DEBUG__?: typeof debugState }).__NOAH_DEBUG__ = debugState;
(window as Window & {
  __VRATA_TEST__?: {
    forceRoomStateReconnect: () => void;
    aimInteractionAtSeat: (seatId: string) => boolean;
    aimInteractionAtFloor: (x: number, z: number) => boolean;
    confirmInteraction: () => void;
    claimSeatById: (seatId: string) => boolean;
    requestSeatClaimById: (seatId: string) => boolean;
    sendPrivilegedSurfaceCreate: () => boolean;
    createSurfaceTestCard: () => boolean;
    createExtensionTestCard: (surfaceId?: string) => boolean;
    createMissingCapabilityExtensionObject: (surfaceId?: string) => boolean;
    createDisabledExtensionObject: (surfaceId?: string) => boolean;
    createScreenShareObject: (surfaceId?: string) => boolean;
    createWhiteboardObject: (surfaceId?: string) => boolean;
    createRemoteBrowserObject: (surfaceId?: string) => boolean;
    selectMediaSurface: (surfaceId: string) => boolean;
    openRemoteBrowser: (url?: string) => boolean;
    takeRemoteBrowserControl: () => boolean;
    releaseRemoteBrowserControl: () => boolean;
    createUnknownSurfaceObject: () => boolean;
    stopActiveSurfaceObject: (surfaceId?: string) => boolean;
    sendStaleSurfaceTestCardPatch: () => boolean;
    sendStaleScreenSharePatch: () => boolean;
    sendStaleWhiteboardPatch: () => boolean;
    sendDuplicateWhiteboardPatch: () => boolean;
    clearWhiteboardObject: () => boolean;
    setDebugSurfaceMediaAudioEnabled: (enabled: boolean, surfaceId?: string) => boolean;
    startScreenShare: () => boolean;
    sendDebugSurfaceInput: (input?: {
      source?: SurfaceInputSource;
      kind?: SurfaceInputKind;
      u?: number;
      v?: number;
      key?: string;
      text?: string;
      scrollDelta?: SurfaceInputScrollDelta;
      surfaceId?: string;
    }) => boolean;
    setDebugSurfaceInputEnabled: (enabled: boolean) => boolean;
    focusDebugSurface: (surfaceId?: string) => boolean;
    getDebugSurfaceWorldPosition: (u: number, v: number) => { x: number; y: number; z: number } | null;
    getDebugSurfaceClientPosition: (u: number, v: number) => { x: number; y: number } | null;
    getMediaSurfaceWorldPosition: (surfaceId: string, u: number, v: number) => { x: number; y: number; z: number } | null;
    getMediaSurfaceClientPosition: (surfaceId: string, u: number, v: number) => { x: number; y: number } | null;
    sampleDebugSurfaceTexture: (center: { u: number; v: number }, size?: { width: number; height: number }) => { clip: { sx: number; sy: number; sw: number; sh: number }; samples: Array<[number, number, number]> } | null;
    sampleMediaSurfaceTexture: (surfaceId: string, center: { u: number; v: number }, size?: { width: number; height: number }) => { clip: { sx: number; sy: number; sw: number; sh: number }; samples: Array<[number, number, number]> } | null;
    getRemoteBrowserVrKeyboardTargetWorldPosition: (targetId: string) => { x: number; y: number; z: number } | null;
    getRemoteBrowserVrKeyboardKeyWorldPosition: (keyId: string) => { x: number; y: number; z: number } | null;
    teleportToFloor: (x: number, z: number) => boolean;
    forceXrInteractionAtSeat: (seatId: string) => boolean;
    setSyntheticXrState: (state: {
      rightController: { x: number; y: number; z: number };
      rightGrip?: { x: number; y: number; z: number } | null;
      rayDirection: { x: number; y: number; z: number };
      axes?: { moveX?: number; moveY?: number; turnX?: number; turnY?: number };
      triggerPressed?: boolean;
      rayVisible?: boolean;
    } | null) => boolean;
  };
}).__VRATA_TEST__ = {
  forceRoomStateReconnect: () => {
    roomStateClient?.close();
  },
  aimInteractionAtSeat: (seatId: string) => {
    const seatAnchor = sceneSeatAnchorMap.get(seatId);
    if (!seatAnchor) {
      return false;
    }
    forcedTestInteractionSeatId = null;
    return forceInteractionRayAtWorldPoint(new THREE.Vector3(
      seatAnchor.position.x,
      seatAnchor.position.y + seatAnchor.seatHeight,
      seatAnchor.position.z
    ));
  },
  aimInteractionAtFloor: (x: number, z: number) => {
    forcedTestInteractionSeatId = null;
    return forceInteractionRayAtWorldPoint(new THREE.Vector3(x, sceneTeleportFloorY, z));
  },
  confirmInteraction: () => {
    confirmLatestInteractionTarget();
  },
  claimSeatById: (seatId: string) => {
    const seatAnchor = sceneSeatAnchorMap.get(seatId);
    if (!seatAnchor) {
      return false;
    }
    roomSeatOccupancy = removeParticipantFromSeatOccupancy(roomSeatOccupancy, participantId);
    forcedTestSeatId = seatAnchor.id;
    seatingController.forceSeated(seatAnchor.id);
    syncSeatDebugState();
    syncSeatStateFromOccupancy();
    setStatus(`Seated at ${seatAnchor.label ?? seatAnchor.id}`);
    return true;
  },
  requestSeatClaimById: (seatId: string) => {
    const seatAnchor = sceneSeatAnchorMap.get(seatId);
    if (!seatAnchor || !roomStateClient || !roomStateConnected) {
      return false;
    }
    executeRuntimeCommandList([
      { type: "request_seat_claim", seatId: seatAnchor.id },
      { type: "send_seat_claim", seatId: seatAnchor.id },
      { type: "status", message: `Claiming seat ${seatAnchor.label ?? seatAnchor.id}` }
    ]);
    return true;
  },
  sendPrivilegedSurfaceCreate: () => {
    return mediaSurfaceCommands.sendCreateObject();
  },
  createSurfaceTestCard: () => {
    return mediaSurfaceCommands.sendCreateObject({
      commandId: mediaSurfaceCommands.createCommandId("create"),
      surfaceId: DEBUG_SURFACE_ID,
      objectType: SURFACE_TEST_CARD_TYPE,
      probeOnly: false
    });
  },
  createExtensionTestCard: (surfaceId = selectedMediaSurfaceId) => {
    return mediaSurfaceCommands.sendCreateObject({
      commandId: mediaSurfaceCommands.createCommandId("extension-test-card-create"),
      surfaceId,
      objectType: EXTENSION_TEST_CARD_TYPE,
      probeOnly: false
    });
  },
  createMissingCapabilityExtensionObject: (surfaceId = selectedMediaSurfaceId) => {
    return mediaSurfaceCommands.sendCreateObject({
      commandId: mediaSurfaceCommands.createCommandId("missing-capability-extension-create"),
      surfaceId,
      objectType: MISSING_CAPABILITY_EXTENSION_CARD_TYPE,
      probeOnly: false
    });
  },
  createDisabledExtensionObject: (surfaceId = selectedMediaSurfaceId) => {
    return mediaSurfaceCommands.sendCreateObject({
      commandId: mediaSurfaceCommands.createCommandId("disabled-extension-create"),
      surfaceId,
      objectType: DISABLED_EXTENSION_CARD_TYPE,
      probeOnly: false
    });
  },
  createScreenShareObject: (surfaceId = selectedMediaSurfaceId) => {
    return mediaSurfaceCommands.sendCreateObject({
      commandId: mediaSurfaceCommands.createCommandId("screen-share-create-test"),
      surfaceId,
      objectType: SCREEN_SHARE_OBJECT_TYPE,
      probeOnly: false
    });
  },
  createWhiteboardObject: (surfaceId = selectedMediaSurfaceId) => {
    return mediaSurfaceCommands.sendCreateObject({
      commandId: mediaSurfaceCommands.createCommandId("whiteboard-create-test"),
      surfaceId,
      objectType: WHITEBOARD_OBJECT_TYPE,
      probeOnly: false
    });
  },
  createRemoteBrowserObject: (surfaceId = selectedMediaSurfaceId) => {
    return mediaSurfaceCommands.sendCreateObject({
      commandId: mediaSurfaceCommands.createCommandId("remote-browser-create-test"),
      surfaceId,
      objectType: REMOTE_BROWSER_OBJECT_TYPE,
      probeOnly: false
    });
  },
  selectMediaSurface: (surfaceId) => selectMediaSurface(surfaceId),
  openRemoteBrowser: (url = "/remote-browser-demo.html") => {
    void openRemoteBrowser(url).catch((error: unknown) => {
      console.error(error);
    });
    return true;
  },
  takeRemoteBrowserControl: () => {
    const object = activeRemoteBrowserObjectForSurface(selectedMediaSurfaceId) ?? findActiveRemoteBrowserObject();
    if (!object) {
      return false;
    }
    return mediaSurfaceCommands.sendPatchObjectState("remote-browser-take-control-test", {
      surfaceId: object.surfaceId,
      objectId: object.objectId,
      expectedRevision: object.revision,
      patch: getRemoteBrowserRuntime(object.surfaceId).createTakeControlPatch()
    });
  },
  releaseRemoteBrowserControl: () => {
    const object = activeRemoteBrowserObjectForSurface(selectedMediaSurfaceId) ?? findActiveRemoteBrowserObject();
    if (!object) {
      return false;
    }
    return mediaSurfaceCommands.sendPatchObjectState("remote-browser-release-control-test", {
      surfaceId: object.surfaceId,
      objectId: object.objectId,
      expectedRevision: object.revision,
      patch: getRemoteBrowserRuntime(object.surfaceId).createReleaseControlPatch()
    });
  },
  createUnknownSurfaceObject: () => {
    return mediaSurfaceCommands.sendCreateObject({
      commandId: mediaSurfaceCommands.createCommandId("unknown"),
      surfaceId: DEBUG_SURFACE_ID,
      objectType: "unknown-object",
      probeOnly: false
    });
  },
  stopActiveSurfaceObject: (surfaceId = selectedMediaSurfaceId) => {
    const object = activeMediaObjectForSurface(surfaceId);
    if (!object) {
      return false;
    }
    return mediaSurfaceCommands.sendStopObject({
      commandId: mediaSurfaceCommands.createCommandId("stop"),
      surfaceId,
      objectId: object.objectId
    });
  },
  sendStaleSurfaceTestCardPatch: () => {
    const object = activeMediaObjectForSurface(selectedMediaSurfaceId);
    if (!object) {
      return false;
    }
    return mediaSurfaceCommands.sendPatchObjectState("stale-patch", {
      surfaceId: selectedMediaSurfaceId,
      objectId: object.objectId,
      expectedRevision: object.revision + 1,
      patch: {
        type: "increment-click-count",
        inputEventId: `${participantId}:stale:${Date.now()}`
      }
    });
  },
  sendStaleScreenSharePatch: () => {
    const object = activeScreenShareObjectForSurface(selectedMediaSurfaceId) ?? findActiveScreenShareObject();
    if (!object) {
      return false;
    }
    return mediaSurfaceCommands.sendPatchObjectState("stale-screen-share-patch", {
      surfaceId: object.surfaceId,
      objectId: object.objectId,
      expectedRevision: object.revision + 1,
      patch: {
        type: "mark-active",
        mediaTrackSid: `stale:${participantId}:${Date.now()}`
      }
    });
  },
  sendStaleWhiteboardPatch: () => {
    const object = activeWhiteboardObjectForSurface(selectedMediaSurfaceId);
    if (!object) {
      return false;
    }
    return mediaSurfaceCommands.sendPatchObjectState("stale-whiteboard-patch", {
      surfaceId: object.surfaceId,
      objectId: object.objectId,
      expectedRevision: object.revision + 1,
      patch: {
        type: "append-stroke",
        inputEventId: `${participantId}:stale-whiteboard:${Date.now()}`,
        stroke: {
          strokeId: `${participantId}:stale-stroke`,
          participantId,
          tool: "pen",
          color: "#111827",
          width: 2,
          points: [{ u: 0.25, v: 0.25, t: Date.now() }]
        }
      }
    });
  },
  sendDuplicateWhiteboardPatch: () => {
    const object = activeWhiteboardObjectForSurface(selectedMediaSurfaceId);
    if (!object || !object.state.lastInputEventId) {
      return false;
    }
    return mediaSurfaceCommands.sendPatchObjectState("duplicate-whiteboard-patch", {
      surfaceId: object.surfaceId,
      objectId: object.objectId,
      expectedRevision: object.revision,
      patch: {
        type: "append-stroke",
        inputEventId: object.state.lastInputEventId,
        stroke: {
          strokeId: `${participantId}:duplicate-stroke`,
          participantId,
          tool: "pen",
          color: "#111827",
          width: 2,
          points: [{ u: 0.35, v: 0.35, t: Date.now() }]
        }
      }
    });
  },
  clearWhiteboardObject: () => {
    const object = activeWhiteboardObjectForSurface(selectedMediaSurfaceId);
    if (!object) {
      return false;
    }
    return mediaSurfaceCommands.sendPatchObjectState("whiteboard-clear-test", {
      surfaceId: object.surfaceId,
      objectId: object.objectId,
      expectedRevision: object.revision,
      patch: getWhiteboardRuntime(object.surfaceId).createClearPatch()
    });
  },
  setDebugSurfaceMediaAudioEnabled: (enabled, surfaceId = selectedMediaSurfaceId) => {
    return mediaSurfaceCommands.sendMediaAudio({
      commandId: mediaSurfaceCommands.createCommandId("surface-audio-test"),
      surfaceId,
      enabled
    });
  },
  startScreenShare: () => {
    void startScreenShare().catch((error: unknown) => {
      console.error(error);
    });
    return true;
  },
  sendDebugSurfaceInput: (input = {}) => {
    const source = input.source ?? "mouse";
    const surfaceId = input.surfaceId ?? selectedMediaSurfaceId;
    const surface = getMediaSurfaceView(surfaceId);
    const hit = createSyntheticSurfaceHit({
      surfaceId,
      objectId: activeMediaObjectIdForSurface(surfaceId),
      source,
      uv: { u: input.u ?? 0.5, v: input.v ?? 0.5 },
      widthPx: surface.widthPx,
      heightPx: surface.heightPx,
      inputEnabled: debugState.surfaceInput.enabled
    });
    return commitDebugSurfaceInput({
      hit,
      source,
      kind: input.kind ?? "click",
      key: input.key,
      text: input.text,
      scrollDelta: input.scrollDelta,
      clientTimeMs: Date.now()
    });
  },
  setDebugSurfaceInputEnabled: (enabled) => {
    debugState.surfaceInput.enabled = enabled;
    return true;
  },
  focusDebugSurface: (surfaceId = selectedMediaSurfaceId) => {
    const surface = getMediaSurfaceView(surfaceId);
    const hit = createSyntheticSurfaceHit({
      surfaceId,
      objectId: activeMediaObjectIdForSurface(surfaceId),
      source: "mouse",
      uv: { u: 0.5, v: 0.5 },
      widthPx: surface.widthPx,
      heightPx: surface.heightPx,
      inputEnabled: debugState.surfaceInput.enabled && surface.object.visible
    });
    recordSurfaceInputHit(debugState.surfaceInput, hit);
    return tryFocusSurface({ state: debugState.surfaceInput, permissions: debugState.access.permissions, hit }) === null;
  },
  getDebugSurfaceWorldPosition: (u, v) => {
    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      return null;
    }
    displaySurface.updateMatrixWorld(true);
    const position = displaySurface.localToWorld(new THREE.Vector3(
      (Math.max(0, Math.min(1, u)) - 0.5) * DEBUG_SURFACE_WIDTH_M,
      (Math.max(0, Math.min(1, v)) - 0.5) * DEBUG_SURFACE_HEIGHT_M,
      0
    ));
    return {
      x: position.x,
      y: position.y,
      z: position.z
    };
  },
  getDebugSurfaceClientPosition: (u, v) => {
    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      return null;
    }
    displaySurface.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    const ndc = displaySurface.localToWorld(new THREE.Vector3(
      (Math.max(0, Math.min(1, u)) - 0.5) * DEBUG_SURFACE_WIDTH_M,
      (Math.max(0, Math.min(1, v)) - 0.5) * DEBUG_SURFACE_HEIGHT_M,
      0
    )).project(camera);
    return {
      x: (ndc.x + 1) * 0.5 * window.innerWidth,
      y: (1 - ndc.y) * 0.5 * window.innerHeight
    };
  },
  getMediaSurfaceWorldPosition: (surfaceId, u, v) => {
    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      return null;
    }
    const surface = getMediaSurfaceView(surfaceId);
    surface.object.updateMatrixWorld(true);
    const position = surface.object.localToWorld(new THREE.Vector3(
      (Math.max(0, Math.min(1, u)) - 0.5) * surface.widthM,
      (Math.max(0, Math.min(1, v)) - 0.5) * surface.heightM,
      0
    ));
    return {
      x: position.x,
      y: position.y,
      z: position.z
    };
  },
  getMediaSurfaceClientPosition: (surfaceId, u, v) => {
    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      return null;
    }
    const surface = getMediaSurfaceView(surfaceId);
    surface.object.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    const ndc = surface.object.localToWorld(new THREE.Vector3(
      (Math.max(0, Math.min(1, u)) - 0.5) * surface.widthM,
      (Math.max(0, Math.min(1, v)) - 0.5) * surface.heightM,
      0
    )).project(camera);
    return {
      x: (ndc.x + 1) * 0.5 * window.innerWidth,
      y: (1 - ndc.y) * 0.5 * window.innerHeight
    };
  },
  sampleDebugSurfaceTexture: (center, size = { width: 0.18, height: 0.18 }) => {
    return sampleMediaSurfaceTexture(DEBUG_SURFACE_ID, center, size);
  },
  sampleMediaSurfaceTexture: (surfaceId, center, size = { width: 0.18, height: 0.18 }) => {
    return sampleMediaSurfaceTexture(surfaceId, center, size);
  },
  getRemoteBrowserVrKeyboardTargetWorldPosition: (targetId) => {
    const mesh = targetId === "toggle" ? remoteBrowserVrKeyboardView.toggleMesh : remoteBrowserVrKeyboardView.meshById.get(targetId);
    if (!mesh) {
      return null;
    }
    displaySurface.updateMatrixWorld(true);
    mesh.updateMatrixWorld(true);
    const position = mesh.getWorldPosition(new THREE.Vector3());
    return {
      x: position.x,
      y: position.y,
      z: position.z
    };
  },
  getRemoteBrowserVrKeyboardKeyWorldPosition: (keyId) => {
    return (window as Window & {
      __VRATA_TEST__?: { getRemoteBrowserVrKeyboardTargetWorldPosition: (targetId: string) => { x: number; y: number; z: number } | null };
    }).__VRATA_TEST__?.getRemoteBrowserVrKeyboardTargetWorldPosition(keyId) ?? null;
  },
  forceXrInteractionAtSeat: (seatId: string) => {
    const seatAnchor = sceneSeatAnchorMap.get(seatId);
    if (!seatAnchor) {
      return false;
    }
    forcedTestInteractionSeatId = seatAnchor.id;
    return forceInteractionRayAtWorldPoint(new THREE.Vector3(
      seatAnchor.position.x,
      seatAnchor.position.y + seatAnchor.seatHeight,
      seatAnchor.position.z
    ));
  },
  setSyntheticXrState: (state) => {
    syntheticXrState = state ? {
      rightController: state.rightController,
      rightGrip: state.rightGrip ?? state.rightController,
      rayDirection: state.rayDirection,
      axes: {
        moveX: state.axes?.moveX ?? 0,
        moveY: state.axes?.moveY ?? 0,
        turnX: state.axes?.turnX ?? 0,
        turnY: state.axes?.turnY ?? 0
      },
      triggerPressed: state.triggerPressed ?? false,
      rayVisible: state.rayVisible ?? false
    } : null;
    return true;
  },
  teleportToFloor: (x: number, z: number) => {
    forcedTestSeatId = null;
    interactionTargetPerformer.performTarget(
      { kind: "floor", point: new THREE.Vector3(x, sceneTeleportFloorY, z) },
      { debounceMs: 0 }
    );
    return true;
  }
};
(window as Window & { __NOAH_TEST__?: unknown }).__NOAH_TEST__ = (window as Window & { __VRATA_TEST__?: unknown }).__VRATA_TEST__;

function setStatus(message: string): void {
  statusLineEl.textContent = message;
  debugState.statusLine = message;
}

function createClientReportId(): string {
  return `rpt_${crypto.randomUUID()}`;
}

function showReportId(reportId: string | null): void {
  debugState.lastReportId = reportId;
  reportLineEl.hidden = !reportId;
  reportLineEl.textContent = reportId ? `Report ID: ${reportId}` : "";
}

function setReportRequestId(requestId: string | null): void {
  debugState.lastReportRequestId = requestId;
}

function setRoomStateStatus(message: string): void {
  roomStateLineEl.textContent = message;
}

function renderSpaceSelector(state: "loading" | "ready" | "empty" | "unavailable", spaces: RuntimeSpaceOption[], selectedRoomId: string): void {
  spaceSelect.replaceChildren();
  debugState.spaceSelectorState = state;
  debugState.availableSpaceCount = spaces.length;

  if (state === "loading") {
    const option = document.createElement("option");
    option.value = selectedRoomId;
    option.textContent = "Loading spaces...";
    spaceSelect.appendChild(option);
    spaceSelect.disabled = true;
    spaceSelectStatusEl.textContent = "Loading spaces...";
    return;
  }

  if (state === "unavailable") {
    const option = document.createElement("option");
    option.value = selectedRoomId;
    option.textContent = "Spaces unavailable";
    spaceSelect.appendChild(option);
    spaceSelect.disabled = true;
    spaceSelectStatusEl.textContent = "Spaces unavailable";
    return;
  }

  if (state === "empty") {
    const option = document.createElement("option");
    option.value = selectedRoomId;
    option.textContent = "No spaces available";
    spaceSelect.appendChild(option);
    spaceSelect.disabled = true;
    spaceSelectStatusEl.textContent = "No spaces available";
    return;
  }

  for (const space of spaces) {
    const option = document.createElement("option");
    option.value = space.roomLink;
    option.textContent = space.label;
    option.selected = space.roomId === selectedRoomId;
    spaceSelect.appendChild(option);
  }
  spaceSelect.disabled = spaces.length <= 1;
  spaceSelectStatusEl.textContent = spaces.length <= 1 ? "Only one space available" : "";
}

async function loadAvailableSpaces(currentRoomId: string): Promise<void> {
  renderSpaceSelector("loading", [], currentRoomId);
  try {
    const search = failSpaces ? "?fail=1" : "";
    const spaces = await fetchRuntimeSpaces(apiBaseUrl, currentRoomId, search);
    availableSpaces = spaces;
    const currentSpace = resolveCurrentSpace(spaces, currentRoomId);
    if (!currentSpace && spaces.length > 0) {
      renderSpaceSelector("ready", spaces, spaces[0].roomId);
      spaceSelectStatusEl.textContent = "Current space not listed";
      return;
    }
    renderSpaceSelector(spaces.length === 0 ? "empty" : "ready", spaces, currentRoomId);
  } catch (_error: unknown) {
    availableSpaces = [];
    renderSpaceSelector("unavailable", [], currentRoomId);
  }
}

function commitRuntimeUiState(nextState: ReturnType<typeof createRuntimeUiState>, updateStatus = true): void {
  runtimeUiState = nextState;
  if (updateStatus) {
    setStatus(nextState.statusLine);
  } else {
    debugState.statusLine = nextState.statusLine;
  }
  debugState.audioState = nextState.audioState;
  debugState.roomStateMode = nextState.roomStateMode;
  debugState.issueCode = nextState.issueCode;
  debugState.issueSeverity = nextState.issueSeverity;
  debugState.degradedMode = nextState.degradedMode;
  debugState.retryCount = nextState.retryCount;
  debugState.lastRecoveryAction = nextState.lastRecoveryAction;
}

function applyIssue(issue: RuntimeIssue, input: {
  degradedMode: string;
  lastRecoveryAction: string;
  audioState?: string;
  roomStateMode?: string;
  incrementRetry?: boolean;
  roomStateLabel?: string;
  updateStatus?: boolean;
}): void {
  if (input.roomStateLabel) {
    setRoomStateStatus(input.roomStateLabel);
  }
  commitRuntimeUiState(applyRuntimeIssueState(runtimeUiState, {
    statusLine: issue.userMessage,
    issueCode: issue.code,
    issueSeverity: issue.severity,
    degradedMode: input.degradedMode,
    audioState: input.audioState,
    roomStateMode: input.roomStateMode,
    lastRecoveryAction: input.lastRecoveryAction,
    incrementRetry: input.incrementRetry
  }), input.updateStatus ?? true);
}

function clearIssue(statusLine: string): void {
  commitRuntimeUiState(clearRuntimeIssueState(runtimeUiState, statusLine));
}

function clearAudioIssue(statusLine: string): void {
  if (runtimeUiState.issueCode === "mic_denied" || runtimeUiState.issueCode === "no_audio_device" || runtimeUiState.issueCode === "audio_unsupported" || runtimeUiState.issueCode === "livekit_failed" || runtimeUiState.issueCode === "media_network_blocked") {
    clearIssue(statusLine);
  } else {
    setStatus(statusLine);
  }
}

function clearRoomStateReconnect(): void {
  if (roomStateReconnectTimer !== null) {
    window.clearTimeout(roomStateReconnectTimer);
    roomStateReconnectTimer = null;
  }
}

function clearSeatReclaimRetry(): void {
  if (seatReclaimRetryTimer !== null) {
    window.clearTimeout(seatReclaimRetryTimer);
    seatReclaimRetryTimer = null;
  }
}

function connectRoomStateWithRetry(roomStateUrl: string): void {
  clearRoomStateReconnect();
  clearSeatReclaimRetry();
  debugState.roomStateMode = "disconnected";
  setRoomStateStatus("Room-state: connecting");

  if (!runtimeFlags.roomStateRealtime || faultConfig.roomState) {
    const issue = getRuntimeIssue("room_state_failed");
    roomStateConnected = false;
    debugState.roomStateConnected = false;
    applyIssue(issue, {
      degradedMode: "api_fallback",
      roomStateMode: "api_fallback",
      lastRecoveryAction: "fallback_api",
      roomStateLabel: "Room-state: fallback API"
    });
    void reportDiagnostics(issue.diagnosticsNote);
    return;
  }

  roomStateClient = connectRoomState(roomStateUrl, roomId, participantId, {
    onOpen: () => {
      const reopened = debugState.avatarPoseTransport.lastPoseSentAtMs > 0;
      roomStateConnected = true;
      debugState.roomStateConnected = true;
      debugState.roomStateMode = "colyseus";
      startShareButton.disabled = !canUseScreenShareControl();
      stopShareButton.disabled = !canStopLocalScreenShare();
      setRoomStateStatus("Room-state: connected");
      if (runtimeUiState.issueCode === "room_state_failed") {
        clearIssue(debugState.audioState === "connected-passive" ? `Joined as ${displayName}` : debugState.statusLine);
      }
      void reportDiagnostics("room_state_connected");
      if (reopened) {
        debugState.avatarPoseTransport.reconnectRepublishCount += 1;
      }
      const activeClient = roomStateClient;
      const seatReclaim = planSeatReclaimOnReconnect({
        currentSeatId: getCurrentSeatId(),
        seatingEnabled: runtimeFlags.avatarSeatingEnabled,
        roomStateClientAvailable: Boolean(activeClient)
      });
      const reclaimSeatId = seatReclaim.seatId;
      if (seatReclaim.commands.length > 0 && reclaimSeatId && seatReclaim.retryDelayMs !== null) {
        executeRuntimeCommandList(seatReclaim.commands);
        clearSeatReclaimRetry();
        seatReclaimRetryTimer = window.setTimeout(() => {
          if (!shouldRetrySeatReclaim({
            seatId: reclaimSeatId,
            roomStateConnected,
            sameRoomStateClient: roomStateClient === activeClient,
            currentSeatId: getCurrentSeatId(),
            pendingSeatId: getPendingSeatId()
          })) {
            return;
          }
          executeRuntimeCommandList([{ type: "send_seat_claim", seatId: reclaimSeatId }]);
        }, seatReclaim.retryDelayMs);
      }
      void syncPresence(latestMode, Boolean(livekitRoom && microphoneEnabled));
    },
    onRoomState: (snapshot: RoomStateSnapshot) => {
      roomStateConnected = true;
      debugState.roomStateConnected = true;
      debugState.roomStateMode = "colyseus";
      handleRoomSnapshot(snapshot);
    },
    onAvatarReliableState: (state) => {
      remoteAvatarRuntime.ingestReliableState({
        participantId: state.participantId,
        avatarId: state.avatarId,
        inputMode: state.inputMode,
        updatedAt: state.updatedAt,
        audioActive: state.audioActive,
        seated: state.seated,
        seatId: state.seatId
      }, debugState);
    },
    onAvatarPoseFrame: (remoteParticipantId, frame) => {
      remoteAvatarRuntime.ingestPoseFrame(remoteParticipantId, frame, debugState);
    },
    onSeatClaimResult: (result) => {
      if (result.accepted) {
        roomSeatOccupancy = applyAcceptedSeatClaimToOccupancy(roomSeatOccupancy, { result, participantId });
        clearSeatReclaimRetry();
        syncSeatStateFromOccupancy();
        setStatus(`Seated at ${result.seatId}`);
        return;
      }
      seatingController.clearPending();
      clearSeatReclaimRetry();
      syncSeatDebugState();
      setStatus(result.occupantId ? `Seat occupied by ${result.occupantId}` : "Seat unavailable");
    },
    onAccessDenied: (result) => {
      debugState.access.lastDeniedPermission = result.permission;
      debugState.access.lastSurfaceCommandAccepted = false;
      debugState.mediaObjects.lastCommand = result as SurfaceCommandResult;
      debugState.mediaObjects.blockedReason = (result as SurfaceCommandResult).blockedReason ?? null;
      mediaSurfaceCommands.settle(result as SurfaceCommandResult);
      if (!debugState.issueCode) {
        setStatus(`Access denied: ${result.permission}`);
      }
    },
    onSurfaceCommandResult: (result) => {
      debugState.access.lastDeniedPermission = null;
      debugState.access.lastSurfaceCommandAccepted = result.accepted;
      debugState.mediaObjects.lastCommand = result;
      debugState.mediaObjects.blockedReason = result.blockedReason ?? null;
      mediaSurfaceCommands.settle(result);
    },
    onError: (error: unknown) => {
      console.error(error);
      const issue = classifyRoomStateError(error);
      roomStateConnected = false;
      debugState.roomStateConnected = false;
      mediaSurfaceCommands.rejectAll("room_state_error");
      clearSeatReclaimRetry();
      applyIssue(issue, {
        degradedMode: "api_fallback",
        roomStateMode: "api_fallback",
        lastRecoveryAction: "fallback_api",
        roomStateLabel: "Room-state: fallback API"
      });
      void reportDiagnostics(issue.diagnosticsNote);
    },
    onClose: () => {
      const issue = getRuntimeIssue("room_state_failed");
      roomStateConnected = false;
      debugState.roomStateConnected = false;
      mediaSurfaceCommands.rejectAll("room_state_closed");
      applyIssue(issue, {
        degradedMode: "api_fallback",
        roomStateMode: "disconnected",
        lastRecoveryAction: "retry_room_state",
        incrementRetry: true,
        roomStateLabel: "Room-state: reconnecting"
      });
      void reportDiagnostics("room_state_disconnected");
      clearRoomStateReconnect();
      if (shouldRetryConnection(issue.code) && canRetry(debugState.retryCount, roomStateReconnectPolicy)) {
        const delayMs = getReconnectDelayMs(debugState.retryCount, roomStateReconnectPolicy);
        roomStateReconnectTimer = window.setTimeout(() => {
          connectRoomStateWithRetry(roomStateUrl);
        }, delayMs);
        return;
      }
      applyIssue(issue, {
        degradedMode: "api_fallback",
        roomStateMode: "api_fallback",
        lastRecoveryAction: "room_state_retry_exhausted",
        roomStateLabel: "Room-state: fallback API"
      });
    }
  }, roomStateAccessToken);
}

function renderDebugPanel(): void {
  if (!debugEnabled) {
    return;
  }

  debugPanel.textContent = JSON.stringify(debugState, null, 2);
  const xrAvatarDebug = debugState.xrAvatarDebug;
  const ray = debugState.interactionRay;
  const axes = debugState.xrAxes;
  xrDebugPanelEl.textContent = [
    `XR profile: ${xrAvatarDebug?.profile ?? "none"}`,
    `XR axes: turn=(${axes.turnX?.toFixed?.(2) ?? axes.turnX ?? 0}, ${axes.turnY?.toFixed?.(2) ?? axes.turnY ?? 0}) move=(${axes.moveX?.toFixed?.(2) ?? axes.moveX ?? 0}, ${axes.moveY?.toFixed?.(2) ?? axes.moveY ?? 0})`,
    `Ray active: ${ray.active} mode=${ray.mode} target=${ray.targetKind} seat=${ray.seatId ?? "-"}`,
    `Ray source: ${ray.source ? `${ray.source.handedness ?? "?"}#${ray.source.index}` : "-"}`,
    `Ray origin: ${ray.origin ? `${ray.origin.x}, ${ray.origin.y}, ${ray.origin.z}` : "-"}`,
    `Ray direction: ${ray.direction ? `${ray.direction.x}, ${ray.direction.y}, ${ray.direction.z}` : "-"}`,
    `Right grip: ${xrAvatarDebug?.rightGrip ? `${xrAvatarDebug.rightGrip.x}, ${xrAvatarDebug.rightGrip.y}, ${xrAvatarDebug.rightGrip.z}` : "-"}`,
    `Right controller: ${xrAvatarDebug?.rightController ? `${xrAvatarDebug.rightController.x}, ${xrAvatarDebug.rightController.y}, ${xrAvatarDebug.rightController.z}` : "-"}`,
    `Right resolved: ${xrAvatarDebug?.rightResolved ? `${xrAvatarDebug.rightResolved.x}, ${xrAvatarDebug.rightResolved.y}, ${xrAvatarDebug.rightResolved.z}` : "-"}`,
    `Right hand world: ${xrAvatarDebug?.rightHandWorld ? `${xrAvatarDebug.rightHandWorld.x}, ${xrAvatarDebug.rightHandWorld.y}, ${xrAvatarDebug.rightHandWorld.z}` : "-"}`,
    `Status: ${debugState.statusLine ?? "-"}`
  ].join("\n");
}

function markXrTelemetry(kind: string): void {
  if (!lastXrTelemetryKinds.includes(kind)) {
    lastXrTelemetryKinds.push(kind);
  }
  lastXrTelemetryReportAt = 0;
}

function deriveBodyTransform(root: { x: number; z: number }, head: { x: number; z: number }): { x: number; z: number } {
  const deltaX = head.x - root.x;
  const deltaZ = head.z - root.z;
  const distance = Math.hypot(deltaX, deltaZ);
  const maxOffset = 0.35;

  if (distance <= maxOffset || distance === 0) {
    return {
      x: root.x + deltaX * 0.35,
      z: root.z + deltaZ * 0.35
    };
  }

  const scale = maxOffset / distance;
  return {
    x: root.x + deltaX * scale,
    z: root.z + deltaZ * scale
  };
}

async function reportDiagnostics(note?: string, options: { reportId?: string } = {}): Promise<void> {
  if (!runtimeFlags.remoteDiagnostics) {
    return;
  }
  await refreshWebRtcDiagnostics();
  if (activeSceneBundleRoot) {
    debugState.sceneDebug = inspectSceneObject({
      root: activeSceneBundleRoot,
      camera,
      previous: debugState.sceneDebug
    });
  }
  const includeImage = false;
  const screenshot = captureCanvasDiagnostics({
    canvas: renderer.domElement,
    includeImage
  });
  debugState.sceneDebug.screenshot = screenshot;
  const response = await fetch(new URL(`/api/rooms/${roomId}/diagnostics`, apiBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${roomStateAccessToken}`
    },
    body: JSON.stringify({
      reportId: options.reportId,
      participantId,
      displayName,
      mode: debugState.mode,
      userAgent: navigator.userAgent,
      statusLine: debugState.statusLine,
      locomotionMode: debugState.locomotionMode,
      roomStateConnected: debugState.roomStateConnected,
      roomStateUrl: debugState.roomStateUrl,
      roomStateMode: debugState.roomStateMode,
      audioState: debugState.audioState,
      localMicLevel: debugState.localMicLevel,
      speakerOutputLevel: debugState.speakerOutputLevel,
      media: debugState.media,
      access: debugState.access,
      surfaceInput: debugState.surfaceInput,
      screenShareState: debugState.screenShareState,
      mediaCapabilities: debugState.mediaCapabilities,
      localPose: debugState.localPose,
      localPosition: debugState.localPosition,
      spatialAudioState: debugState.spatialAudioState,
      spatialAudio: debugState.spatialAudio,
      xrAxes: debugState.xrAxes,
      remoteAvatarCount: debugState.remoteAvatarCount,
      remoteTargets: debugState.remoteTargets,
      remoteParticipants: debugState.remoteParticipants,
      remoteAvatarReliableStates: debugState.remoteAvatarReliableStates,
      remoteAvatarPoseFrames: debugState.remoteAvatarPoseFrames,
      remoteAvatarParticipants: debugState.remoteAvatarParticipants,
      issueCode: debugState.issueCode,
      issueSeverity: debugState.issueSeverity,
      degradedMode: debugState.degradedMode,
      retryCount: debugState.retryCount,
      lastRecoveryAction: debugState.lastRecoveryAction,
      lastPresenceSyncAt: debugState.lastPresenceSyncAt,
      lastPresenceRefreshAt: debugState.lastPresenceRefreshAt,
      featureFlags: debugState.featureFlags,
      faultInjection: debugState.faultInjection,
      avatarDebug: debugState.avatarDebug,
      avatarSnapshot: debugState.avatarSnapshot,
      avatarTransportPreview: debugState.avatarTransportPreview,
      avatarPoseTransport: debugState.avatarPoseTransport,
      xrAvatarDebug: debugState.xrAvatarDebug,
      sceneDebug: {
        ...debugState.sceneDebug,
        missingAssetCount: debugState.sceneDebug.missingAssets.length,
        screenshot
      },
      note,
      createdAt: new Date().toISOString()
    })
  });
  const responseRequestId = response.headers.get("x-request-id");
  if (responseRequestId) {
    setReportRequestId(responseRequestId);
  }
  if (response.ok) {
    const payload = await response.json().catch(() => null) as { reportId?: string; requestId?: string } | null;
    if (payload?.requestId) {
      setReportRequestId(payload.requestId);
    }
    if (payload?.reportId) {
      showReportId(payload.reportId);
    }
  }
}

function reportUnhandledRuntimeError(error: unknown, note: string): void {
  const reportId = createClientReportId();
  const message = error instanceof Error ? error.message : String(error ?? "unknown");
  showReportId(reportId);
  setStatus(`Runtime error. Report ID: ${reportId}`);
  debugState.issueCode = "runtime_unhandled_error";
  debugState.issueSeverity = "error";
  debugState.lastRecoveryAction = "report_runtime_error";
  void reportDiagnostics(`${note}:${message.slice(0, 160)}`, { reportId }).catch(() => undefined);
}

window.addEventListener("error", (event) => {
  reportUnhandledRuntimeError(event.error ?? event.message, "runtime_error");
});

window.addEventListener("unhandledrejection", (event) => {
  reportUnhandledRuntimeError(event.reason, "runtime_unhandled_rejection");
});

function reportXrTelemetry(frameContext: RuntimeFrameContext): void {
  if (!renderer.xr.isPresenting && !(avatarVrMockEnabled && syntheticXrState)) {
    return;
  }
  const now = performance.now();
  const inputSources = frameContext.xr?.inputSources ?? [];
  const xrRawInputs = syntheticXrState
    ? [{
        index: 0,
        handedness: "right",
        targetRayMode: "tracked-pointer",
        profiles: ["synthetic-right"],
        button0Pressed: syntheticXrState.triggerPressed,
        button1Pressed: false,
        axes: [
          syntheticXrState.axes.turnX,
          syntheticXrState.axes.turnY,
          syntheticXrState.axes.turnX,
          syntheticXrState.axes.turnY
        ]
      }]
    : inputSources.map((source, index) => ({
        index,
        handedness: source.handedness ?? null,
        targetRayMode: source.targetRayMode ?? null,
        profiles: Array.isArray(source.profiles) ? [...source.profiles] : [],
        button0Pressed: Boolean(source.gamepad?.buttons?.[0]?.pressed),
        button1Pressed: Boolean(source.gamepad?.buttons?.[1]?.pressed),
        axes: Array.isArray(source.gamepad?.axes) ? source.gamepad.axes.map((value) => Number(value.toFixed(3))) : []
      }));
  const rawInputActive = xrRawInputs.some((input) => input.button0Pressed || input.button1Pressed || input.axes.some((value) => Math.abs(value) > 0.01));
  const rayActive = Boolean(debugState.interactionRay.active);
  const reportIntervalMs = rawInputActive || rayActive ? 16 : 300;
  if (now - lastXrTelemetryReportAt < reportIntervalMs) {
    return;
  }
  lastXrTelemetryReportAt = now;
  const rightInputSource = inputSources.find((source) => source.handedness === "right")
    ?? inputSources[0]
    ?? null;
  const rightAxes = syntheticXrState
    ? [syntheticXrState.axes.turnX, syntheticXrState.axes.turnY, syntheticXrState.axes.turnX, syntheticXrState.axes.turnY]
    : rightInputSource?.gamepad?.axes ?? [];
  const payload = {
    participantId,
    roomId,
    updatedAt: new Date().toISOString(),
    kind: lastXrTelemetryKinds.at(-1) ?? null,
    kinds: [...lastXrTelemetryKinds],
    statusLine: debugState.statusLine ?? null,
    currentSeatId: debugState.currentSeatId ?? null,
    xrAxes: debugState.xrAxes,
    interactionRay: debugState.interactionRay,
    xrAvatarDebug: debugState.xrAvatarDebug ? {
      profile: debugState.xrAvatarDebug.profile ?? null,
      rightGrip: debugState.xrAvatarDebug.rightGrip ?? null,
      rightController: debugState.xrAvatarDebug.rightController ?? null,
      rightResolved: debugState.xrAvatarDebug.rightResolved ?? null,
      rightHandWorld: debugState.xrAvatarDebug.rightHandWorld ?? null,
      rightControllerWorld: debugState.xrAvatarDebug.rightControllerWorld ?? null
    } : null,
    xrRawInputs,
    xrTurnCandidates: {
      rightPrimaryX: typeof rightAxes[0] === "number" ? Number(rightAxes[0].toFixed(3)) : 0,
      rightPrimaryY: typeof rightAxes[1] === "number" ? Number(rightAxes[1].toFixed(3)) : 0,
      rightSecondaryX: typeof rightAxes[2] === "number" ? Number(rightAxes[2].toFixed(3)) : 0,
      rightSecondaryY: typeof rightAxes[3] === "number" ? Number(rightAxes[3].toFixed(3)) : 0,
      mappedTurnX: typeof debugState.xrAxes.turnX === "number" ? Number(debugState.xrAxes.turnX.toFixed(3)) : 0,
      mappedTurnY: typeof debugState.xrAxes.turnY === "number" ? Number(debugState.xrAxes.turnY.toFixed(3)) : 0,
      snapTurnFired: lastXrTelemetryKinds.includes("snap_turn"),
      playerYaw: Number(localPoseController.getYaw().toFixed(3)),
      selectEventCount: xrSelectEventCount
    }
  };
  void fetch(new URL(`/api/rooms/${roomId}/xr-telemetry/${participantId}`, apiBaseUrl), {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${roomStateAccessToken}`
    },
    body: JSON.stringify(payload)
  }).catch(() => undefined);
  lastXrTelemetryKinds = [];
}

function attachVideoTrack(track: Track, options: {
  remote: boolean;
  surfaceId?: string;
  objectId?: string;
  ownerParticipantId?: string | null;
  mediaTrackSid?: string | null;
} = { remote: true }): void {
  const surfaceId = options.surfaceId ?? selectedMediaSurfaceId;
  const mediaTrackSid = options.mediaTrackSid ?? getTrackNodeId(track, `${surfaceId}:screen-share-video`);
  const objectId = options.objectId ?? `screen-share-track:${mediaTrackSid}`;
  const existing = screenShareRuntimeByObjectId.get(objectId);
  if (existing?.track === track && existing.element) {
    moveScreenShareEntryToSurface(existing, surfaceId);
    return;
  }
  if (existing) {
    detachScreenShareEntry(existing);
  }

  const element = track.attach() as HTMLVideoElement;
  prepareHiddenVideoElement(element, { muted: true });
  document.body.appendChild(element);
  startHiddenVideoPlayback(element);

  const texture = createScreenShareVideoTexture(element);
  applySurfaceTexture(surfaceId, texture);

  registerScreenShareEntry({
    objectId,
    surfaceId,
    ownerParticipantId: options.ownerParticipantId ?? null,
    mediaTrackSid,
    remote: options.remote,
    track,
    element,
    texture,
    stream: null,
    publishedTracks: [],
    stopping: false
  });
  debugState.screenShare.remoteSubscribedTrackCount = remoteScreenShareTrackCount();
  debugState.screenShareState = options.remote ? "receiving" : debugState.screenShareState;
}

function attachRemoteBrowserVideoTrack(track: Track, object: MediaObjectInstance<RemoteBrowserObjectState>, publication: unknown): void {
  const trackSid = getPublicationTrackSid(publication, track, object.state.mediaTrackSid ?? `${object.objectId}:remote-browser-video`);
  const existing = remoteBrowserVideoByObjectId.get(object.objectId);
  if (existing?.trackSid === trackSid && existing.element) {
    moveRemoteBrowserVideoEntryToSurface(existing, object.surfaceId);
    return;
  }
  if (existing) {
    detachRemoteBrowserVideoEntry(existing);
  }
  const element = track.attach() as HTMLVideoElement;
  prepareHiddenVideoElement(element, { muted: true });
  document.body.appendChild(element);

  const texture = createRemoteBrowserVideoTexture(element);
  applySurfaceTexture(object.surfaceId, texture);

  const entry: RemoteBrowserVideoEntry = {
    objectId: object.objectId,
    surfaceId: object.surfaceId,
    track,
    element,
    texture,
    trackSid,
    playError: null,
    frameCount: 0,
    lastFrameAtMs: 0,
    presentedFrames: 0
  };
  remoteBrowserVideoByObjectId.set(object.objectId, entry);
  startHiddenVideoPlayback(element, (error) => {
    if (remoteBrowserVideoByObjectId.get(object.objectId) === entry) {
      entry.playError = error;
    }
  });
  startRemoteBrowserExternalVideoFrameDiagnostics(entry);
  debugState.remoteBrowser.mediaConnected = true;
  debugState.remoteBrowser.mediaState = "connected";
  debugState.remoteBrowser.mediaHasVideo = true;
  Object.assign(debugState.remoteBrowser, createRemoteBrowserExternalVideoDebugSnapshot(object));
}

function attachScreenShareStream(stream: MediaStream, options: {
  objectId: string;
  surfaceId: string;
  ownerParticipantId: string;
  mediaTrackSid: string;
  publishedTracks?: MediaStreamTrack[];
}): void {
  const existing = screenShareRuntimeByObjectId.get(options.objectId);
  if (existing) {
    detachScreenShareEntry(existing);
  }
  const element = document.createElement("video");
  prepareHiddenVideoElement(element, { muted: true });
  element.srcObject = stream;
  document.body.appendChild(element);
  startHiddenVideoPlayback(element);

  const texture = createScreenShareVideoTexture(element);
  applySurfaceTexture(options.surfaceId, texture);

  registerScreenShareEntry({
    objectId: options.objectId,
    surfaceId: options.surfaceId,
    ownerParticipantId: options.ownerParticipantId,
    mediaTrackSid: options.mediaTrackSid,
    remote: false,
    track: null,
    element,
    texture,
    stream,
    publishedTracks: options.publishedTracks ?? [],
    stopping: false
  });
  debugState.screenShareState = "sharing";
}

function attachMockVideoStream(stream: MediaStream, objectId: string, surfaceId: string, mediaTrackSid: string): void {
  attachScreenShareStream(stream, {
    objectId,
    surfaceId,
    ownerParticipantId: participantId,
    mediaTrackSid
  });
}

function createMockShareStream(): MediaStream {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("mock_canvas_context_failed");
  }

  let tick = 0;
  const render = () => {
    tick += 1;
    context.fillStyle = "#13233b";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#5fc8ff";
    context.fillRect(40 + (tick % 200), 110, 180, 90);
    context.fillStyle = "#ffffff";
    context.font = "28px sans-serif";
    context.fillText("Mock Share", 220, 180);
    context.fillText(new Date().toLocaleTimeString(), 220, 220);
    requestAnimationFrame(render);
  };
  render();
  return canvas.captureStream(24);
}

async function captureAndPublishScreenShareStream(room: Room, input: {
  objectId: string;
  mediaAudioEnabled: boolean;
}): Promise<{ stream: MediaStream; publishedTracks: MediaStreamTrack[]; mediaTrackSid: string }> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw createFaultError("NotSupportedError", "screen_share_unsupported:getDisplayMedia missing");
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: input.mediaAudioEnabled
  });
  const videoTrack = stream.getVideoTracks().find((track) => track.readyState === "live");
  if (!videoTrack) {
    stream.getTracks().forEach((track) => track.stop());
    throw createFaultError("NotFoundError", "screen_share_video_track_missing");
  }
  const localParticipant = room.localParticipant as {
    publishTrack: (track: MediaStreamTrack, options?: { name?: string; source?: Track.Source | string }) => Promise<{ trackSid?: string; sid?: string }>;
  };
  const publishedTracks: MediaStreamTrack[] = [];
  try {
    const videoPublication = await localParticipant.publishTrack(videoTrack, {
      name: `screen-share:${input.objectId}:video`,
      source: Track.Source.ScreenShare
    });
    publishedTracks.push(videoTrack);
    const audioTrack = stream.getAudioTracks().find((track) => track.readyState === "live");
    if (input.mediaAudioEnabled && audioTrack) {
      await localParticipant.publishTrack(audioTrack, {
        name: `screen-share:${input.objectId}:audio`,
        source: (Track.Source as Record<string, Track.Source | string>).ScreenShareAudio ?? "screen_share_audio"
      });
      publishedTracks.push(audioTrack);
    }
    return {
      stream,
      publishedTracks,
      mediaTrackSid: videoPublication.trackSid ?? videoPublication.sid ?? videoTrack.id
    };
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
}

function detachVideoTrack(track?: Track): void {
  const entry = track
    ? screenShareEntryForTrack(track)
    : localScreenShareEntryForSurface(selectedMediaSurfaceId) ?? anyLocalScreenShareEntry() ?? screenShareEntries()[0] ?? null;
  if (!entry) {
    return;
  }
  detachScreenShareEntry(entry);
}

function detachRemoteBrowserVideoTrack(track?: Track): void {
  const entry = track
    ? remoteBrowserVideoEntryForTrack(track)
    : remoteBrowserVideoEntryForObject(activeRemoteBrowserObjectForSurface(selectedMediaSurfaceId)?.objectId ?? findActiveRemoteBrowserObject()?.objectId);
  if (!entry) {
    return;
  }
  detachRemoteBrowserVideoEntry(entry);
  debugState.remoteBrowser.mediaConnected = false;
  debugState.remoteBrowser.mediaHasVideo = false;
  Object.assign(debugState.remoteBrowser, createRemoteBrowserExternalVideoDebugSnapshot(currentRemoteBrowserObject()));
}

type LiveKitTransportCandidate = {
  getStats?: () => Promise<RTCStatsReport>;
  getConnectionState?: () => RTCPeerConnectionState | null | undefined;
  getICEConnectionState?: () => RTCIceConnectionState | null | undefined;
  getSignallingState?: () => RTCSignalingState | null | undefined;
  getSignalingState?: () => RTCSignalingState | null | undefined;
};

type LiveKitEngineDiagnosticsSource = {
  on?: (eventName: "transportsCreated", callback: (publisher: unknown, subscriber?: unknown) => void) => unknown;
  pcManager?: {
    publisher?: unknown;
    subscriber?: unknown;
  };
};

function createWebRtcStatsTransport(role: WebRtcTransportRole, source: unknown): WebRtcStatsTransport | null {
  const candidate = source as LiveKitTransportCandidate | null | undefined;
  if (!candidate || typeof candidate.getStats !== "function") {
    return null;
  }
  return {
    role,
    getStats: () => candidate.getStats!(),
    getConnectionState: () => candidate.getConnectionState?.() ?? null,
    getIceConnectionState: () => candidate.getICEConnectionState?.() ?? null,
    getSignalingState: () => candidate.getSignalingState?.() ?? candidate.getSignallingState?.() ?? null
  };
}

function setMediaDiagnosticsTransports(publisher: unknown, subscriber?: unknown): void {
  mediaDiagnosticsTransports = [
    createWebRtcStatsTransport("publisher", publisher),
    createWebRtcStatsTransport("subscriber", subscriber)
  ].filter((transport): transport is WebRtcStatsTransport => Boolean(transport));
  void refreshWebRtcDiagnostics().catch(() => undefined);
}

function setupMediaTransportDiagnostics(room: Room): void {
  const engine = (room as { engine?: LiveKitEngineDiagnosticsSource }).engine;
  if (!engine) {
    return;
  }
  if (!mediaTransportDiagnosticsRooms.has(room)) {
    mediaTransportDiagnosticsRooms.add(room);
    engine.on?.("transportsCreated", (publisher, subscriber) => {
      setMediaDiagnosticsTransports(publisher, subscriber);
    });
  }
  if (engine.pcManager?.publisher || engine.pcManager?.subscriber) {
    setMediaDiagnosticsTransports(engine.pcManager.publisher, engine.pcManager.subscriber);
  }
}

async function ensureMediaRoom(): Promise<Room> {
  if (livekitRoom) {
    return livekitRoom;
  }

  if (faultConfig.audio === "livekit_failed") {
    throw createFaultError("FaultInjectedError", "livekit_failed");
  }
  if (faultConfig.audio === "media_network_blocked") {
    throw createFaultError("ConnectionError", "media_network_blocked");
  }

  const voicePlan = await planVoiceSession(apiBaseUrl, roomId, participantId, roomStateAccessToken);
  const room = new Room();
  setupAudio(room);
  setupMediaTransportDiagnostics(room);
  try {
    await room.connect(voicePlan.livekitUrl, voicePlan.token);
  } catch (error) {
    mediaDiagnosticsTransports = [];
    debugState.media.webrtc = createUnavailableWebRtcDiagnostics("livekit_connect_failed");
    throw error;
  }
  setupMediaTransportDiagnostics(room);
  await applyPreferredAudioDevices(room);
  livekitRoom = room;
  mediaRoomReady = true;
  await refreshWebRtcDiagnostics();
  startShareButton.disabled = !canUseScreenShareControl();
  return room;
}

function applyBotPose(timeSeconds: number): void {
  if (botMode === "off") {
    return;
  }

  const elapsed = Math.max(0, timeSeconds - botStartedAtSeconds);
  const pose = localPoseController.getPose();
  let x = botInitialPosition.x;
  let z = botInitialPosition.z;
  let yaw = pose.yaw;
  let pitchAngle = presenceXrMockEnabled ? Math.sin(elapsed * botSpeed * 0.7) * 0.25 : pose.pitch;
  let avatarMove = { x: 0, z: 0 };
  let avatarTurnRate = 0;

  if (botMode === "line") {
    const phase = elapsed * botSpeed * 0.7;
    x = botInitialPosition.x;
    z = botInitialPosition.z + Math.sin(phase) * 2;
    yaw = Math.cos(phase) >= 0 ? 0 : Math.PI;
    avatarMove = { x: 0, z: Math.cos(phase) >= 0 ? 1 : -1 };
  } else if (botMode === "turn") {
    yaw = elapsed * botSpeed;
    avatarTurnRate = botSpeed;
  } else if (botMode === "square") {
    const sideLength = 2;
    const perimeter = sideLength * 4;
    const progress = (elapsed * botSpeed) % perimeter;
    const side = Math.floor(progress / sideLength);
    const t = (progress % sideLength) / sideLength;
    if (side === 0) {
      x = botInitialPosition.x - sideLength / 2 + t * sideLength;
      z = botInitialPosition.z - sideLength / 2;
      yaw = Math.PI / 2;
      avatarMove = { x: 1, z: 0 };
    } else if (side === 1) {
      x = botInitialPosition.x + sideLength / 2;
      z = botInitialPosition.z - sideLength / 2 + t * sideLength;
      yaw = 0;
      avatarMove = { x: 0, z: 1 };
    } else if (side === 2) {
      x = botInitialPosition.x + sideLength / 2 - t * sideLength;
      z = botInitialPosition.z + sideLength / 2;
      yaw = -Math.PI / 2;
      avatarMove = { x: -1, z: 0 };
    } else {
      x = botInitialPosition.x - sideLength / 2;
      z = botInitialPosition.z + sideLength / 2 - t * sideLength;
      yaw = Math.PI;
      avatarMove = { x: 0, z: -1 };
    }
  } else if (botMode === "orbit") {
    x = botInitialPosition.x + Math.sin(elapsed * botSpeed * 0.8) * 2;
    z = botInitialPosition.z + Math.cos(elapsed * botSpeed * 0.8) * 2;
    yaw = elapsed * botSpeed * 0.8 + Math.PI / 2;
    avatarMove = { x: Math.cos(elapsed * botSpeed * 0.8), z: -Math.sin(elapsed * botSpeed * 0.8) };
    avatarTurnRate = botSpeed * 0.8;
  }

  if (!presenceXrMockEnabled) {
    pitchAngle = pose.pitch;
  }
  localPoseController.setPose({
    position: { x, y: pose.position.y, z },
    yaw,
    pitch: pitchAngle
  }, "desktop_move");
  currentBotMove = avatarMove;
  lastAvatarMove = avatarMove;
  lastAvatarTurnRate = avatarTurnRate;
  updateLocalPositionDebug();
}

function getCameraWorldYaw(): number {
  const cameraWorldQuaternion = new THREE.Quaternion();
  const cameraWorldEuler = new THREE.Euler(0, 0, 0, "YXZ");
  camera.getWorldQuaternion(cameraWorldQuaternion);
  cameraWorldEuler.setFromQuaternion(cameraWorldQuaternion, "YXZ");
  return cameraWorldEuler.y;
}

function getCameraWorldPitch(): number {
  const cameraWorldQuaternion = new THREE.Quaternion();
  const cameraWorldEuler = new THREE.Euler(0, 0, 0, "YXZ");
  camera.getWorldQuaternion(cameraWorldQuaternion);
  cameraWorldEuler.setFromQuaternion(cameraWorldQuaternion, "YXZ");
  return cameraWorldEuler.x;
}

function getLocalAvatarHandTargets(frameContext: RuntimeFrameContext): { leftHand: { x: number; y: number; z: number } | null; rightHand: { x: number; y: number; z: number } | null } {
  const pose = localPoseController.getPose();
  const handFrame = getFrameLocalAvatarHandFrame(frameContext);
  if (avatarVrMockEnabled && !renderer.xr.isPresenting) {
    if (handFrame) {
      const headWorldPosition = camera.getWorldPosition(new THREE.Vector3());
      debugState.xrAvatarDebug = {
        profile: "synthetic",
        playerRoot: {
          x: pose.position.x,
          y: pose.position.y,
          z: pose.position.z,
          yaw: pose.yaw
        },
        headWorld: {
          x: headWorldPosition.x,
          y: headWorldPosition.y,
          z: headWorldPosition.z
        },
        leftGrip: null,
        rightGrip: handFrame.debug.rightGrip,
        leftController: null,
        rightController: handFrame.debug.rightController,
        leftResolved: null,
        rightResolved: handFrame.debug.rightResolved,
        rightHandWorld: handFrame.worldHands.rightHand,
        rightControllerWorld: handFrame.controllerWorldHands.rightHand
      };
      return handFrame.worldHands;
    }
    const headWorldPosition = camera.getWorldPosition(new THREE.Vector3());
    debugState.xrAvatarDebug = {
      profile: "none",
      playerRoot: {
        x: pose.position.x,
        y: pose.position.y,
        z: pose.position.z,
        yaw: pose.yaw
      },
      headWorld: {
        x: headWorldPosition.x,
        y: headWorldPosition.y,
        z: headWorldPosition.z
      },
      leftGrip: null,
      rightGrip: null,
      leftController: null,
      rightController: null,
      leftResolved: null,
      rightResolved: null,
      rightHandWorld: null,
      rightControllerWorld: null
    };
    return { leftHand: null, rightHand: null };
  }
  if (!renderer.xr.isPresenting) {
    debugState.xrAvatarDebug = null;
    return { leftHand: null, rightHand: null };
  }
  if (!handFrame) {
    debugState.xrAvatarDebug = null;
    return { leftHand: null, rightHand: null };
  }
  const headWorldPosition = camera.getWorldPosition(new THREE.Vector3());
  debugState.xrAvatarDebug = {
    profile: lastAvatarXrInputProfile,
    playerRoot: {
      x: pose.position.x,
      y: pose.position.y,
      z: pose.position.z,
      yaw: pose.yaw
    },
    headWorld: {
      x: headWorldPosition.x,
      y: headWorldPosition.y,
      z: headWorldPosition.z
    },
    leftGrip: handFrame.debug.leftGrip,
    rightGrip: handFrame.debug.rightGrip,
    leftController: handFrame.debug.leftController,
    rightController: handFrame.debug.rightController,
    leftResolved: handFrame.debug.leftResolved,
    rightResolved: handFrame.debug.rightResolved,
    rightHandWorld: handFrame.worldHands.rightHand,
    rightControllerWorld: handFrame.controllerWorldHands.rightHand
  };
  return handFrame.worldHands;
}

function updateLocalAvatar(delta: number, frameContext: RuntimeFrameContext): void {
  const xrPresenting = renderer.xr.isPresenting || avatarVrMockEnabled;
  if (localBodyMesh) {
    localBodyMesh.visible = !runtimeFlags.avatarsEnabled && !xrPresenting;
  }
  if (localHeadMesh) {
    localHeadMesh.visible = !runtimeFlags.avatarsEnabled && debugEnabled && !xrPresenting;
  }
  if (!localAvatarController) {
    return;
  }

  const headWorldPosition = new THREE.Vector3();
  camera.getWorldPosition(headWorldPosition);
  const handTargets = getLocalAvatarHandTargets(frameContext);
  const lipsyncState = {
    mouthAmount: localAvatarController.diagnostics.mouthAmount,
    speakingActive: localAvatarController.diagnostics.speakingActive,
    lipsyncSourceState: (localAvatarController.diagnostics.lipsyncSourceState ?? "idle") as AvatarLipsyncSourceState
  };
  const xrInputProfile = renderer.xr.isPresenting
    ? lastAvatarXrInputProfile
    : avatarVrMockEnabled
      ? "none"
      : null;
  const inputMode = xrPresenting
    ? "vr-controller"
    : /android|iphone|ipad/i.test(navigator.userAgent)
      ? "mobile"
      : "desktop";
  const viewProfile = resolveAvatarViewProfile({
    inputMode,
    xrPresenting
  });
  const pose = localPoseController.getPose();
  const useTrackedHead = renderer.xr.isPresenting;
  const avatarRootX = useTrackedHead ? headWorldPosition.x : pose.position.x;
  const avatarRootY = useTrackedHead
    ? headWorldPosition.y - viewProfile.poseProfile.headHeight
    : pose.position.y;
  const avatarRootZ = useTrackedHead ? headWorldPosition.z : pose.position.z;
  const avatarHeadWorldPosition = useTrackedHead
    ? headWorldPosition
    : resolveNonXrHeadWorldPosition(pose, viewProfile.poseProfile.headHeight);
  const headYaw = useTrackedHead ? getCameraWorldYaw() : pose.yaw;
  const headPitch = useTrackedHead ? getCameraWorldPitch() : pose.pitch;

  localAvatarController.update({
    deltaSeconds: delta,
    inputMode,
    xrPresenting,
    xrInputProfile,
    rootPosition: {
      x: avatarRootX,
      y: avatarRootY,
      z: avatarRootZ
    },
    yaw: pose.yaw,
    headPosition: {
      x: avatarHeadWorldPosition.x,
      y: avatarHeadWorldPosition.y,
      z: avatarHeadWorldPosition.z
    },
    headYaw,
    headPitch,
    leftHand: handTargets.leftHand,
    rightHand: handTargets.rightHand,
    moveX: lastAvatarMove.x,
    moveZ: lastAvatarMove.z,
    turnRate: lastAvatarTurnRate,
    mouthAmount: lipsyncState.mouthAmount,
    speakingActive: lipsyncState.speakingActive,
    lipsyncSourceState: lipsyncState.lipsyncSourceState
  });
  debugState.avatarDebug = localAvatarController.diagnostics;
  debugState.avatarSnapshot = localAvatarController.snapshot;
  debugState.avatarTransportPreview = avatarOutboundPublisher.build({
    participantId,
    snapshot: localAvatarController.snapshot,
    muted: !microphoneEnabled,
    audioActive: microphoneEnabled,
    seated: getCurrentSeatId() !== null,
    seatId: getCurrentSeatId() ?? undefined
  });
  debugState.avatarPoseTransport.targetHz = Math.round(1 / getAvatarPoseSendIntervalSeconds(localAvatarController.snapshot));
}

function getAvatarPoseSendIntervalSeconds(snapshot: LocalAvatarSnapshotV1 | null): number {
  if (!snapshot) {
    return 0.1;
  }
  const averageFrameBudgetMs = recentFrameBudgetMs.length === 0
    ? 16
    : recentFrameBudgetMs.reduce((sum, value) => sum + value, 0) / recentFrameBudgetMs.length;
  debugState.avatarPoseTransport.frameBudgetMs = Math.round(averageFrameBudgetMs * 10) / 10;
  if (snapshot.inputMode === "vr-controller" || snapshot.inputMode === "vr-hand") {
    if (averageFrameBudgetMs > 28) {
      return 1 / 20;
    }
    if (averageFrameBudgetMs > 20) {
      return 1 / 24;
    }
    return 1 / 30;
  }
  if (snapshot.inputMode === "desktop" && snapshot.locomotionState !== "idle") {
    if (averageFrameBudgetMs > 35) {
      return 1 / 20;
    }
    return 1 / 24;
  }
  if (averageFrameBudgetMs > 35) {
    return 1 / 8;
  }
  return 1 / 10;
}

function syncAvatarPoseRealtime(nowMs: number): void {
  if (!roomStateClient || !roomStateConnected || !runtimeFlags.avatarsEnabled || !runtimeFlags.avatarPoseBinaryEnabled || !debugState.avatarTransportPreview) {
    return;
  }
  const intervalSeconds = getAvatarPoseSendIntervalSeconds(debugState.avatarSnapshot);
  if (nowMs - lastAvatarPoseSentAtMs < intervalSeconds * 1000) {
    return;
  }
  sendAvatarPoseFrame(roomStateClient, participantId, debugState.avatarTransportPreview.poseFrame);
  lastAvatarPoseSentAtMs = nowMs;
  avatarPoseSendTimestamps.push(nowMs);
  while (avatarPoseSendTimestamps.length > 0 && nowMs - avatarPoseSendTimestamps[0]! > 1000) {
    avatarPoseSendTimestamps.shift();
  }
  debugState.avatarPoseTransport.sendsInLastSecond = avatarPoseSendTimestamps.length;
  debugState.avatarPoseTransport.effectiveHz = avatarPoseSendTimestamps.length;
  debugState.avatarPoseTransport.lastPoseSentAtMs = nowMs;
  debugState.avatarPoseTransport.lastPoseSeq = debugState.avatarTransportPreview.poseFrame.seq;
}

function resetAvatarPoseTransportStats(): void {
  lastAvatarPoseSentAtMs = 0;
  avatarPoseSendTimestamps.length = 0;
  debugState.avatarPoseTransport.targetHz = 0;
  debugState.avatarPoseTransport.effectiveHz = 0;
  debugState.avatarPoseTransport.sendsInLastSecond = 0;
  debugState.avatarPoseTransport.lastPoseSentAtMs = 0;
  debugState.avatarPoseTransport.lastPoseSeq = 0;
  debugState.avatarPoseTransport.frameBudgetMs = 0;
  debugState.avatarPoseTransport.adaptivePlaybackDelayMs = 100;
}

function populateAvatarPresetSelect(input: {
  options: Array<{ avatarId: string; label: string }>;
  selectedAvatarId: string | null;
  label: string;
  status: string;
  enabled: boolean;
  onChange?: (() => void) | null;
}): void {
  avatarPresetLabel.textContent = input.label;
  avatarSandboxPanel.hidden = !input.enabled;
  avatarPresetSelect.replaceChildren();
  for (const optionConfig of input.options) {
    const option = document.createElement("option");
    option.value = optionConfig.avatarId;
    option.textContent = optionConfig.label;
    option.selected = optionConfig.avatarId === input.selectedAvatarId;
    avatarPresetSelect.appendChild(option);
  }
  avatarPresetSelect.disabled = !input.enabled || input.options.length === 0;
  avatarPresetSelect.onchange = input.onChange ?? null;
  setAvatarSandboxStatus(avatarSandboxStatusEl, input.status);
}

async function bootLocalAvatarPresetSession(input: {
  catalogUrl: string;
  preferredAvatarId?: string;
  note?: string;
}): Promise<void> {
  localAvatarController?.dispose();
  localAvatarController = null;
  populateAvatarPresetSelect({
    options: [],
    selectedAvatarId: null,
    label: "Self Avatar",
    status: "Loading self avatar presets...",
    enabled: true
  });
  const localAvatarSession = await startLocalAvatarSession({
    catalogUrl: input.catalogUrl,
    renderer,
    scene,
    storage: window.localStorage,
    preferredAvatarId: input.preferredAvatarId
  });
  localAvatarController = localAvatarSession.controller;
  debugState.avatarDebug = localAvatarSession.diagnostics;
  debugState.avatarSnapshot = localAvatarSession.controller?.snapshot ?? null;
  debugState.avatarTransportPreview = null;
  resetAvatarPoseTransportStats();
  populateAvatarPresetSelect({
    options: localAvatarSession.presetOptions,
    selectedAvatarId: localAvatarSession.controller?.selectedAvatarId ?? localAvatarSession.diagnostics.selectedAvatarId,
    label: "Self Avatar",
    status: localAvatarSession.statusMessage,
    enabled: true,
    onChange: () => {
      void bootLocalAvatarPresetSession({
        catalogUrl: input.catalogUrl,
        preferredAvatarId: avatarPresetSelect.value,
        note: "local_avatar_preset_changed"
      });
    }
  });
  await reportDiagnostics(input.note ?? localAvatarSession.note);
}

function sampleRuntimeFrameContext(deltaSeconds: number, nowMs: number): RuntimeFrameContext {
  if (renderer.xr.isPresenting || (avatarVrMockEnabled && syntheticXrState)) {
    const selectEventPending = xrSelectEventPending;
    xrSelectEventPending = false;
    if (syntheticXrState) {
      const triggerPressed = syntheticXrState.triggerPressed;
      const confirmInteraction = resolveXrConfirmInteractionIntent({
        triggerPressed,
        triggerPressedLastFrame: xrSelectPressedLastFrame,
        selectEventPending
      });
      const resolved = resolveXrInputIntents({
        axes: syntheticXrState.axes,
        triggerPressed: confirmInteraction,
        rayVisibleLatched: xrRayVisibleLatched
      });
      return {
        deltaSeconds,
        nowMs,
        source: "xr",
        intents: {
          ...resolved.intents,
          aimRay: resolved.intents.aimRay || syntheticXrState.rayVisible
        },
        xr: {
          frame: undefined,
          session: undefined,
          referenceSpace: null,
          inputSources: [],
          profile: "synthetic-right",
          sanitizedAxes: resolved.sanitizedAxes,
          rawAxes: syntheticXrState.axes,
          triggerPressed,
          rayVisibleLatched: resolved.rayVisibleLatched || syntheticXrState.rayVisible
        }
      };
    }

    const xrFrame = renderer.xr.getFrame();
    const session = xrFrame?.session;
    const inputSources = Array.from(session?.inputSources ?? []);
    const xrInput = resolveAvatarXrInput(inputSources);
    const rightIndex = inputSources.findIndex((source) => source.handedness === "right");
    const triggerPressed = rightIndex >= 0
      ? Boolean(inputSources[rightIndex]?.gamepad?.buttons?.[0]?.pressed)
      : false;
    const confirmInteraction = resolveXrConfirmInteractionIntent({
      triggerPressed,
      triggerPressedLastFrame: xrSelectPressedLastFrame,
      selectEventPending
    });
    const resolved = resolveXrInputIntents({
      axes: xrInput.axes,
      triggerPressed: confirmInteraction,
      rayVisibleLatched: xrRayVisibleLatched
    });
    return {
      deltaSeconds,
      nowMs,
      source: "xr",
      intents: resolved.intents,
      xr: {
        frame: xrFrame,
        session,
        referenceSpace: renderer.xr.getReferenceSpace(),
        inputSources,
        profile: xrInput.profile,
        sanitizedAxes: resolved.sanitizedAxes,
        rawAxes: xrInput.axes,
        triggerPressed,
        rayVisibleLatched: resolved.rayVisibleLatched
      }
    };
  }

  xrSelectEventPending = false;
  const intents = resolveDesktopTouchInputIntents({
    keys: keyState,
    touchActive: mobileTouchActive,
    touchVector: mobileTouchVector
  });
  return {
    deltaSeconds,
    nowMs,
    source: intents.source,
    intents
  };
}

function createFrameLocomotionHandlers(frameContext: RuntimeFrameContext): FrameLocomotionPipelineHandlers {
  return {
    getYaw: () => localPoseController.getYaw(),
    getPose: () => localPoseController.getPose(),
    getCurrentSeatId,
    getSeatRootPosition: (seatId) => {
      const seatAnchor = sceneSeatAnchorMap.get(seatId);
      return seatAnchor ? resolveSeatRootPosition(seatAnchor) : null;
    },
    getSeatYaw: (seatId) => sceneSeatAnchorMap.get(seatId)?.yaw,
    getLastAppliedSeatLockId: () => lastAppliedSeatLockId,
    getCameraForward: () => {
      const viewForward = camera.getWorldDirection(new THREE.Vector3());
      return { x: viewForward.x, z: viewForward.z };
    },
    getDesktopFastMove: () => Boolean(keyState.ShiftLeft),
    getBotMove: () => botMode !== "off" ? currentBotMove : null,
    executeCommands: (commands) => executeFrameRuntimeCommandList(frameContext, commands)
  };
}

function updateMovement(delta: number, frameContext: RuntimeFrameContext): void {
  executeFrameLocomotionPipeline({
    frameContext,
    deltaSeconds: delta,
    floorY: sceneTeleportFloorY,
    turnCooldownSeconds: xrTurnCooldown,
    turnArmed: xrTurnArmed
  }, createFrameLocomotionHandlers(frameContext));
}

async function syncPresence(mode: PresenceState["mode"], audioActive: boolean): Promise<void> {
  const pose = localPoseController.getPose();
  const useTrackedHead = renderer.xr.isPresenting && !presenceXrMockEnabled;
  const worldPosition = useTrackedHead ? camera.getWorldPosition(new THREE.Vector3()) : resolveNonXrHeadWorldPosition(pose);
  const effectiveMode = presenceXrMockEnabled ? "vr" : mode;
  const headYaw = useTrackedHead ? getCameraWorldYaw() : pose.yaw;
  const headPitch = useTrackedHead ? getCameraWorldPitch() : pose.pitch;
  const bodyXZ = useTrackedHead
    ? deriveBodyTransform(
      { x: pose.position.x, z: pose.position.z },
      { x: worldPosition.x, z: worldPosition.z }
    )
    : { x: pose.position.x, z: pose.position.z };
  presenceSeq += 1;
  const clientTimeMs = Date.now();

  const presencePayload: PresenceState = {
    participantId,
    displayName,
    role: debugState.access.role,
    permissions: debugState.access.permissions,
    mode: effectiveMode,
    rootTransform: {
      x: pose.position.x,
      y: pose.position.y,
      z: pose.position.z,
      yaw: pose.yaw
    },
    bodyTransform: {
      x: bodyXZ.x,
      y: 0.92,
      z: bodyXZ.z,
      yaw: pose.yaw
    },
    headTransform: {
      x: worldPosition.x,
      y: worldPosition.y,
      z: worldPosition.z,
      yaw: headYaw,
      pitch: headPitch
    },
    muted: !microphoneEnabled,
    activeMedia: {
      audio: audioActive,
      screenShare: hasLocalScreenSharePublishing()
    },
    seq: presenceSeq,
    clientTimeMs,
    updatedAt: new Date(clientTimeMs).toISOString()
  };

  let sentRealtimePresence = false;
  if (roomStateClient && roomStateConnected) {
    sendParticipantUpdate(roomStateClient, presencePayload);
    if (runtimeFlags.avatarsEnabled && debugState.avatarTransportPreview) {
      sendAvatarReliableState(roomStateClient, debugState.avatarTransportPreview.reliableState);
    }
    sentRealtimePresence = true;
  }

  const nowMs = Date.now();
  let sentFallbackPresence = false;
  if (!apiPresenceSyncInFlight && nowMs - lastApiPresenceSyncAtMs >= API_PRESENCE_SYNC_INTERVAL_MS) {
    apiPresenceSyncInFlight = true;
    lastApiPresenceSyncAtMs = nowMs;
    try {
      await upsertPresence(apiBaseUrl, roomId, presencePayload, roomStateAccessToken);
      sentFallbackPresence = true;
    } catch (error) {
      console.error(error);
      if (!sentRealtimePresence) {
        const issue = classifyRoomStateError(error);
        applyIssue(issue, {
          degradedMode: "api_fallback",
          roomStateMode: "api_fallback",
          lastRecoveryAction: "presence_sync_failed",
          roomStateLabel: "Room-state: fallback API"
        });
        void reportDiagnostics("presence_sync_issue");
      }
    } finally {
      apiPresenceSyncInFlight = false;
    }
  }

  if (sentRealtimePresence || sentFallbackPresence) {
    debugState.lastPresenceSyncAt = Date.now();
  }
}

async function refreshPresence(): Promise<void> {
  const nowMs = Date.now();
  if (apiPresenceRefreshInFlight || nowMs - lastApiPresenceRefreshAtMs < API_PRESENCE_REFRESH_INTERVAL_MS) {
    return;
  }
  apiPresenceRefreshInFlight = true;
  lastApiPresenceRefreshAtMs = nowMs;
  const apiFallbackRequired = !roomStateConnected;
  try {
    latestFallbackParticipants = await listPresence(apiBaseUrl, roomId);
    if (apiFallbackRequired) {
      latestRealtimeParticipants = [];
    }
    applyMergedPresenceParticipants();
  } catch (error) {
    if (apiFallbackRequired) {
      throw error;
    }
    console.warn("api_presence_refresh_failed", error);
  } finally {
    apiPresenceRefreshInFlight = false;
  }
}

function setupAudio(room: Room): void {
  room.on(RoomEvent.Disconnected, () => {
    if (livekitRoom === room) {
      mediaDiagnosticsTransports = [];
      debugState.media.webrtc = createUnavailableWebRtcDiagnostics("livekit_disconnected");
    }
  });

  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    if (track.kind === Track.Kind.Video) {
      const remoteBrowser = resolveRemoteBrowserObjectForTrack(participant?.identity, publication, track, "video");
      if (remoteBrowser) {
        attachRemoteBrowserVideoTrack(track, remoteBrowser, publication);
        return;
      }
      const screenShare = resolveScreenShareObjectForTrack(participant?.identity, publication, track);
      const trackSid = getPublicationTrackSid(publication, track, `${participant?.identity ?? "remote"}:screen-share-video`);
      attachVideoTrack(track, {
        remote: true,
        objectId: screenShare?.objectId ?? `screen-share-track:${trackSid}`,
        surfaceId: screenShare?.surfaceId ?? resolveScreenShareSurfaceForParticipant(participant?.identity),
        ownerParticipantId: screenShare?.ownerParticipantId ?? participant?.identity ?? null,
        mediaTrackSid: screenShare?.state.mediaTrackSid ?? trackSid
      });
      return;
    }
    if (track.kind !== Track.Kind.Audio) return;
    const remoteBrowser = resolveRemoteBrowserObjectForTrack(participant?.identity, publication, track, "audio");
    if (remoteBrowser) {
      connectMediaSurfaceAudioTrack(track, remoteBrowser.surfaceId);
      debugState.remoteBrowser.mediaHasAudio = true;
      debugState.audioState = "remote-track";
      return;
    }
    if (isScreenShareAudioSource((publication as { source?: unknown }).source)) {
      const screenShare = resolveScreenShareObjectForTrack(participant?.identity, publication, track);
      connectMediaSurfaceAudioTrack(track, screenShare?.surfaceId ?? resolveScreenShareSurfaceForParticipant(participant?.identity));
      return;
    }
    if (participant?.identity) {
      connectRemoteAudioTrack(track, participant.identity);
    }
    debugState.audioState = "remote-track";
  });

  room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
    if (track.kind === Track.Kind.Video) {
      if (resolveRemoteBrowserObjectForTrack(participant?.identity, publication, track, "video") || remoteBrowserVideoEntryForTrack(track)) {
        detachRemoteBrowserVideoTrack(track);
        return;
      }
      detachVideoTrack(track);
      return;
    }
    if (track.kind !== Track.Kind.Audio) return;
    if (resolveRemoteBrowserObjectForTrack(participant?.identity, publication, track, "audio")) {
      disconnectMediaSurfaceAudioTrackByTrack(track);
      debugState.remoteBrowser.mediaHasAudio = false;
      track.detach().forEach((element) => element.remove());
      return;
    }
    if (isScreenShareAudioSource((publication as { source?: unknown }).source)) {
      disconnectMediaSurfaceAudioTrackByTrack(track);
      track.detach().forEach((element) => element.remove());
      return;
    }
    if (participant?.identity) {
      disconnectRemoteAudioElement(participant.identity);
    }
    track.detach().forEach((element) => element.remove());
  });
}

async function startScreenShare(): Promise<void> {
  if (!debugState.access.canStartScreenShare) {
    debugState.access.lastDeniedPermission = "screen-share.start";
    throw createFaultError("NotAllowedError", "screen_share_forbidden");
  }
  if (!roomStateClient || !roomStateConnected) {
    throw createFaultError("ConnectionError", "room_state_failed");
  }
  if (!shareMockEnabled && !browserMediaCapabilities.screenShare.supported) {
    debugState.screenShare.errorCode = "display_capture_unsupported";
    throw createFaultError("NotSupportedError", `screen_share_unsupported:${browserMediaCapabilities.screenShare.reason}`);
  }
  if (startShareButton.disabled) {
    return;
  }
  const targetSurfaceId = selectedMediaSurfaceId;
  const createResult = await mediaSurfaceCommands.createScreenShareObjectOnSurface(targetSurfaceId);
  if (!createResult.accepted || !createResult.objectId) {
    throw new Error(`screen_share_create_rejected:${createResult.blockedReason ?? "unknown"}`);
  }

  const objectId = createResult.objectId;
  const surfaceId = createResult.surfaceId ?? targetSurfaceId;
  lastScreenShareStoppedAtMs = 0;
  let revision = createResult.revision ?? 0;
  debugState.screenShare.selectedSurfaceId = surfaceId;
  debugState.screenShare.errorCode = null;

  try {
    const selecting = await mediaSurfaceCommands.patchScreenShareObject(objectId, surfaceId, revision, { type: "mark-selecting" });
    if (!selecting.accepted) {
      throw new Error(`screen_share_selecting_rejected:${selecting.blockedReason ?? "unknown"}`);
    }
    revision = selecting.revision ?? revision;

    if (shareMockEnabled) {
      const publishing = await mediaSurfaceCommands.patchScreenShareObject(objectId, surfaceId, revision, { type: "mark-publishing" });
      if (!publishing.accepted) {
        throw new Error(`screen_share_publishing_rejected:${publishing.blockedReason ?? "unknown"}`);
      }
      revision = publishing.revision ?? revision;
      const mediaTrackSid = `mock-screen-share:${participantId}:${objectId}:${Date.now()}`;
      attachMockVideoStream(createMockShareStream(), objectId, surfaceId, mediaTrackSid);
      const active = await mediaSurfaceCommands.patchScreenShareObject(objectId, surfaceId, revision, { type: "mark-active", mediaTrackSid });
      if (!active.accepted) {
        throw new Error(`screen_share_active_rejected:${active.blockedReason ?? "unknown"}`);
      }
      debugState.screenShareState = "sharing";
      debugState.screenShare.active = true;
      debugState.screenShare.localPublishing = true;
      debugState.screenShare.publishedTrackSid = mediaTrackSid;
      startShareButton.disabled = !canUseScreenShareControl();
      stopShareButton.disabled = !canStopLocalScreenShare();
      setStatus("Sharing screen");
      void reportDiagnostics("screenshare_mock_started");
      return;
    }

    const room = await ensureMediaRoom();
    debugState.screenShareState = "starting";
    const publishing = await mediaSurfaceCommands.patchScreenShareObject(objectId, surfaceId, revision, { type: "mark-publishing" });
    if (!publishing.accepted) {
      throw new Error(`screen_share_publishing_rejected:${publishing.blockedReason ?? "unknown"}`);
    }
    revision = publishing.revision ?? revision;
    const mediaAudioEnabled = shouldPublishMediaSurfaceAudio(roomMediaObjects, surfaceId);
    debugState.screenShare.mediaAudioEnabled = mediaAudioEnabled;
    const published = await captureAndPublishScreenShareStream(room, { objectId, mediaAudioEnabled });
    attachScreenShareStream(published.stream, {
      objectId,
      surfaceId,
      ownerParticipantId: participantId,
      mediaTrackSid: published.mediaTrackSid,
      publishedTracks: published.publishedTracks
    });
    bindLocalScreenShareTrackEnd(objectId, surfaceId, published.publishedTracks);
    const active = await mediaSurfaceCommands.patchScreenShareObject(objectId, surfaceId, revision, { type: "mark-active", mediaTrackSid: published.mediaTrackSid });
    if (!active.accepted) {
      throw new Error(`screen_share_active_rejected:${active.blockedReason ?? "unknown"}`);
    }
    debugState.screenShareState = "sharing";
    debugState.screenShare.active = true;
    debugState.screenShare.localPublishing = true;
    debugState.screenShare.publishedTrackSid = published.mediaTrackSid;
    startShareButton.disabled = !canUseScreenShareControl();
    stopShareButton.disabled = !canStopLocalScreenShare();
    setStatus("Sharing screen");
    void reportDiagnostics("screenshare_started");
  } catch (error) {
    const errorCode = getScreenShareErrorCode(error);
    debugState.screenShare.errorCode = errorCode;
    void mediaSurfaceCommands.patchScreenShareObject(objectId, surfaceId, revision, { type: "mark-failed", errorCode })
      .then(() => mediaSurfaceCommands.stopScreenShareObject(objectId, surfaceId))
      .catch(() => undefined);
    const entry = screenShareRuntimeByObjectId.get(objectId);
    if (entry) {
      entry.stopping = true;
      await unpublishScreenShareEntry(entry);
      detachScreenShareEntry(entry);
    }
    startShareButton.disabled = !canUseScreenShareControl();
    stopShareButton.disabled = true;
    throw error;
  }
}

async function startWhiteboard(): Promise<void> {
  if (!debugState.access.canCreateWhiteboard) {
    debugState.access.lastDeniedPermission = "surface.create-object";
    throw createFaultError("NotAllowedError", "whiteboard_forbidden");
  }
  if (startWhiteboardButton.disabled) {
    return;
  }
  const result = await mediaSurfaceCommands.createWhiteboardObjectOnSurface(selectedMediaSurfaceId);
  if (!result.accepted) {
    debugState.mediaObjects.blockedReason = result.blockedReason ?? null;
    throw new Error(`whiteboard_create_rejected:${result.blockedReason ?? "unknown"}`);
  }
  getWhiteboardRuntime(result.surfaceId ?? selectedMediaSurfaceId).clearError();
  setStatus("Whiteboard started. Select Draw to sketch.");
  syncWhiteboardControls();
}

async function clearWhiteboard(): Promise<void> {
  const object = activeWhiteboardObjectForSurface(selectedMediaSurfaceId);
  if (!object) {
    return;
  }
  if (!hasRoomPermission(debugState.access.permissions, "whiteboard.clear")) {
    debugState.access.lastDeniedPermission = "whiteboard.clear";
    throw createFaultError("NotAllowedError", "whiteboard_clear_forbidden");
  }
  const runtime = getWhiteboardRuntime(object.surfaceId);
  const result = await mediaSurfaceCommands.patchWhiteboardObject(object.objectId, object.surfaceId, object.revision, runtime.createClearPatch());
  if (!result.accepted) {
    debugState.mediaObjects.blockedReason = result.blockedReason ?? null;
    throw new Error(`whiteboard_clear_rejected:${result.blockedReason ?? "unknown"}`);
  }
  runtime.clearPreview();
  runtime.clearError();
  setStatus("Whiteboard cleared");
}

async function stopWhiteboard(): Promise<void> {
  const object = activeWhiteboardObjectForSurface(selectedMediaSurfaceId);
  if (!object) {
    return;
  }
  if (!hasRoomPermission(debugState.access.permissions, "surface.stop-object")) {
    debugState.access.lastDeniedPermission = "surface.stop-object";
    throw createFaultError("NotAllowedError", "whiteboard_stop_forbidden");
  }
  const result = await mediaSurfaceCommands.stopWhiteboardObject(object.objectId, object.surfaceId);
  if (!result.accepted) {
    debugState.mediaObjects.blockedReason = result.blockedReason ?? null;
    throw new Error(`whiteboard_stop_rejected:${result.blockedReason ?? "unknown"}`);
  }
  whiteboardDrawToolActive = false;
  whiteboardPointerActive = false;
  xrWhiteboardPointerActive = false;
  lastXrWhiteboardHit = null;
  cancelWhiteboardPreview();
  getWhiteboardRuntime(object.surfaceId).clearError();
  syncWhiteboardPencilVisuals(lastRuntimeFrameContext, false);
  setStatus("Whiteboard stopped");
  syncWhiteboardControls();
}

async function openRemoteBrowser(rawUrl: string): Promise<void> {
  if (!hasRoomPermission(debugState.access.permissions, "remote-browser.open-url")) {
    debugState.access.lastDeniedPermission = "remote-browser.open-url";
    throw createFaultError("NotAllowedError", "remote_browser_forbidden");
  }
  if (!roomStateClient || !roomStateConnected) {
    throw createFaultError("ConnectionError", "room_state_failed");
  }
  const targetUrl = normalizeRemoteBrowserUrlInput(rawUrl);
  const activeObject = activeMediaObjectForSurface(selectedMediaSurfaceId);
  if (activeObject && activeObject.type !== REMOTE_BROWSER_OBJECT_TYPE) {
    throw new Error(`remote_browser_surface_occupied:${activeObject.type}`);
  }
  let remoteBrowser = activeRemoteBrowserObjectForSurface(selectedMediaSurfaceId);
  let revision = remoteBrowser?.revision ?? 0;
  if (!remoteBrowser) {
    const createResult = await mediaSurfaceCommands.createRemoteBrowserObjectOnSurface(selectedMediaSurfaceId);
    if (!createResult.accepted || !createResult.objectId) {
      debugState.mediaObjects.blockedReason = createResult.blockedReason ?? null;
      throw new Error(`remote_browser_create_rejected:${createResult.blockedReason ?? "unknown"}`);
    }
    revision = createResult.revision ?? 0;
    remoteBrowser = activeRemoteBrowserObjectForSurface(selectedMediaSurfaceId)
      ?? ({
        objectId: createResult.objectId,
        type: REMOTE_BROWSER_OBJECT_TYPE,
        roomId,
        surfaceId: createResult.surfaceId ?? selectedMediaSurfaceId,
        ownerParticipantId: participantId,
        state: {
          status: "idle",
          ownerParticipantId: participantId,
          surfaceId: createResult.surfaceId ?? selectedMediaSurfaceId,
          lastInputEventId: null
        },
        status: "active",
        revision,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now()
      } satisfies MediaObjectInstance<RemoteBrowserObjectState>);
  }
  const runtime = getRemoteBrowserRuntime(remoteBrowser.surfaceId);
  const result = await mediaSurfaceCommands.patchRemoteBrowserObject(remoteBrowser.objectId, remoteBrowser.surfaceId, revision, runtime.createOpenUrlPatch(targetUrl));
  if (!result.accepted) {
    debugState.mediaObjects.blockedReason = result.blockedReason ?? null;
    throw new Error(`remote_browser_open_rejected:${result.blockedReason ?? "unknown"}`);
  }
  runtime.clearError();
  remoteBrowserUrlInput.value = targetUrl;
  setStatus("Remote browser opening");
  syncRemoteBrowserControls();
}

async function patchRemoteBrowserControl(patch: RemoteBrowserPatch): Promise<void> {
  const object = activeRemoteBrowserObjectForSurface(selectedMediaSurfaceId) ?? findActiveRemoteBrowserObject();
  if (!object) {
    return;
  }
  const result = await mediaSurfaceCommands.patchRemoteBrowserObject(object.objectId, object.surfaceId, object.revision, patch);
  if (!result.accepted) {
    debugState.mediaObjects.blockedReason = result.blockedReason ?? null;
    throw new Error(`remote_browser_control_rejected:${result.blockedReason ?? "unknown"}`);
  }
  syncRemoteBrowserControls();
}

async function stopRemoteBrowser(): Promise<void> {
  if (!hasRoomPermission(debugState.access.permissions, "remote-browser.stop")) {
    debugState.access.lastDeniedPermission = "remote-browser.stop";
    throw createFaultError("NotAllowedError", "remote_browser_stop_forbidden");
  }
  const object = activeRemoteBrowserObjectForSurface(selectedMediaSurfaceId) ?? findActiveRemoteBrowserObject();
  if (!object) {
    return;
  }
  const result = await mediaSurfaceCommands.stopRemoteBrowserObject(object.objectId, object.surfaceId);
  if (!result.accepted) {
    debugState.mediaObjects.blockedReason = result.blockedReason ?? null;
    throw new Error(`remote_browser_stop_rejected:${result.blockedReason ?? "unknown"}`);
  }
  const entry = remoteBrowserVideoEntryForObject(object.objectId);
  if (entry) {
    detachRemoteBrowserVideoEntry(entry);
  }
  getRemoteBrowserRuntime(object.surfaceId).close();
  setStatus("Remote browser stopped");
  syncRemoteBrowserControls();
}

async function stopScreenShare(): Promise<void> {
  if (!debugState.access.canStartScreenShare) {
    debugState.access.lastDeniedPermission = "screen-share.stop";
    throw createFaultError("NotAllowedError", "screen_share_forbidden");
  }
  const activeObject = activeScreenShareObjectForSurface(selectedMediaSurfaceId) ?? findLocalActiveScreenShareObject();
  if (!activeObject || activeObject.ownerParticipantId !== participantId) {
    return;
  }
  const entry = screenShareEntryForObject(activeObject.objectId) ?? localScreenShareEntryForSurface(activeObject.surfaceId);
  if (entry) {
    entry.stopping = true;
    await unpublishScreenShareEntry(entry);
    detachScreenShareEntry(entry);
  }
  debugState.screenShareState = "stopped";
  lastScreenShareStoppedAtMs = Date.now();
  await mediaSurfaceCommands.stopScreenShareObject(activeObject.objectId, activeObject.surfaceId);
  debugState.screenShare.active = hasLocalScreenSharePublishing();
  debugState.screenShare.localPublishing = hasLocalScreenSharePublishing();
  debugState.screenShare.publishedTrackSid = null;
  startShareButton.disabled = !canUseScreenShareControl();
  stopShareButton.disabled = !canStopLocalScreenShare();
  setStatus("Screen share stopped");
  void reportDiagnostics(shareMockEnabled ? "screenshare_mock_stopped" : "screenshare_stopped");
}

async function joinAudio(): Promise<void> {
  if (!runtimeFlags.audioJoin) {
    const issue = getRuntimeIssue("livekit_failed");
    applyIssue(issue, {
      degradedMode: "presence_only",
      audioState: "disabled",
      lastRecoveryAction: "audio_join_disabled"
    });
    void reportDiagnostics("audio_join_disabled");
    return;
  }

  if (!audioMockEnabled && !browserMediaCapabilities.audioInput.supported) {
    throw createFaultError("NotSupportedError", `audio_unsupported:${browserMediaCapabilities.audioInput.reason}`);
  }

  if (faultConfig.audio === "mic_denied") {
    throw createFaultError("NotAllowedError", "mic_denied");
  }
  if (faultConfig.audio === "no_audio_device") {
    throw createFaultError("NotFoundError", "no_audio_device");
  }

  if (livekitRoom) {
    if (!microphoneEnabled) {
      if (audioMockEnabled) {
        await publishMockMicrophoneTrack(livekitRoom);
      } else {
        await livekitRoom.localParticipant.setMicrophoneEnabled(true);
      }
      microphoneEnabled = true;
      await resumeAudioContext();
      connectLocalAudioTrack(livekitRoom);
      await refreshAudioDevices(!audioMockEnabled);
      muteButton.disabled = false;
      joinAudioButton.disabled = true;
      clearAudioIssue("Audio connected");
      debugState.audioState = "connected";
      void reportDiagnostics("audio_connected");
    }
    return;
  }

  setStatus("Joining audio...");
  debugState.audioState = "joining";
  const room = await ensureMediaRoom();
  if (audioMockEnabled) {
    await publishMockMicrophoneTrack(room);
  } else {
    await room.localParticipant.setMicrophoneEnabled(true);
  }
  microphoneEnabled = true;
  await resumeAudioContext();
  connectLocalAudioTrack(room);
  await refreshAudioDevices(!audioMockEnabled);
  muteButton.disabled = false;
  joinAudioButton.disabled = true;
  startShareButton.disabled = !canUseScreenShareControl();
  syncWhiteboardControls();
  clearAudioIssue("Audio connected");
  debugState.audioState = "connected";
  void reportDiagnostics("audio_connected");
}

muteButton.addEventListener("click", async () => {
  if (!livekitRoom) {
    return;
  }
  microphoneEnabled = !microphoneEnabled;
  if (audioMockEnabled) {
    const track = mockAudioSource?.track;
    if (track) {
      track.enabled = microphoneEnabled;
    }
  } else {
    await livekitRoom.localParticipant.setMicrophoneEnabled(microphoneEnabled);
  }
  if (microphoneEnabled) {
    if (audioMockEnabled) {
      await publishMockMicrophoneTrack(livekitRoom);
    }
    await resumeAudioContext();
    connectLocalAudioTrack(livekitRoom);
  }
  muteButton.textContent = microphoneEnabled ? "Mute" : "Unmute";
  setStatus(microphoneEnabled ? "Audio live" : "Muted");
  debugState.audioState = microphoneEnabled ? "live" : "muted";
});

micSelect.addEventListener("change", () => {
  preferredMicDeviceId = micSelect.value || "default";
  localStorage.setItem("vrata.audioinput", preferredMicDeviceId);
  updateAudioDeviceStatus(`Selected microphone: ${micSelect.selectedOptions[0]?.textContent ?? "default"}`);
  if (!livekitRoom) {
    return;
  }
  const room = livekitRoom;
  void room.switchActiveDevice("audioinput", preferredMicDeviceId).then(() => {
    disconnectLocalAudioTrack();
    if (microphoneEnabled) {
      connectLocalAudioTrack(room);
    }
  }).catch((error: unknown) => {
    console.error(error);
    updateAudioDeviceStatus("Microphone switch failed");
  });
});

speakerSelect.addEventListener("change", () => {
  preferredSpeakerDeviceId = speakerSelect.value || "default";
  localStorage.setItem("vrata.audiooutput", preferredSpeakerDeviceId);
  updateAudioDeviceStatus(`Selected speaker: ${speakerSelect.selectedOptions[0]?.textContent ?? "default"}`);
  if (!livekitRoom || !supportsAudioOutputSelection()) {
    return;
  }
  void applyPreferredAudioDevices(livekitRoom).catch((error: unknown) => {
    console.error(error);
    updateAudioDeviceStatus("Speaker switch failed");
  });
});

spaceSelect.addEventListener("change", () => {
  const targetRoomLink = spaceSelect.value;
  const targetSpace = availableSpaces.find((space) => space.roomLink === targetRoomLink);
  if (!targetRoomLink || !targetSpace || targetSpace.roomId === roomId) {
    return;
  }
  window.location.assign(targetRoomLink);
});

mediaSurfaceSelect.addEventListener("change", () => {
  selectMediaSurface(mediaSurfaceSelect.value);
});

surfaceAudioCheckbox.addEventListener("change", () => {
  const enabled = surfaceAudioCheckbox.checked;
  surfaceAudioCommandPending = true;
  surfaceAudioPendingEnabled = enabled;
  syncSurfaceAudioControl();
  const surfaceId = selectedMediaSurfaceId;
  void setMediaSurfaceAudioEnabled(surfaceId, enabled).then((result) => {
    if (!result.accepted) {
      debugState.mediaObjects.blockedReason = result.blockedReason ?? null;
      surfaceAudioStatusEl.textContent = `Surface audio rejected: ${result.blockedReason ?? "unknown"}`;
    }
  }).catch((error: unknown) => {
    console.error(error);
    surfaceAudioStatusEl.textContent = "Surface audio update failed";
  }).finally(() => {
    surfaceAudioCommandPending = false;
    surfaceAudioPendingEnabled = null;
    syncSurfaceAudioControl();
  });
});

joinAudioButton.addEventListener("click", () => {
  void joinAudio().catch((error: unknown) => {
    console.error(error);
    const issue = classifyMediaError(error);
    muteButton.disabled = true;
    if (issue.code === "audio_unsupported") {
      joinAudioButton.disabled = true;
      joinAudioButton.textContent = "Audio Unsupported";
      joinAudioButton.title = `Microphone unsupported: ${describeMediaCapabilityReason(browserMediaCapabilities.audioInput.reason)}`;
    } else {
      joinAudioButton.disabled = false;
    }
    applyIssue(issue, {
      degradedMode: "audio_unavailable",
      audioState: issue.code === "audio_unsupported" ? "unsupported" : "degraded",
      lastRecoveryAction: "audio_join_failed"
    });
    void reportDiagnostics(issue.diagnosticsNote);
  });
});

startShareButton.addEventListener("click", () => {
  void startScreenShare().catch((error: unknown) => {
    console.error(error);
    const issue = classifyScreenShareError(error);
    if (issue.code === "screen_share_denied" || issue.code === "screen_share_unsupported" || issue.code === "media_network_blocked") {
      if (issue.code === "screen_share_unsupported") {
        startShareButton.disabled = true;
        startShareButton.textContent = "Share Unsupported";
        startShareButton.title = `Screen share unsupported: ${describeMediaCapabilityReason(browserMediaCapabilities.screenShare.reason)}`;
        debugState.screenShareState = "unsupported";
      } else if (issue.code === "media_network_blocked") {
        startShareButton.disabled = !canUseScreenShareControl();
        debugState.screenShareState = "media_network_blocked";
      } else {
        startShareButton.disabled = !canUseScreenShareControl();
        debugState.screenShareState = "denied";
      }
      stopShareButton.disabled = true;
      applyIssue(issue, {
        degradedMode: issue.code === "media_network_blocked" ? "media_transport_unavailable" : "screen_share_unavailable",
        lastRecoveryAction: "screen_share_failed"
      });
      void reportDiagnostics(issue.diagnosticsNote);
      return;
    }
    setStatus("Screen share failed");
    debugState.screenShareState = error instanceof Error ? error.name : "failed";
    void reportDiagnostics("screenshare_failed");
  });
});

startWhiteboardButton.addEventListener("click", () => {
  void startWhiteboard().catch((error: unknown) => {
    console.error(error);
    setStatus("Whiteboard start failed");
    const object = currentWhiteboardObject();
    const runtime = getWhiteboardRuntime(object?.surfaceId ?? selectedMediaSurfaceId);
    runtime.setError(error instanceof Error ? error.message : "failed");
    debugState.whiteboard.errorCode = runtime.createDebugSnapshot(object).errorCode;
  });
});

drawWhiteboardButton.addEventListener("click", () => {
  if (!canUseWhiteboardDrawTool()) {
    return;
  }
  whiteboardDrawToolActive = !whiteboardDrawToolActive;
  if (!whiteboardDrawToolActive) {
    cancelWhiteboardPreview();
    xrWhiteboardPointerActive = false;
    lastXrWhiteboardHit = null;
  }
  whiteboardPointerActive = false;
  syncWhiteboardControls();
  syncWhiteboardPencilVisuals(lastRuntimeFrameContext, whiteboardDrawToolActive);
});

clearWhiteboardButton.addEventListener("click", () => {
  void clearWhiteboard().catch((error: unknown) => {
    console.error(error);
    setStatus("Whiteboard clear failed");
    const object = currentWhiteboardObject();
    const runtime = getWhiteboardRuntime(object?.surfaceId ?? selectedMediaSurfaceId);
    runtime.setError(error instanceof Error ? error.message : "clear_failed");
    debugState.whiteboard.errorCode = runtime.createDebugSnapshot(object).errorCode;
  });
});

stopWhiteboardButton.addEventListener("click", () => {
  void stopWhiteboard().catch((error: unknown) => {
    console.error(error);
    setStatus("Whiteboard stop failed");
    const object = currentWhiteboardObject();
    const runtime = getWhiteboardRuntime(object?.surfaceId ?? selectedMediaSurfaceId);
    runtime.setError(error instanceof Error ? error.message : "stop_failed");
    debugState.whiteboard.errorCode = runtime.createDebugSnapshot(object).errorCode;
    syncWhiteboardControls();
  });
});

openRemoteBrowserButton.addEventListener("click", () => {
  void openRemoteBrowser(remoteBrowserUrlInput.value).catch((error: unknown) => {
    console.error(error);
    setStatus("Remote browser open failed");
    getRemoteBrowserRuntime(selectedMediaSurfaceId).setError(error instanceof Error ? error.message : "open_failed");
    syncRemoteBrowserControls();
  });
});

takeRemoteBrowserControlButton.addEventListener("click", () => {
  const object = currentRemoteBrowserObject();
  const runtime = getRemoteBrowserRuntime(object?.surfaceId ?? selectedMediaSurfaceId);
  void patchRemoteBrowserControl(runtime.createTakeControlPatch()).catch((error: unknown) => {
    console.error(error);
    setStatus("Remote browser control failed");
    runtime.setError(error instanceof Error ? error.message : "control_failed");
    syncRemoteBrowserControls();
  });
});

releaseRemoteBrowserControlButton.addEventListener("click", () => {
  const object = currentRemoteBrowserObject();
  const runtime = getRemoteBrowserRuntime(object?.surfaceId ?? selectedMediaSurfaceId);
  void patchRemoteBrowserControl(runtime.createReleaseControlPatch()).catch((error: unknown) => {
    console.error(error);
    setStatus("Remote browser release failed");
    runtime.setError(error instanceof Error ? error.message : "release_failed");
    syncRemoteBrowserControls();
  });
});

stopRemoteBrowserButton.addEventListener("click", () => {
  void stopRemoteBrowser().catch((error: unknown) => {
    console.error(error);
    setStatus("Remote browser stop failed");
    const object = currentRemoteBrowserObject();
    getRemoteBrowserRuntime(object?.surfaceId ?? selectedMediaSurfaceId).setError(error instanceof Error ? error.message : "stop_failed");
    syncRemoteBrowserControls();
  });
});

stopShareButton.addEventListener("click", () => {
  void stopScreenShare().catch((error: unknown) => {
    console.error(error);
    setStatus("Stop share failed");
    debugState.screenShareState = error instanceof Error ? error.name : "stop_failed";
    void reportDiagnostics("screenshare_stop_failed");
  });
});

window.addEventListener("keydown", (event) => {
  keyState[event.code] = true;
  if (!(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLSelectElement)) {
    commitDebugSurfaceInputFromFocusedKeyboard("key-down", event);
  }
});

window.addEventListener("keyup", (event) => {
  keyState[event.code] = false;
  if (!(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLSelectElement)) {
    commitDebugSurfaceInputFromFocusedKeyboard("key-up", event);
  }
});

renderer.domElement.addEventListener("pointerdown", (event) => {
  whiteboardPointerActive = whiteboardDrawToolActive && canUseWhiteboardDrawTool()
    ? commitDebugSurfaceInputFromPointer(event, "pointer-down")
    : false;
  const remoteBrowserHit = !whiteboardPointerActive ? resolveDebugSurfaceHitFromPointer(event.clientX, event.clientY, surfaceInputSourceFromPointer(event)) : null;
  remoteBrowserPointerActive = Boolean(remoteBrowserHit && activeRemoteBrowserObjectForSurface(remoteBrowserHit.surfaceId))
    && commitDebugSurfaceInput({
      hit: remoteBrowserHit,
      source: surfaceInputSourceFromPointer(event),
      kind: "pointer-down",
      clientTimeMs: Date.now(),
      button: surfaceInputButtonFromPointer(event.button),
      pressure: event.pressure
    });
  pointerActive = !remoteBrowserPointerActive;
  pointerMovedSinceDown = false;
  suppressPointerClick = false;
  pointerDownAtMs = performance.now();
  pointerDownClientX = event.clientX;
  pointerDownClientY = event.clientY;
});

window.addEventListener("pointerup", (event) => {
  if (remoteBrowserPointerActive) {
    commitDebugSurfaceInputFromPointer(event, "pointer-up");
    remoteBrowserPointerActive = false;
    pointerActive = false;
    pointerMovedSinceDown = false;
    suppressPointerClick = true;
    return;
  }
  if (whiteboardPointerActive) {
    const committed = commitDebugSurfaceInputFromPointer(event, "pointer-up");
    if (!committed) {
      cancelWhiteboardPreview();
    }
    whiteboardPointerActive = false;
    pointerActive = false;
    pointerMovedSinceDown = false;
    suppressPointerClick = true;
    return;
  }
  pointerActive = false;
  const pointerDistance = Math.hypot(event.clientX - pointerDownClientX, event.clientY - pointerDownClientY);
  const pointerHeldMs = performance.now() - pointerDownAtMs;
  suppressPointerClick = pointerMovedSinceDown || pointerDistance > 4 || pointerHeldMs > 250;
  pointerMovedSinceDown = false;
});

renderer.domElement.addEventListener("click", (event) => {
  if (renderer.xr.isPresenting) {
    return;
  }
  if (suppressPointerClick) {
    suppressPointerClick = false;
    return;
  }
  updatePointerNdcFromClientPosition(event.clientX, event.clientY);
  const hit = resolveDebugSurfaceHitFromPointer(event.clientX, event.clientY, "mouse");
  const activeObject = hit ? activeMediaObjectForSurface(hit.surfaceId) : null;
  const whiteboardClickCanDraw = whiteboardDrawToolActive && canUseWhiteboardDrawTool();
  const clickHandled = commitDebugSurfaceInput({
    hit,
    source: "mouse",
    kind: "click",
    clientTimeMs: Date.now(),
    button: "primary",
    routeMediaObjectInput: activeObject?.type !== WHITEBOARD_OBJECT_TYPE || whiteboardClickCanDraw
  });
  if (clickHandled && activeObject?.type === WHITEBOARD_OBJECT_TYPE && whiteboardClickCanDraw) {
    return;
  }
  pointerHoveringScene = true;
  interactionRaycaster.setFromCamera(pointerNdc, camera);
  interactionTargetPerformer.performDirectRayTarget({
    ray: interactionRaycaster.ray.clone(),
    seatMarkerHitMeshes: seatMarkerView.hitMeshes,
    seatAnchorMap: sceneSeatAnchorMap,
    raycaster: interactionRaycaster,
    seatAnchors: sceneSeatAnchors,
    teleportFloorY: sceneTeleportFloorY,
    maxDistance: 18,
    state: debugState.interactionRay,
    mode: "cursor",
    clearVisuals: clearInteractionVisuals
  });
});

renderer.domElement.addEventListener("wheel", (event) => {
  const hit = resolveDebugSurfaceHitFromPointer(event.clientX, event.clientY, "mouse");
  if (hit && activeRemoteBrowserObjectForSurface(hit.surfaceId)) {
    commitDebugSurfaceInput({
      hit,
      source: "mouse",
      kind: "scroll",
      clientTimeMs: Date.now(),
      scrollDelta: scrollDeltaFromWheelEvent(event)
    });
    event.preventDefault();
  }
}, { passive: false });

window.addEventListener("pointermove", (event) => {
  updatePointerNdcFromClientPosition(event.clientX, event.clientY);
  if (remoteBrowserPointerActive) {
    pointerMovedSinceDown = true;
    commitDebugSurfaceInputFromPointer(event, "pointer-move");
    return;
  }
  if (whiteboardPointerActive) {
    pointerMovedSinceDown = true;
    const moved = commitDebugSurfaceInputFromPointer(event, "pointer-move");
    if (!moved) {
      cancelWhiteboardPreview();
      whiteboardPointerActive = false;
    }
    return;
  }
  if (!pointerActive && commitRemoteBrowserHoverMoveFromPointer(event)) {
    return;
  }
  if (event.pointerType === "touch" || !pointerActive || renderer.xr.isPresenting) {
    return;
  }

  if (event.movementX !== 0 || event.movementY !== 0) {
    pointerMovedSinceDown = true;
  }
  localPoseController.applyPointerLookDelta({ movementX: event.movementX, movementY: event.movementY }, "desktop_move");
});

renderer.domElement.addEventListener("pointerenter", (event) => {
  pointerHoveringScene = true;
  updatePointerNdcFromClientPosition(event.clientX, event.clientY);
});

renderer.domElement.addEventListener("pointerleave", () => {
  pointerHoveringScene = false;
  clearInteractionVisuals();
});

renderer.domElement.addEventListener("touchstart", (event) => {
  if (event.touches.length === 0 || renderer.xr.isPresenting) {
    return;
  }
  const touch = event.touches[0];
  if (!touch) {
    return;
  }
  mobileTouchActive = true;
  mobileTouchIdentifier = touch.identifier;
  mobileTouchZone = resolveTouchControlZone({
    clientX: touch.clientX,
    viewportWidth: window.innerWidth
  });
  mobileTouchMovedSinceStart = false;
  mobileTouchStartClientX = touch.clientX;
  mobileTouchStartClientY = touch.clientY;
  mobileTouchLastClientX = touch.clientX;
  mobileTouchLastClientY = touch.clientY;
  mobileTouchVector.x = 0;
  mobileTouchVector.z = 0;
}, { passive: true });

renderer.domElement.addEventListener("touchmove", (event) => {
  if (!mobileTouchActive || event.touches.length === 0 || renderer.xr.isPresenting) {
    return;
  }
  const touch = Array.from(event.touches).find((candidate) => candidate.identifier === mobileTouchIdentifier) ?? event.touches[0];
  if (!touch) {
    return;
  }
  event.preventDefault();
  const totalDistance = Math.hypot(touch.clientX - mobileTouchStartClientX, touch.clientY - mobileTouchStartClientY);
  if (totalDistance > 4) {
    mobileTouchMovedSinceStart = true;
    pointerMovedSinceDown = true;
  }
  if (mobileTouchZone === "look") {
    localPoseController.applyPointerLookDelta({
      movementX: touch.clientX - mobileTouchLastClientX,
      movementY: touch.clientY - mobileTouchLastClientY
    });
    mobileTouchVector.x = 0;
    mobileTouchVector.z = 0;
  } else {
    const vector = resolveTouchDragMoveVector({
      startClientX: mobileTouchStartClientX,
      startClientY: mobileTouchStartClientY,
      clientX: touch.clientX,
      clientY: touch.clientY
    });
    mobileTouchVector.x = vector.x;
    mobileTouchVector.z = vector.z;
  }
  mobileTouchLastClientX = touch.clientX;
  mobileTouchLastClientY = touch.clientY;
}, { passive: false });

function resetMobileTouchInput(): void {
  if (mobileTouchMovedSinceStart) {
    suppressPointerClick = true;
  }
  mobileTouchActive = false;
  mobileTouchIdentifier = null;
  mobileTouchZone = null;
  mobileTouchMovedSinceStart = false;
  mobileTouchVector.x = 0;
  mobileTouchVector.z = 0;
}

renderer.domElement.addEventListener("touchend", resetMobileTouchInput);
renderer.domElement.addEventListener("touchcancel", resetMobileTouchInput);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

window.addEventListener("beforeunload", () => {
  void removePresence(apiBaseUrl, roomId, participantId, roomStateAccessToken);
  detachVideoTrack();
  for (const entry of Array.from(remoteBrowserVideoByObjectId.values())) {
    detachRemoteBrowserVideoEntry(entry);
  }
  for (const runtime of remoteBrowserRuntimes.values()) {
    runtime.close();
  }
  disconnectLocalAudioTrack();
  localAvatarController?.dispose();
  clearRoomStateReconnect();
  roomStateClient?.close();
  for (const participantId of remoteAudioNodes.keys()) {
    disconnectRemoteAudioElement(participantId);
  }
  for (const surfaceId of mediaSurfaceAudioNodes.keys()) {
    disconnectMediaSurfaceAudioTrack(surfaceId);
  }
  stopMockAudioSource();
  void livekitRoom?.disconnect();
});

const clock = new THREE.Clock();
let syncAccumulator = 0;
let presenceAccumulator = 0;
let runtimeBootReady = false;
let presenceSeq = 0;

renderer.setAnimationLoop(() => {
  const delta = clock.getDelta();
  const nowMs = Date.now();
  const frameContext = sampleRuntimeFrameContext(delta, nowMs);
  lastRuntimeFrameContext = frameContext;
  recentFrameBudgetMs.push(delta * 1000);
  if (recentFrameBudgetMs.length > 60) {
    recentFrameBudgetMs.splice(0, recentFrameBudgetMs.length - 60);
  }
  updateMovement(delta, frameContext);
  updateWhiteboardXrDrawInput(frameContext);
  applyBotPose(nowMs / 1000);
  updateLocalPresenceDiagnostics();
  updateAvatarLipsync(delta);
  updateAudioUi();
  updateMediaDiagnostics();
  updateLocalAvatar(delta, frameContext);
  remoteAvatarRuntime.update(delta, debugState);
  if (!updateRemoteBrowserXrInput(frameContext)) {
    updateInteractionRayState(getInteractionFrameInput(frameContext));
  }
  updateSeatMarkerVisuals(nowMs / 1000);
  reportXrTelemetry(frameContext);
  debugState.avatarPoseTransport.adaptivePlaybackDelayMs = debugState.remoteAvatarParticipants.length > 0
    ? Math.max(...debugState.remoteAvatarParticipants.map((participant) => participant.playbackDelayMs))
    : 100;
  updateSpatialAudio();
  syncRemoteAudioDiagnostics();
  renderDebugPanel();

  syncAccumulator += delta;
  presenceAccumulator += delta;

  if (runtimeBootReady) {
    if (syncAccumulator >= 0.08) {
      syncAccumulator = 0;
      latestMode = presenceXrMockEnabled ? "vr" : renderer.xr.isPresenting ? "vr" : /android|iphone|ipad/i.test(navigator.userAgent) ? "mobile" : "desktop";
      void syncPresence(latestMode, Boolean(livekitRoom && microphoneEnabled));
    }

    syncAvatarPoseRealtime(nowMs);

    if (presenceAccumulator >= 0.12) {
      presenceAccumulator = 0;
      void refreshPresence().catch((error: unknown) => {
        console.error(error);
        const issue = classifyRoomStateError(error);
        applyIssue(issue, {
          degradedMode: "api_fallback",
          roomStateMode: "api_fallback",
          lastRecoveryAction: "presence_refresh_failed",
          roomStateLabel: "Room-state: fallback API"
        });
        void reportDiagnostics("presence_sync_issue");
      });
    }
  }

  renderer.render(scene, camera);

  if (runtimeBootReady) {
    diagnosticsAccumulator += delta;
    if (diagnosticsAccumulator >= 2) {
      diagnosticsAccumulator = 0;
      void reportDiagnostics();
    }
  }
});

async function main(): Promise<void> {
  const boot = await bootRuntime(apiBaseUrl, roomId, navigator.userAgent, {
    participantId,
    displayName,
    requestedRole: query.get("role")
  });
  runtimeFlags = {
    enterVr: boot.envFlags.enterVr,
    audioJoin: boot.envFlags.audioJoin && boot.voiceEnabled,
    screenShare: boot.envFlags.screenShare && boot.screenShareEnabled,
    roomStateRealtime: boot.envFlags.roomStateRealtime,
    remoteDiagnostics: boot.envFlags.remoteDiagnostics,
    sceneBundles: boot.envFlags.sceneBundles,
    ...resolveAvatarRuntimeFlags(boot)
  };
  if (avatarLegIkQueryOverrideEnabled) {
    runtimeFlags.avatarLegIkEnabled = true;
  }
  debugState.featureFlags = runtimeFlags;
  roomStateAccessToken = boot.access.token;
  debugState.access = {
    ...boot.access,
    token: boot.access.token ? "[redacted]" : "",
    lastDeniedPermission: null,
    lastSurfaceCommandAccepted: null
  };
  debugState.avatarPresenceMode = runtimeFlags.avatarLegIkEnabled ? "experimental-leg-ik" : "baseline";
  debugState.roomStateUrl = boot.roomStateUrl;
  debugState.sceneBundleUrl = boot.sceneBundleUrl ?? null;
  debugState.sceneDebug.bundleUrl = boot.sceneBundleUrl ?? null;
  applyRoomShellBootState({
    boot,
    elements: {
      roomNameEl,
      brandingLineEl,
      guestAccessLineEl
    },
    floorMaterial,
    wallMaterial,
    setRoomStateStatus
  });
  latestMode = presenceXrMockEnabled ? "vr" : boot.joinMode;
  await syncPresence(boot.joinMode, false);
  await loadAvailableSpaces(boot.roomId);
  const avatarCatalogUrl = resolveAvatarCatalogUrl(boot);
  const avatarElements = {
    panelEl: avatarSandboxPanel,
    presetSelectEl: avatarPresetSelect,
    statusEl: avatarSandboxStatusEl
  };
  const avatarReset = resetAvatarSession({
    previousRegistry: avatarSandboxRegistry,
    elements: avatarElements,
    sandboxEntryPoint: avatarCatalogUrl
  });
  localAvatarController?.dispose();
  localAvatarController = null;
  avatarPresetSelect.onchange = null;
  if (!avatarSandboxEnabled) {
    avatarSandboxPanel.hidden = true;
  }
  remoteAvatarRuntime.reset(debugState);
  avatarSandboxRegistry = avatarReset.registry;
  debugState.avatarDebug = avatarReset.diagnostics;
  debugState.avatarSnapshot = null;
  debugState.avatarTransportPreview = null;
  setSceneSeatAnchors([], 0);
  sceneAnchorsReady = !boot.sceneBundleUrl;
  roomSeatOccupancy = {};
  releaseCurrentSeatLocally();
  resetAvatarPoseTransportStats();
  if (!effectiveCleanSceneMode) {
    scene.fog = new THREE.Fog(new THREE.Color(boot.theme.accentColor).getHex(), 12, 50);
  } else {
    applyCleanSceneMode(true);
  }

  try {
    connectRoomStateWithRetry(boot.roomStateUrl);
  } catch (error) {
    console.error(error);
    roomStateConnected = false;
    debugState.roomStateMode = "api_fallback";
    setRoomStateStatus("Room-state: fallback API");
    void reportDiagnostics("room_state_connect_failed");
  }

  if (avatarSandboxEnabled) {
    avatarPresetLabel.textContent = "Avatar Sandbox";
    joinAudioButton.disabled = true;
    muteButton.disabled = true;
    startShareButton.disabled = true;
    stopShareButton.disabled = true;
    setStatus("Avatar sandbox ready");
    setRoomStateStatus("Room-state: sandbox disabled");
    debugState.avatarDebug = createAvatarLoadingDiagnostics(avatarCatalogUrl);
    const sandboxResult = await startAvatarSandboxSession({
      catalogUrl: avatarCatalogUrl,
      renderer,
      scene,
      previousRegistry: avatarSandboxRegistry,
      elements: avatarElements
    });
    avatarSandboxRegistry = sandboxResult.registry;
    localPoseController.setPose({
      position: sandboxResult.position,
      yaw: sandboxResult.yaw,
      pitch: sandboxResult.pitch
    }, "spawn");
    setFallbackEnvironmentVisible(true);
    debugState.avatarDebug = sandboxResult.diagnostics;
    debugState.avatarSnapshot = null;
    debugState.avatarTransportPreview = null;
    resetAvatarPoseTransportStats();
    setAvatarSandboxStatus(avatarSandboxStatusEl, sandboxResult.statusMessage);
    await reportDiagnostics(sandboxResult.note);
    return;
  }

  if (runtimeFlags.avatarsEnabled) {
    await bootLocalAvatarPresetSession({
      catalogUrl: avatarCatalogUrl,
      preferredAvatarId: query.get("avatar") ?? undefined
    });
  }

  if (boot.sceneBundleUrl && runtimeFlags.sceneBundles) {
    const sceneResult = await startSceneBundleSession({
      scene,
      camera,
      bundleUrl: boot.sceneBundleUrl,
      requestedCleanSceneMode,
      sceneFitEnabled,
      previousSceneDebug: debugState.sceneDebug,
      applySceneMaterialDebugMode(root) {
        applySceneMaterialDebugMode(root, sceneMaterialDebugMode);
      },
      applyCleanSceneMode,
      applySceneDebugFit,
      applySpawnPoint(spawnPoint) {
        localPoseController.setPose({
          ...localPoseController.getPose(),
          position: spawnPoint.position
        }, "spawn");
        updateLocalPositionDebug();
      },
      setFallbackEnvironmentVisible
    });
    activeSceneBundleRoot = sceneResult.activeSceneBundleRoot;
    setSceneSeatAnchors(sceneResult.sceneManifest?.anchors?.seatAnchors ?? [], sceneResult.sceneManifest?.anchors?.teleportFloorY ?? 0);
    syncSeatStateFromOccupancy();
    effectiveCleanSceneMode = sceneResult.effectiveCleanSceneMode;
    debugState.sceneBundleState = sceneResult.sceneBundleState;
    debugState.sceneDebug = sceneResult.sceneDebug;
    appendBrandingSuffix(brandingLineEl, sceneResult.brandingSuffix);
    if (sceneResult.note) {
      void reportDiagnostics(sceneResult.note);
    }
  } else {
    setSceneSeatAnchors([], 0);
    syncSeatStateFromOccupancy();
  }

  applyPostBootControls({
    displayName,
    runtimeFlags: {
      audioJoin: runtimeFlags.audioJoin,
      screenShare: runtimeFlags.screenShare
    },
    canStartScreenShare: debugState.access.canStartScreenShare,
    shareMockEnabled,
    elements: {
      joinAudioButton,
      muteButton,
      startShareButton
    },
    setStatus,
    setAudioStateDisabled() {
      debugState.audioState = "disabled";
    }
  });
  syncMediaCapabilityControls();
  startShareButton.disabled = !canUseScreenShareControl();
  syncWhiteboardControls();
  stopShareButton.disabled = !canStopLocalScreenShare();

  if (browserMediaCapabilities.rtcPeerConnection && shouldStartPassiveMedia({
    audioJoin: runtimeFlags.audioJoin,
    screenShare: runtimeFlags.screenShare,
    audioFault: faultConfig.audio ?? undefined
  })) {
    void ensureMediaRoom().then(() => {
      clearAudioIssue(`Joined as ${displayName}`);
      debugState.audioState = "connected-passive";
      void reportDiagnostics("media_connected_passive");
    }).catch((error: unknown) => {
      console.error(error);
      const issue = classifyMediaError(error);
      if (runtimeUiState.issueCode === "room_state_failed") {
        runtimeUiState = applyPassiveMediaRecovery({ runtimeUiState, issue });
        debugState.audioState = runtimeUiState.audioState;
        debugState.lastRecoveryAction = runtimeUiState.lastRecoveryAction;
        void reportDiagnostics(issue.diagnosticsNote);
        return;
      }
      applyIssue(issue, {
        degradedMode: "presence_only",
        audioState: "degraded",
        lastRecoveryAction: "media_passive_connect_failed",
        updateStatus: false
      });
      void reportDiagnostics(issue.diagnosticsNote);
    });
  }

  const xrSupport = detectXrSupport({
    navigatorXr: faultConfig.xrUnavailable ? undefined : (navigator as Navigator & { xr?: unknown }).xr,
    immersiveVrSupported: !faultConfig.xrUnavailable
  });

  const vrButton = VRButton.createButton(renderer);
  vrButton.classList.add("vr-button");
  vrButton.style.position = "static";
  vrButton.style.marginTop = "10px";
  renderer.xr.addEventListener("sessionstart", () => {
    pointerActive = false;
    mobileTouchActive = false;
    mobileTouchVector.x = 0;
    mobileTouchVector.z = 0;
    pointerHoveringScene = false;
    localPoseController.setPitch(0, "xr_session_start");
    if (!getCurrentSeatId()) {
      localPoseController.alignFloorY(sceneTeleportFloorY, "xr_session_start");
    }
    clearInteractionVisuals();
  });
  renderer.xr.addEventListener("sessionend", () => {
    pointerActive = false;
    clearInteractionVisuals();
  });
  if (!getEnterVrVisibility(xrSupport, runtimeFlags.enterVr)) {
    vrButton.setAttribute("disabled", "true");
    vrButton.textContent = "VR unavailable";
    const issue = getRuntimeIssue("xr_unavailable");
    applyIssue(issue, {
      degradedMode: debugState.degradedMode === "none" ? "xr_disabled" : debugState.degradedMode,
      lastRecoveryAction: "xr_path_disabled",
      updateStatus: false
    });
  }
  document.querySelector(".controls")?.appendChild(vrButton);

  localBodyMesh = new THREE.Mesh(
    bodyGeometry,
    new THREE.MeshStandardMaterial({ color: 0xffd166, roughness: 0.45, metalness: 0.08 })
  );
  localBodyMesh.position.set(0, 0.92, 0);
  player.add(localBodyMesh);

  localHeadMesh = new THREE.Mesh(
    headGeometry,
    new THREE.MeshStandardMaterial({ color: 0xfff4d6, roughness: 0.3, metalness: 0.05 })
  );
  localHeadMesh.position.set(0, 1.58, 0);
  localHeadMesh.visible = debugEnabled;
  player.add(localHeadMesh);

  await refreshPresence();
  await reportDiagnostics("runtime_booted");
  syncAccumulator = 0;
  presenceAccumulator = 0;
  diagnosticsAccumulator = 0;
  runtimeBootReady = true;
}

void main().catch((error: unknown) => {
  console.error(error);
  setStatus("Runtime failed to boot");
  void reportDiagnostics("runtime_boot_failed");
});
