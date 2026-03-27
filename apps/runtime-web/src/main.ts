import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { Room, RoomEvent, Track } from "livekit-client";

import { bootRuntime, listPresence, planVoiceSession, removePresence, upsertPresence, type PresenceState } from "./index.js";
import { applySnapTurn, computeKeyboardDirection, rotateFlatVector, sanitizeXrAxes, stepFlatMovement } from "./movement.js";
import { createMotionTrack, pushMotionSample, sampleMotion, type MotionTrack } from "./motion-state.js";
import { connectRoomState, sendParticipantUpdate, type RoomStateClient, type RoomStateSnapshot } from "./room-state-client.js";
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
const botMode = query.get("bot") ?? "off";
const shareMockEnabled = query.get("sharemock") === "1";
const participantId = getParticipantId();
const displayName = localStorage.getItem("noah.displayName") ?? `Guest-${participantId.slice(0, 4)}`;
localStorage.setItem("noah.displayName", displayName);

const roomNameEl = mustElement<HTMLDivElement>("#room-name");
const statusLineEl = mustElement<HTMLDivElement>("#status-line");
const brandingLineEl = mustElement<HTMLDivElement>("#branding-line");
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

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 1.6, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
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
    remoteMotionTracks.set(person.participantId, {
      root: pushMotionSample(current.root, {
        x: person.rootTransform.x,
        z: person.rootTransform.z,
        capturedAtMs: Date.now()
      }),
      body: pushMotionSample(current.body, {
        x: person.bodyTransform?.x ?? person.rootTransform.x,
        z: person.bodyTransform?.z ?? person.rootTransform.z,
        capturedAtMs: Date.now()
      }),
      head: pushMotionSample(current.head, {
        x: person.headTransform?.x ?? person.rootTransform.x,
        z: person.headTransform?.z ?? person.rootTransform.z,
        capturedAtMs: Date.now()
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

const debugState = {
  participantId,
  remoteAvatarCount: 0,
  statusLine: "Connecting...",
  locomotionMode: "desktop",
  roomStateConnected: false,
  roomStateUrl: "",
  audioState: "idle",
  screenShareState: "idle",
  localPosition: { x: 0, z: 6 },
  xrAxes: { moveX: 0, moveY: 0, turnX: 0 },
  botMode,
  lastPresenceSyncAt: 0,
  lastPresenceRefreshAt: 0,
  remoteTargets: [] as Array<{ id: string; x: number; z: number }>
};

const floorMaterial = floor.material as THREE.MeshStandardMaterial;

(window as Window & { __NOAH_DEBUG__?: typeof debugState }).__NOAH_DEBUG__ = debugState;

function setStatus(message: string): void {
  statusLineEl.textContent = message;
  debugState.statusLine = message;
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
      lastPresenceSyncAt: debugState.lastPresenceSyncAt,
      lastPresenceRefreshAt: debugState.lastPresenceRefreshAt,
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
          capturedAtMs: Date.now()
        }),
        body: pushMotionSample(createMotionTrack(), {
          x: participant.bodyTransform?.x ?? participant.rootTransform.x,
          z: participant.bodyTransform?.z ?? participant.rootTransform.z,
          capturedAtMs: Date.now()
        }),
        head: pushMotionSample(createMotionTrack(), {
          x: participant.headTransform?.x ?? participant.rootTransform.x,
          z: participant.headTransform?.z ?? participant.rootTransform.z,
          capturedAtMs: Date.now()
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
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Video) {
      attachVideoTrack(track);
      return;
    }
    if (track.kind !== Track.Kind.Audio) return;
    const element = track.attach();
    element.autoplay = true;
    element.style.display = "none";
    document.body.appendChild(element);
    debugState.audioState = "remote-track";
  });

  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    if (track.kind === Track.Kind.Video) {
      detachVideoTrack();
      return;
    }
    if (track.kind !== Track.Kind.Audio) return;
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
  if (livekitRoom) {
    if (!microphoneEnabled) {
      await livekitRoom.localParticipant.setMicrophoneEnabled(true);
      microphoneEnabled = true;
      muteButton.disabled = false;
      joinAudioButton.disabled = true;
      setStatus("Audio connected");
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
  setStatus("Audio connected");
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

joinAudioButton.addEventListener("click", () => {
  void joinAudio().catch((error: unknown) => {
    console.error(error);
    setStatus("Audio failed");
    debugState.audioState = error instanceof Error ? error.name : "failed";
    void reportDiagnostics("audio_failed");
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
  roomStateClient?.close();
  void livekitRoom?.disconnect();
});

const clock = new THREE.Clock();
let syncAccumulator = 0;
let presenceAccumulator = 0;

renderer.setAnimationLoop(() => {
  const delta = clock.getDelta();
  updateMovement(delta);
  updateRemoteAvatarInterpolation(delta);
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
      setStatus("Presence sync issue");
      void reportDiagnostics("presence_sync_issue");
    });
  }

  diagnosticsAccumulator += delta;
  if (diagnosticsAccumulator >= 2) {
    diagnosticsAccumulator = 0;
    void reportDiagnostics();
  }

  renderer.render(scene, camera);
});

async function main(): Promise<void> {
  const boot = await bootRuntime(apiBaseUrl, roomId, navigator.userAgent);
  debugState.roomStateUrl = boot.roomStateUrl;
  roomNameEl.textContent = `${boot.template} - ${boot.roomId}`;
  brandingLineEl.textContent = boot.assets.length > 0
    ? `Attached assets: ${boot.assets.map((asset) => asset.kind).join(", ")}`
    : "No branded assets attached";
  floorMaterial.color.set(boot.theme.accentColor);
  wallMaterial.color.set(boot.theme.primaryColor);
  scene.fog = new THREE.Fog(new THREE.Color(boot.theme.accentColor).getHex(), 12, 50);
  setStatus(`Joined as ${displayName}`);
  startShareButton.disabled = !boot.screenShareEnabled && !shareMockEnabled;
  joinAudioButton.disabled = !boot.voiceEnabled;
  if (!boot.voiceEnabled) {
    muteButton.disabled = true;
    debugState.audioState = "disabled";
  }

  try {
    await ensureMediaRoom();
    setStatus(`Joined as ${displayName}`);
    debugState.audioState = "connected-passive";
    void reportDiagnostics("media_connected_passive");
  } catch (error) {
    console.error(error);
    debugState.audioState = "media_connect_failed";
    void reportDiagnostics("media_connect_failed");
  }

  try {
    roomStateClient = connectRoomState(
      boot.roomStateUrl,
      roomId,
      participantId,
      (snapshot: RoomStateSnapshot) => {
        roomStateConnected = true;
        debugState.roomStateConnected = true;
        applySnapshotParticipants(snapshot.participants);
      },
      (error: unknown) => {
        console.error(error);
        roomStateConnected = false;
        debugState.roomStateConnected = false;
      }
    );
    void reportDiagnostics("room_state_connected");
  } catch (error) {
    console.error(error);
    roomStateConnected = false;
    void reportDiagnostics("room_state_connect_failed");
  }

  const xrSupport = detectXrSupport({
    navigatorXr: (navigator as Navigator & { xr?: unknown }).xr,
    immersiveVrSupported: true
  });

  const vrButton = VRButton.createButton(renderer);
  vrButton.classList.add("vr-button");
  vrButton.style.position = "static";
  vrButton.style.marginTop = "10px";
  if (!getEnterVrVisibility(xrSupport, true)) {
    vrButton.setAttribute("disabled", "true");
    vrButton.textContent = "VR unavailable";
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
  void reportDiagnostics("runtime_booted");
}

void main().catch((error: unknown) => {
  console.error(error);
  setStatus("Runtime failed to boot");
  void reportDiagnostics("runtime_boot_failed");
});
