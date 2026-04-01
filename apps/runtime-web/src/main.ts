import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { Room, RoomEvent, Track } from "livekit-client";

import { bootRuntime, fetchRuntimeSpaces, listPresence, planVoiceSession, removePresence, resolveCurrentSpace, upsertPresence, type PresenceState, type RuntimeSpaceOption } from "./index.js";
import { applySnapTurn, computeKeyboardDirection, rotateFlatVector, sanitizeXrAxes, stepFlatMovement } from "./movement.js";
import { createMotionTrack, pushMotionSample, sampleMotion, type MotionTrack } from "./motion-state.js";
import { connectRoomState, sendParticipantUpdate, type RoomStateClient, type RoomStateSnapshot } from "./room-state-client.js";
import { classifyMediaError, classifyRoomStateError, createFaultError, getRuntimeIssue, shouldRetryConnection, type RuntimeIssue } from "./runtime-errors.js";
import { canRetry, createReconnectPolicy, getReconnectDelayMs } from "./reconnect.js";
import { applyRuntimeIssueState, clearRuntimeIssueState, createRuntimeUiState } from "./runtime-state.js";
import { applySpatialSettings, createSpatialAudioSettings } from "./spatial-audio.js";
import { captureCanvasDiagnostics, createEmptySceneDiagnostics, inspectSceneObject } from "./scene-debug.js";
import { loadSceneBundle } from "./scene-loader.js";
import { detectXrSupport, getEnterVrVisibility } from "./xr.js";

function fallbackUuid(): string {
  return `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getParticipantId(): string {
  const stored = localStorage.getItem("noah.participantId");
  if (stored) {
    return stored;
  }

  const generated = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : fallbackUuid();
  localStorage.setItem("noah.participantId", generated);
  return generated;
}

function mustElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`runtime_dom_missing:${selector}`);
  }
  return element;
}

const apiBaseUrl = window.location.origin;
const roomId = window.location.pathname.split("/").filter(Boolean)[1] ?? "demo-room";
const query = new URLSearchParams(window.location.search);
const debugEnabled = query.get("debug") === "1";
const sceneFitEnabled = debugEnabled && query.get("scenefit") !== "0";
const sceneMaterialDebugMode = debugEnabled ? (query.get("mat") ?? "off") : "off";
const requestedCleanSceneMode = query.get("clean") === "1";
const botMode = query.get("bot") ?? "off";
const shareMockEnabled = query.get("sharemock") === "1";
const failSpaces = query.get("failspaces") === "1";
const faultConfig = {
  audio: query.get("failaudio") as RuntimeIssue["code"] | null,
  roomState: query.get("failroomstate") === "1",
  xrUnavailable: query.get("failxr") === "1"
};
const participantId = getParticipantId();
const displayName = localStorage.getItem("noah.displayName") ?? `Guest-${participantId.slice(0, 4)}`;
localStorage.setItem("noah.displayName", displayName);

const roomNameEl = mustElement<HTMLDivElement>("#room-name");
const statusLineEl = mustElement<HTMLDivElement>("#status-line");
const brandingLineEl = mustElement<HTMLDivElement>("#branding-line");
const roomStateLineEl = mustElement<HTMLDivElement>("#room-state-line");
const guestAccessLineEl = mustElement<HTMLDivElement>("#guest-access-line");
const spaceSelect = mustElement<HTMLSelectElement>("#space-select");
const spaceSelectStatusEl = mustElement<HTMLDivElement>("#space-select-status");
const sceneHost = mustElement<HTMLDivElement>("#scene");
const joinAudioButton = mustElement<HTMLButtonElement>("#join-audio");
const muteButton = mustElement<HTMLButtonElement>("#toggle-mute");
const startShareButton = mustElement<HTMLButtonElement>("#start-share");
const stopShareButton = mustElement<HTMLButtonElement>("#stop-share");
const debugPanel = mustElement<HTMLPreElement>("#debug-panel");

if (debugEnabled) {
  debugPanel.hidden = false;
}

if (shareMockEnabled) {
  startShareButton.disabled = false;
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
player.position.set(0, 0, 6);
const pitch = new THREE.Group();
pitch.add(camera);
player.add(pitch);
scene.add(player);

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

const grid = new THREE.GridHelper(40, 40, 0x5fc8ff, 0x31587f);
grid.position.y = 0.01;
scene.add(grid);

const wallMaterial = new THREE.MeshBasicMaterial({ color: 0x244266, wireframe: true, transparent: true, opacity: 0.35 });
const roomBox = new THREE.Mesh(new THREE.BoxGeometry(14, 5, 14), wallMaterial);
roomBox.position.set(0, 2.5, 0);
scene.add(roomBox);

const displaySurface = new THREE.Mesh(
  new THREE.PlaneGeometry(5.8, 3.3),
  new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
);
displaySurface.position.set(0, 2.2, -6.6);
scene.add(displaySurface);

const fallbackEnvironment: THREE.Object3D[] = [floor, grid, roomBox, displaySurface];

const bodyGeometry = new THREE.CapsuleGeometry(0.24, 0.8, 6, 12);
const headGeometry = new THREE.SphereGeometry(0.18, 20, 20);

interface RemoteAvatarEntity {
  body: THREE.Mesh;
  head: THREE.Mesh;
}

interface RemoteAvatarMotion {
  root: MotionTrack;
  body: MotionTrack;
  head: MotionTrack;
}

const remoteAvatars = new Map<string, RemoteAvatarEntity>();
const remoteMotionTracks = new Map<string, RemoteAvatarMotion>();

const keyState: Record<string, boolean> = {};
let pointerActive = false;
let yaw = 0;
let pitchAngle = 0;
let livekitRoom: Room | null = null;
let microphoneEnabled = false;
let xrTurnCooldown = 0;
let mobileTouchActive = false;
const mobileTouchVector = { x: 0, z: 0 };
let diagnosticsAccumulator = 0;
let latestMode: PresenceState["mode"] = /android|iphone|ipad/i.test(navigator.userAgent) ? "mobile" : "desktop";
let activeScreenShareTrack: Track | null = null;
let activeScreenShareElement: HTMLVideoElement | null = null;
let isScreenSharing = false;
let activeMockScreenShareStream: MediaStream | null = null;
let mediaRoomReady = false;
let roomStateClient: RoomStateClient | null = null;
let roomStateConnected = false;
let roomStateReconnectTimer: number | null = null;
let audioContext: AudioContext | null = null;
let activeSceneBundleRoot: THREE.Object3D | null = null;
const roomStateReconnectPolicy = createReconnectPolicy({
  maxRetries: Number.parseInt(query.get("roomstateretries") ?? "3", 10),
  baseDelayMs: Number.parseInt(query.get("roomstatedelay") ?? "1000", 10),
  maxDelayMs: Number.parseInt(query.get("roomstatemaxdelay") ?? "8000", 10)
});

interface RemoteAudioNode {
  participantId: string;
  element: HTMLMediaElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  panner: PannerNode;
}

const remoteAudioNodes = new Map<string, RemoteAudioNode>();
let runtimeUiState = createRuntimeUiState();
let runtimeFlags = {
  enterVr: true,
  audioJoin: true,
  screenShare: true,
  roomStateRealtime: true,
  remoteDiagnostics: true,
  sceneBundles: true
};
let effectiveCleanSceneMode = requestedCleanSceneMode;
let availableSpaces: RuntimeSpaceOption[] = [];

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
  displaySurface.visible = true;
}

function applySceneDebugFit(bounds: NonNullable<typeof debugState.sceneDebug.boundingBox>): void {
  const horizontalSize = Math.max(bounds.size.x, bounds.size.z, 1);
  const distance = Math.max(horizontalSize * 0.65, 12);
  const targetY = bounds.center.y;
  player.position.set(bounds.center.x, targetY, bounds.center.z + distance);

  const cameraWorld = new THREE.Vector3();
  camera.getWorldPosition(cameraWorld);
  const target = new THREE.Vector3(bounds.center.x, bounds.center.y, bounds.center.z);
  const delta = target.sub(cameraWorld);
  yaw = Math.atan2(delta.x, delta.z) + Math.PI;
  const horizontalDistance = Math.max(0.001, Math.hypot(delta.x, delta.z));
  pitchAngle = THREE.MathUtils.clamp(-Math.atan2(delta.y, horizontalDistance), -1.1, 1.1);
  player.rotation.y = yaw;
  pitch.rotation.x = pitchAngle;
  debugState.localPosition = {
    x: Number(player.position.x.toFixed(2)),
    z: Number(player.position.z.toFixed(2))
  };
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

function getPresenceCaptureTime(updatedAt: string | undefined, fallbackNow: number): number {
  const parsed = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallbackNow;
}

function applySnapshotParticipants(people: PresenceState[]): void {
  const activeIds = new Set<string>();

  for (const person of people) {
    if (person.participantId === participantId) {
      continue;
    }

    activeIds.add(person.participantId);
    const entity = ensureRemoteAvatar(person);
    const bodyMaterial = entity.body.material;
    if (bodyMaterial instanceof THREE.MeshStandardMaterial) {
      bodyMaterial.color.setHex(person.activeMedia.audio ? 0x5fc8ff : 0xbfd8ee);
    }
    const current = remoteMotionTracks.get(person.participantId) ?? {
      root: createMotionTrack(),
      body: createMotionTrack(),
      head: createMotionTrack()
    };
    const capturedAtMs = getPresenceCaptureTime(person.updatedAt, Date.now());
    remoteMotionTracks.set(person.participantId, {
      root: pushMotionSample(current.root, {
        x: person.rootTransform.x,
        z: person.rootTransform.z,
        capturedAtMs
      }),
      body: pushMotionSample(current.body, {
        x: person.bodyTransform?.x ?? person.rootTransform.x,
        z: person.bodyTransform?.z ?? person.rootTransform.z,
        capturedAtMs
      }),
      head: pushMotionSample(current.head, {
        x: person.headTransform?.x ?? person.rootTransform.x,
        z: person.headTransform?.z ?? person.rootTransform.z,
        capturedAtMs
      })
    });
    if (entity.body.position.lengthSq() === 0) {
      entity.body.position.set(person.bodyTransform?.x ?? person.rootTransform.x, 0.92, person.bodyTransform?.z ?? person.rootTransform.z);
      entity.head.position.set(person.headTransform?.x ?? person.rootTransform.x, 1.58, person.headTransform?.z ?? person.rootTransform.z);
    }
  }

  pruneRemoteAvatars(activeIds);
  debugState.remoteAvatarCount = remoteAvatars.size;
  debugState.lastPresenceRefreshAt = Date.now();
}

function applyDisplayTexture(texture: THREE.Texture | null): void {
  const material = displaySurface.material;
  if (!(material instanceof THREE.MeshBasicMaterial)) {
    return;
  }
  if (material.map) {
    material.map.dispose();
  }
  material.color.setHex(0xffffff);
  material.map = texture;
  material.needsUpdate = true;
}

function ensureAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

function connectRemoteAudioElement(element: HTMLMediaElement, participantId: string): void {
  if (remoteAudioNodes.has(participantId)) {
    return;
  }
  const context = ensureAudioContext();
  const source = context.createMediaElementSource(element);
  const gain = context.createGain();
  const panner = context.createPanner();
  applySpatialSettings(panner, createSpatialAudioSettings());
  source.connect(gain);
  gain.connect(panner);
  panner.connect(context.destination);
  remoteAudioNodes.set(participantId, { participantId, element, source, gain, panner });
  debugState.spatialAudioState = "active";
}

function disconnectRemoteAudioElement(participantId: string): void {
  const node = remoteAudioNodes.get(participantId);
  if (!node) {
    return;
  }
  node.source.disconnect();
  node.gain.disconnect();
  node.panner.disconnect();
  remoteAudioNodes.delete(participantId);
  if (remoteAudioNodes.size === 0) {
    debugState.spatialAudioState = "idle";
  }
}

function updateSpatialAudio(): void {
  if (!audioContext) {
    return;
  }
  const listener = audioContext.listener;
  const listenerPosition = new THREE.Vector3();
  camera.getWorldPosition(listenerPosition);
  listener.positionX.value = listenerPosition.x;
  listener.positionY.value = listenerPosition.y;
  listener.positionZ.value = listenerPosition.z;

  for (const [participantId, node] of remoteAudioNodes.entries()) {
    const entity = remoteAvatars.get(participantId);
    const target = entity?.head.position ?? entity?.body.position;
    if (!target) {
      continue;
    }
    node.panner.positionX.value = target.x;
    node.panner.positionY.value = target.y;
    node.panner.positionZ.value = target.z;
  }
}

const debugState = {
  participantId,
  remoteAvatarCount: 0,
  statusLine: "Connecting...",
  locomotionMode: "desktop",
  roomStateConnected: false,
  roomStateUrl: "",
  roomStateMode: "connecting",
  audioState: "idle",
  screenShareState: "idle",
  spatialAudioState: "idle",
  localPosition: { x: 0, z: 6 },
  xrAxes: { moveX: 0, moveY: 0, turnX: 0 },
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
  sceneBundleUrl: null as string | null,
  sceneBundleState: "fallback" as "fallback" | "loaded" | "failed",
  sceneDebug: createEmptySceneDiagnostics(),
  spaceSelectorState: "loading" as "loading" | "ready" | "empty" | "unavailable",
  availableSpaceCount: 0
};

const floorMaterial = floor.material as THREE.MeshStandardMaterial;

(window as Window & { __NOAH_DEBUG__?: typeof debugState }).__NOAH_DEBUG__ = debugState;

function setStatus(message: string): void {
  statusLineEl.textContent = message;
  debugState.statusLine = message;
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
  if (runtimeUiState.issueCode === "mic_denied" || runtimeUiState.issueCode === "no_audio_device" || runtimeUiState.issueCode === "livekit_failed") {
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

function connectRoomStateWithRetry(roomStateUrl: string): void {
  clearRoomStateReconnect();
  debugState.roomStateMode = "connecting";
  setRoomStateStatus("Room-state: connecting");

  if (!runtimeFlags.roomStateRealtime || faultConfig.roomState) {
    const issue = getRuntimeIssue("room_state_failed");
    roomStateConnected = false;
    debugState.roomStateConnected = false;
    applyIssue(issue, {
      degradedMode: "api_fallback",
      roomStateMode: "fallback",
      lastRecoveryAction: "fallback_api",
      roomStateLabel: "Room-state: fallback API"
    });
    void reportDiagnostics(issue.diagnosticsNote);
    return;
  }

  roomStateClient = connectRoomState(roomStateUrl, roomId, participantId, {
    onOpen: () => {
      roomStateConnected = true;
      debugState.roomStateConnected = true;
      debugState.roomStateMode = "connected";
      setRoomStateStatus("Room-state: connected");
      if (runtimeUiState.issueCode === "room_state_failed") {
        clearIssue(debugState.audioState === "connected-passive" ? `Joined as ${displayName}` : debugState.statusLine);
      }
      void reportDiagnostics("room_state_connected");
    },
    onRoomState: (snapshot: RoomStateSnapshot) => {
      roomStateConnected = true;
      debugState.roomStateConnected = true;
      debugState.roomStateMode = "connected";
      applySnapshotParticipants(snapshot.participants);
    },
    onError: (error: unknown) => {
      console.error(error);
      const issue = classifyRoomStateError(error);
      roomStateConnected = false;
      debugState.roomStateConnected = false;
      applyIssue(issue, {
        degradedMode: "api_fallback",
        roomStateMode: "fallback",
        lastRecoveryAction: "fallback_api",
        roomStateLabel: "Room-state: fallback API"
      });
      void reportDiagnostics(issue.diagnosticsNote);
    },
    onClose: () => {
      const issue = getRuntimeIssue("room_state_failed");
      roomStateConnected = false;
      debugState.roomStateConnected = false;
      applyIssue(issue, {
        degradedMode: "api_fallback",
        roomStateMode: "reconnecting",
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
        roomStateMode: "fallback",
        lastRecoveryAction: "room_state_retry_exhausted",
        roomStateLabel: "Room-state: fallback API"
      });
    }
  });
}

function renderDebugPanel(): void {
  if (!debugEnabled) {
    return;
  }

  debugPanel.textContent = JSON.stringify(debugState, null, 2);
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

async function reportDiagnostics(note?: string): Promise<void> {
  if (!runtimeFlags.remoteDiagnostics) {
    return;
  }
  if (activeSceneBundleRoot) {
    debugState.sceneDebug = inspectSceneObject({
      root: activeSceneBundleRoot,
      camera,
      previous: debugState.sceneDebug
    });
  }
  const includeImage = debugEnabled;
  const screenshot = captureCanvasDiagnostics({
    canvas: renderer.domElement,
    includeImage
  });
  debugState.sceneDebug.screenshot = screenshot;
  await fetch(new URL(`/api/rooms/${roomId}/diagnostics`, apiBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      participantId,
      displayName,
      mode: latestMode,
      userAgent: navigator.userAgent,
      locomotionMode: debugState.locomotionMode,
      audioState: debugState.audioState,
      screenShareState: debugState.screenShareState,
      localPosition: debugState.localPosition,
      xrAxes: debugState.xrAxes,
      remoteAvatarCount: debugState.remoteAvatarCount,
      remoteTargets: debugState.remoteTargets,
      issueCode: debugState.issueCode,
      issueSeverity: debugState.issueSeverity,
      degradedMode: debugState.degradedMode,
      retryCount: debugState.retryCount,
      lastRecoveryAction: debugState.lastRecoveryAction,
      lastPresenceSyncAt: debugState.lastPresenceSyncAt,
      lastPresenceRefreshAt: debugState.lastPresenceRefreshAt,
      featureFlags: debugState.featureFlags,
      faultInjection: debugState.faultInjection,
      sceneDebug: {
        ...debugState.sceneDebug,
        missingAssetCount: debugState.sceneDebug.missingAssets.length,
        screenshot
      },
      note,
      createdAt: new Date().toISOString()
    })
  });
}

function attachVideoTrack(track: Track): void {
  const element = track.attach() as HTMLVideoElement;
  element.autoplay = true;
  element.muted = true;
  element.playsInline = true;
  element.style.display = "none";
  document.body.appendChild(element);

  const texture = new THREE.VideoTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  applyDisplayTexture(texture);

  activeScreenShareTrack = track;
  activeScreenShareElement = element;
  debugState.screenShareState = "receiving";
}

function attachMockVideoStream(stream: MediaStream): void {
  const element = document.createElement("video");
  element.autoplay = true;
  element.muted = true;
  element.playsInline = true;
  element.style.display = "none";
  element.srcObject = stream;
  document.body.appendChild(element);

  const texture = new THREE.VideoTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  applyDisplayTexture(texture);

  activeScreenShareElement = element;
  debugState.screenShareState = "receiving";
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

function detachVideoTrack(): void {
  if (activeScreenShareTrack) {
    activeScreenShareTrack.detach().forEach((element) => element.remove());
    activeScreenShareTrack = null;
  }
  if (activeScreenShareElement) {
    activeScreenShareElement.remove();
    activeScreenShareElement = null;
  }
  applyDisplayTexture(null);
  debugState.screenShareState = "idle";
}

async function ensureMediaRoom(): Promise<Room> {
  if (livekitRoom) {
    return livekitRoom;
  }

  if (faultConfig.audio === "livekit_failed") {
    throw createFaultError("FaultInjectedError", "livekit_failed");
  }

  const voicePlan = await planVoiceSession(apiBaseUrl, roomId, participantId);
  const room = new Room();
  setupAudio(room);
  await room.connect(voicePlan.livekitUrl, voicePlan.token);
  livekitRoom = room;
  mediaRoomReady = true;
  startShareButton.disabled = false;
  return room;
}

function makeBody(color: number): THREE.Mesh {
  return new THREE.Mesh(
    bodyGeometry,
    new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.08 })
  );
}

function makeHead(color: number): THREE.Mesh {
  return new THREE.Mesh(
    headGeometry,
    new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.05 })
  );
}

function ensureRemoteAvatar(participant: PresenceState): RemoteAvatarEntity {
  let entity = remoteAvatars.get(participant.participantId);
  if (!entity) {
    const body = makeBody(participant.activeMedia.audio ? 0x5fc8ff : 0xbfd8ee);
    const head = makeHead(0xf6fbff);
    scene.add(body);
    scene.add(head);
    entity = { body, head };
    remoteAvatars.set(participant.participantId, entity);
    remoteMotionTracks.set(
      participant.participantId,
      {
        root: pushMotionSample(createMotionTrack(), {
          x: participant.rootTransform.x,
          z: participant.rootTransform.z,
          capturedAtMs: getPresenceCaptureTime(participant.updatedAt, Date.now())
        }),
        body: pushMotionSample(createMotionTrack(), {
          x: participant.bodyTransform?.x ?? participant.rootTransform.x,
          z: participant.bodyTransform?.z ?? participant.rootTransform.z,
          capturedAtMs: getPresenceCaptureTime(participant.updatedAt, Date.now())
        }),
        head: pushMotionSample(createMotionTrack(), {
          x: participant.headTransform?.x ?? participant.rootTransform.x,
          z: participant.headTransform?.z ?? participant.rootTransform.z,
          capturedAtMs: getPresenceCaptureTime(participant.updatedAt, Date.now())
        })
      }
    );
  }
  return entity;
}

function pruneRemoteAvatars(currentIds: Set<string>): void {
  for (const [id, mesh] of remoteAvatars.entries()) {
    if (!currentIds.has(id)) {
      scene.remove(mesh.body);
      scene.remove(mesh.head);
      remoteAvatars.delete(id);
      remoteMotionTracks.delete(id);
    }
  }
  debugState.remoteAvatarCount = remoteAvatars.size;
}

function updateRemoteAvatarInterpolation(delta: number): void {
  const renderAtMs = Date.now() - 120;
  for (const [participantId, entity] of remoteAvatars.entries()) {
    const tracks = remoteMotionTracks.get(participantId);
    if (!tracks) {
      continue;
    }
    const rootSample = sampleMotion(tracks.root, renderAtMs);
    const bodySample = sampleMotion(tracks.body, renderAtMs);
    const headSample = sampleMotion(tracks.head, renderAtMs);
    if (!rootSample || !bodySample || !headSample) {
      continue;
    }
    entity.body.position.set(bodySample.x, 0.92, bodySample.z);
    entity.head.position.set(headSample.x, 1.58, headSample.z);
    entity.body.lookAt(headSample.x, 0.92, headSample.z);
  }
  debugState.remoteTargets = Array.from(remoteMotionTracks.entries()).map(([id, track]) => {
    const latest = track.root.samples[track.root.samples.length - 1];
    return {
      id,
      x: Number((latest?.x ?? 0).toFixed(2)),
      z: Number((latest?.z ?? 0).toFixed(2))
    };
  });
}

function botDirection(timeSeconds: number): { x: number; z: number } {
  if (botMode === "orbit") {
    return {
      x: Math.sin(timeSeconds * 0.8),
      z: Math.cos(timeSeconds * 0.8)
    };
  }

  if (botMode === "line") {
    return {
      x: 0,
      z: Math.sin(timeSeconds * 0.7)
    };
  }

  return { x: 0, z: 0 };
}

function updateMovement(delta: number): void {
  const speed = renderer.xr.isPresenting ? 2.4 : keyState.ShiftLeft ? 5 : 3.2;
  let direction = computeKeyboardDirection(keyState);

  if (botMode !== "off" && !renderer.xr.isPresenting) {
    direction = botDirection(performance.now() / 1000);
    debugState.locomotionMode = `bot:${botMode}`;
  }

  if (!renderer.xr.isPresenting && mobileTouchActive && botMode === "off") {
    direction = {
      x: direction.x + mobileTouchVector.x,
      z: direction.z + mobileTouchVector.z
    };
    debugState.locomotionMode = "mobile-touch";
  } else if (!renderer.xr.isPresenting) {
    debugState.locomotionMode = "desktop";
  }

  if (renderer.xr.isPresenting) {
    const xrFrame = renderer.xr.getFrame();
    const session = xrFrame?.session;
    let xrAxes = { moveX: 0, moveY: 0, turnX: 0 };
    let fallbackMoveAssigned = false;
    let fallbackTurnAssigned = false;

    for (const input of session?.inputSources ?? []) {
      const axes = input.gamepad?.axes ?? [];
      if (input.handedness === "left") {
        xrAxes.moveX = axes[2] ?? axes[0] ?? xrAxes.moveX;
        xrAxes.moveY = axes[3] ?? axes[1] ?? xrAxes.moveY;
        fallbackMoveAssigned = true;
      }
      if (input.handedness === "right") {
        xrAxes.turnX = axes[2] ?? axes[0] ?? xrAxes.turnX;
        fallbackTurnAssigned = true;
      }
      if (!fallbackMoveAssigned && axes.length >= 2) {
        xrAxes.moveX = axes[2] ?? axes[0] ?? xrAxes.moveX;
        xrAxes.moveY = axes[3] ?? axes[1] ?? xrAxes.moveY;
        fallbackMoveAssigned = true;
        continue;
      }
      if (!fallbackTurnAssigned && axes.length >= 2) {
        xrAxes.turnX = axes[2] ?? axes[0] ?? xrAxes.turnX;
        fallbackTurnAssigned = true;
      }
    }

    const sanitized = sanitizeXrAxes(xrAxes);
    debugState.xrAxes = sanitized;
    direction = {
      x: sanitized.moveX,
      z: sanitized.moveY
    };

    const turn = applySnapTurn({ angle: yaw, cooldownSeconds: xrTurnCooldown }, sanitized.turnX, delta);
    yaw = turn.angle;
    xrTurnCooldown = turn.cooldownSeconds;
    debugState.locomotionMode = "vr";
  }

  if (direction.x !== 0 || direction.z !== 0) {
    const rotatedDirection = rotateFlatVector(direction, yaw);
    const next = stepFlatMovement({ x: player.position.x, z: player.position.z }, rotatedDirection, speed, delta);
    player.position.x = next.x;
    player.position.z = next.z;
  }

  player.rotation.y = yaw;
  pitch.rotation.x = pitchAngle;
  debugState.localPosition = {
    x: Number(player.position.x.toFixed(2)),
    z: Number(player.position.z.toFixed(2))
  };
}

async function syncPresence(mode: PresenceState["mode"], audioActive: boolean): Promise<void> {
  const worldPosition = new THREE.Vector3();
  camera.getWorldPosition(worldPosition);
  const bodyXZ = deriveBodyTransform(
    { x: player.position.x, z: player.position.z },
    { x: worldPosition.x, z: worldPosition.z }
  );

  const presencePayload: PresenceState = {
    participantId,
    displayName,
    mode,
    rootTransform: {
      x: player.position.x,
      y: player.position.y,
      z: player.position.z
    },
    bodyTransform: {
      x: bodyXZ.x,
      y: 0.92,
      z: bodyXZ.z
    },
    headTransform: {
      x: worldPosition.x,
      y: worldPosition.y,
      z: worldPosition.z
    },
    muted: !microphoneEnabled,
    activeMedia: {
      audio: audioActive,
      screenShare: isScreenSharing
    },
    updatedAt: new Date().toISOString()
  };

  if (roomStateClient && roomStateConnected) {
    sendParticipantUpdate(roomStateClient, presencePayload);
  } else {
    await upsertPresence(apiBaseUrl, roomId, presencePayload);
  }
  debugState.lastPresenceSyncAt = Date.now();
}

async function refreshPresence(): Promise<void> {
  if (roomStateConnected) {
    debugState.lastPresenceRefreshAt = Date.now();
    return;
  }
  const people = await listPresence(apiBaseUrl, roomId);
  applySnapshotParticipants(people);
}

function setupAudio(room: Room): void {
  room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (track.kind === Track.Kind.Video) {
      attachVideoTrack(track);
      return;
    }
    if (track.kind !== Track.Kind.Audio) return;
    const element = track.attach();
    element.autoplay = true;
    element.style.display = "none";
    document.body.appendChild(element);
    if (participant?.identity) {
      connectRemoteAudioElement(element as HTMLMediaElement, participant.identity);
    }
    debugState.audioState = "remote-track";
  });

  room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
    if (track.kind === Track.Kind.Video) {
      detachVideoTrack();
      return;
    }
    if (track.kind !== Track.Kind.Audio) return;
    if (participant?.identity) {
      disconnectRemoteAudioElement(participant.identity);
    }
    track.detach().forEach((element) => element.remove());
  });
}

async function startScreenShare(): Promise<void> {
  if (startShareButton.disabled) {
    return;
  }
  if (isScreenSharing) {
    return;
  }
  if (shareMockEnabled) {
    activeMockScreenShareStream = createMockShareStream();
    attachMockVideoStream(activeMockScreenShareStream);
    isScreenSharing = true;
    debugState.screenShareState = "sharing";
    startShareButton.disabled = true;
    stopShareButton.disabled = false;
    setStatus("Sharing screen");
    void reportDiagnostics("screenshare_mock_started");
    return;
  }
  const room = await ensureMediaRoom();
  debugState.screenShareState = "starting";
  await room.localParticipant.setScreenShareEnabled(true, {
    audio: false
  });
  const publication = Array.from(room.localParticipant.trackPublications.values()).find((item) => item.source === Track.Source.ScreenShare);
  const localTrack = publication?.videoTrack;
  if (localTrack) {
    attachVideoTrack(localTrack);
  }
  isScreenSharing = true;
  debugState.screenShareState = "sharing";
  startShareButton.disabled = true;
  stopShareButton.disabled = false;
  setStatus("Sharing screen");
  void reportDiagnostics("screenshare_started");
}

async function stopScreenShare(): Promise<void> {
  if (shareMockEnabled) {
    activeMockScreenShareStream?.getTracks().forEach((track) => track.stop());
    activeMockScreenShareStream = null;
    isScreenSharing = false;
    detachVideoTrack();
    debugState.screenShareState = "stopped";
    startShareButton.disabled = false;
    stopShareButton.disabled = true;
    setStatus("Screen share stopped");
    void reportDiagnostics("screenshare_mock_stopped");
    return;
  }
  if (!livekitRoom) return;
  await livekitRoom.localParticipant.setScreenShareEnabled(false);
  isScreenSharing = false;
  debugState.screenShareState = "stopped";
  startShareButton.disabled = false;
  stopShareButton.disabled = true;
  setStatus("Screen share stopped");
  void reportDiagnostics("screenshare_stopped");
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

  if (faultConfig.audio === "mic_denied") {
    throw createFaultError("NotAllowedError", "mic_denied");
  }
  if (faultConfig.audio === "no_audio_device") {
    throw createFaultError("NotFoundError", "no_audio_device");
  }

  if (livekitRoom) {
    if (!microphoneEnabled) {
      await livekitRoom.localParticipant.setMicrophoneEnabled(true);
      microphoneEnabled = true;
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
  await room.localParticipant.setMicrophoneEnabled(true);
  microphoneEnabled = true;
  muteButton.disabled = false;
  joinAudioButton.disabled = true;
  startShareButton.disabled = false;
  clearAudioIssue("Audio connected");
  debugState.audioState = "connected";
  void reportDiagnostics("audio_connected");
}

muteButton.addEventListener("click", async () => {
  if (!livekitRoom) {
    return;
  }
  microphoneEnabled = !microphoneEnabled;
  await livekitRoom.localParticipant.setMicrophoneEnabled(microphoneEnabled);
  muteButton.textContent = microphoneEnabled ? "Mute" : "Unmute";
  setStatus(microphoneEnabled ? "Audio live" : "Muted");
  debugState.audioState = microphoneEnabled ? "live" : "muted";
});

spaceSelect.addEventListener("change", () => {
  const targetRoomLink = spaceSelect.value;
  const targetSpace = availableSpaces.find((space) => space.roomLink === targetRoomLink);
  if (!targetRoomLink || !targetSpace || targetSpace.roomId === roomId) {
    return;
  }
  window.location.assign(targetRoomLink);
});

joinAudioButton.addEventListener("click", () => {
  void joinAudio().catch((error: unknown) => {
    console.error(error);
    const issue = classifyMediaError(error);
    muteButton.disabled = true;
    joinAudioButton.disabled = false;
    applyIssue(issue, {
      degradedMode: "audio_unavailable",
      audioState: "degraded",
      lastRecoveryAction: "audio_join_failed"
    });
    void reportDiagnostics(issue.diagnosticsNote);
  });
});

startShareButton.addEventListener("click", () => {
  void startScreenShare().catch((error: unknown) => {
    console.error(error);
    setStatus("Screen share failed");
    debugState.screenShareState = error instanceof Error ? error.name : "failed";
    void reportDiagnostics("screenshare_failed");
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
});

window.addEventListener("keyup", (event) => {
  keyState[event.code] = false;
});

renderer.domElement.addEventListener("pointerdown", () => {
  pointerActive = true;
});

window.addEventListener("pointerup", () => {
  pointerActive = false;
});

window.addEventListener("pointermove", (event) => {
  if (!pointerActive || renderer.xr.isPresenting) {
    return;
  }

  yaw -= event.movementX * 0.003;
  pitchAngle = THREE.MathUtils.clamp(pitchAngle - event.movementY * 0.003, -1.1, 1.1);
});

renderer.domElement.addEventListener("touchstart", (event) => {
  if (event.touches.length === 0 || renderer.xr.isPresenting) {
    return;
  }
  mobileTouchActive = true;
});

renderer.domElement.addEventListener("touchmove", (event) => {
  if (!mobileTouchActive || event.touches.length === 0 || renderer.xr.isPresenting) {
    return;
  }
  const touch = event.touches[0];
  const x = (touch.clientX / window.innerWidth) * 2 - 1;
  const y = (touch.clientY / window.innerHeight) * 2 - 1;
  mobileTouchVector.x = THREE.MathUtils.clamp(x, -1, 1);
  mobileTouchVector.z = THREE.MathUtils.clamp(y, -1, 1);
});

renderer.domElement.addEventListener("touchend", () => {
  mobileTouchActive = false;
  mobileTouchVector.x = 0;
  mobileTouchVector.z = 0;
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

window.addEventListener("beforeunload", () => {
  void removePresence(apiBaseUrl, roomId, participantId);
  detachVideoTrack();
  clearRoomStateReconnect();
  roomStateClient?.close();
  for (const participantId of remoteAudioNodes.keys()) {
    disconnectRemoteAudioElement(participantId);
  }
  void livekitRoom?.disconnect();
});

const clock = new THREE.Clock();
let syncAccumulator = 0;
let presenceAccumulator = 0;

renderer.setAnimationLoop(() => {
  const delta = clock.getDelta();
  updateMovement(delta);
  updateRemoteAvatarInterpolation(delta);
  updateSpatialAudio();
  renderDebugPanel();

  syncAccumulator += delta;
  presenceAccumulator += delta;

  if (syncAccumulator >= 0.08) {
    syncAccumulator = 0;
    latestMode = renderer.xr.isPresenting ? "vr" : /android|iphone|ipad/i.test(navigator.userAgent) ? "mobile" : "desktop";
    void syncPresence(latestMode, Boolean(livekitRoom));
  }

  if (presenceAccumulator >= 0.12) {
    presenceAccumulator = 0;
    void refreshPresence().catch((error: unknown) => {
      console.error(error);
      const issue = classifyRoomStateError(error);
      applyIssue(issue, {
        degradedMode: "api_fallback",
        roomStateMode: "fallback",
        lastRecoveryAction: "presence_refresh_failed",
        roomStateLabel: "Room-state: fallback API"
      });
      void reportDiagnostics("presence_sync_issue");
    });
  }

  renderer.render(scene, camera);

  diagnosticsAccumulator += delta;
  if (diagnosticsAccumulator >= 2) {
    diagnosticsAccumulator = 0;
    void reportDiagnostics();
  }
});

async function main(): Promise<void> {
  const boot = await bootRuntime(apiBaseUrl, roomId, navigator.userAgent);
  runtimeFlags = {
    enterVr: boot.envFlags.enterVr,
    audioJoin: boot.envFlags.audioJoin && boot.voiceEnabled,
    screenShare: boot.envFlags.screenShare && boot.screenShareEnabled,
    roomStateRealtime: boot.envFlags.roomStateRealtime,
    remoteDiagnostics: boot.envFlags.remoteDiagnostics,
    sceneBundles: boot.envFlags.sceneBundles
  };
  debugState.featureFlags = runtimeFlags;
  debugState.roomStateUrl = boot.roomStateUrl;
  debugState.sceneBundleUrl = boot.sceneBundleUrl ?? null;
  debugState.sceneDebug.bundleUrl = boot.sceneBundleUrl ?? null;
  setRoomStateStatus(`Room-state: connecting`);
  roomNameEl.textContent = `${boot.template} - ${boot.roomId}`;
  brandingLineEl.textContent = boot.assets.length > 0
    ? `Attached assets: ${boot.assets.map((asset) => `${asset.kind}${asset.validationStatus ? ` [${asset.validationStatus}]` : ""}`).join(", ")}`
    : "No branded assets attached";
  guestAccessLineEl.textContent = boot.guestAllowed ? "Guest access: enabled" : "Guest access: members only";
  await loadAvailableSpaces(boot.roomId);
  floorMaterial.color.set(boot.theme.accentColor);
  wallMaterial.color.set(boot.theme.primaryColor);
  if (!effectiveCleanSceneMode) {
    scene.fog = new THREE.Fog(new THREE.Color(boot.theme.accentColor).getHex(), 12, 50);
  } else {
    applyCleanSceneMode(true);
  }

  if (boot.sceneBundleUrl && runtimeFlags.sceneBundles) {
    try {
      const loadedScene = await loadSceneBundle({
        scene,
        player,
        bundleUrl: boot.sceneBundleUrl
      });
      activeSceneBundleRoot = loadedScene.group;
      effectiveCleanSceneMode = requestedCleanSceneMode || loadedScene.manifest.renderMode === "clean";
      applySceneMaterialDebugMode(loadedScene.group, sceneMaterialDebugMode);
      setFallbackEnvironmentVisible(false);
      if (effectiveCleanSceneMode) {
        applyCleanSceneMode(true);
      }
      debugState.sceneBundleState = "loaded";
      debugState.sceneDebug = inspectSceneObject({
        root: loadedScene.group,
        camera,
        previous: {
          ...debugState.sceneDebug,
          bundleUrl: boot.sceneBundleUrl,
          state: "loaded",
          label: loadedScene.manifest.label,
          source: loadedScene.manifest.source,
          assetUrl: loadedScene.assetUrl,
          assetType: loadedScene.assetType,
          spawnPointId: loadedScene.spawnPointId,
          spawnApplied: loadedScene.spawnPointApplied,
          loadMs: loadedScene.loadMs,
          missingAssets: loadedScene.missingAssets
        }
      });
      if (sceneFitEnabled && debugState.sceneDebug.boundingBox) {
        applySceneDebugFit(debugState.sceneDebug.boundingBox);
        debugState.sceneDebug = inspectSceneObject({
          root: loadedScene.group,
          camera,
          previous: debugState.sceneDebug
        });
      }
      brandingLineEl.textContent = `${brandingLineEl.textContent} | Scene: ${loadedScene.manifest.label}`;
      void reportDiagnostics("scene_bundle_loaded");
    } catch (error) {
      console.error(error);
      activeSceneBundleRoot = null;
      setFallbackEnvironmentVisible(true);
      debugState.sceneBundleState = "failed";
      debugState.sceneDebug = {
        ...debugState.sceneDebug,
        bundleUrl: boot.sceneBundleUrl,
        state: "failed",
        missingAssets: [],
        loadMs: null
      };
      brandingLineEl.textContent = `${brandingLineEl.textContent} | Scene bundle fallback active`;
      void reportDiagnostics("scene_bundle_failed");
    }
  }

  setStatus(`Joined as ${displayName}`);
  startShareButton.disabled = !runtimeFlags.screenShare && !shareMockEnabled;
  joinAudioButton.disabled = !runtimeFlags.audioJoin;
  if (!runtimeFlags.audioJoin) {
    muteButton.disabled = true;
    debugState.audioState = "disabled";
  }

  if ((runtimeFlags.audioJoin || runtimeFlags.screenShare) && faultConfig.audio !== "mic_denied" && faultConfig.audio !== "no_audio_device") {
    void ensureMediaRoom().then(() => {
      clearIssue(`Joined as ${displayName}`);
      debugState.audioState = "connected-passive";
      void reportDiagnostics("media_connected_passive");
    }).catch((error: unknown) => {
      console.error(error);
      const issue = classifyMediaError(error);
      if (runtimeUiState.issueCode === "room_state_failed") {
        runtimeUiState = {
          ...runtimeUiState,
          audioState: "degraded",
          lastRecoveryAction: "media_passive_connect_failed"
        };
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

  try {
    connectRoomStateWithRetry(boot.roomStateUrl);
  } catch (error) {
    console.error(error);
    roomStateConnected = false;
    debugState.roomStateMode = "fallback";
    setRoomStateStatus("Room-state: fallback API");
    void reportDiagnostics("room_state_connect_failed");
  }

  const xrSupport = detectXrSupport({
    navigatorXr: faultConfig.xrUnavailable ? undefined : (navigator as Navigator & { xr?: unknown }).xr,
    immersiveVrSupported: !faultConfig.xrUnavailable
  });

  const vrButton = VRButton.createButton(renderer);
  vrButton.classList.add("vr-button");
  vrButton.style.position = "static";
  vrButton.style.marginTop = "10px";
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

  const localBody = makeBody(0xffd166);
  localBody.position.set(0, 0.92, 0);
  player.add(localBody);

  const localHead = makeHead(0xfff4d6);
  localHead.position.set(0, 1.58, 0);
  localHead.visible = debugEnabled;
  player.add(localHead);

  await syncPresence(boot.joinMode, false);
  await refreshPresence();
  latestMode = boot.joinMode;
  await reportDiagnostics("runtime_booted");
}

void main().catch((error: unknown) => {
  console.error(error);
  setStatus("Runtime failed to boot");
  void reportDiagnostics("runtime_boot_failed");
});
