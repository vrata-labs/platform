import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { Room, RoomEvent, Track } from "livekit-client";

import { bootRuntime, listPresence, planVoiceSession, removePresence, upsertPresence, type PresenceState } from "./index.js";
import { applySnapTurn, computeKeyboardDirection, rotateFlatVector, sanitizeXrAxes, stepFlatMovement } from "./movement.js";
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
const participantId = getParticipantId();
const displayName = localStorage.getItem("noah.displayName") ?? `Guest-${participantId.slice(0, 4)}`;
localStorage.setItem("noah.displayName", displayName);

const roomNameEl = mustElement<HTMLDivElement>("#room-name");
const statusLineEl = mustElement<HTMLDivElement>("#status-line");
const sceneHost = mustElement<HTMLDivElement>("#scene");
const joinAudioButton = mustElement<HTMLButtonElement>("#join-audio");
const muteButton = mustElement<HTMLButtonElement>("#toggle-mute");
const debugPanel = mustElement<HTMLPreElement>("#debug-panel");

if (debugEnabled) {
  debugPanel.hidden = false;
}

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x08111f, 12, 50);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 1.6, 5);

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

const avatarGeometry = new THREE.SphereGeometry(0.35, 24, 24);
const remoteAvatars = new Map<string, THREE.Mesh>();
const remoteTargets = new Map<string, THREE.Vector3>();

const keyState: Record<string, boolean> = {};
let pointerActive = false;
let yaw = 0;
let pitchAngle = 0;
let livekitRoom: Room | null = null;
let microphoneEnabled = false;
let xrTurnCooldown = 0;
let mobileTouchActive = false;
const mobileTouchVector = { x: 0, z: 0 };

const debugState = {
  participantId,
  remoteAvatarCount: 0,
  statusLine: "Connecting...",
  locomotionMode: "desktop",
  audioState: "idle",
  localPosition: { x: 0, z: 6 },
  xrAxes: { moveX: 0, moveY: 0, turnX: 0 },
  botMode,
  lastPresenceSyncAt: 0,
  lastPresenceRefreshAt: 0,
  remoteTargets: [] as Array<{ id: string; x: number; z: number }>
};

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

function makeAvatar(color: number): THREE.Mesh {
  return new THREE.Mesh(
    avatarGeometry,
    new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.1 })
  );
}

function ensureRemoteAvatar(participant: PresenceState): THREE.Mesh {
  let mesh = remoteAvatars.get(participant.participantId);
  if (!mesh) {
    mesh = makeAvatar(participant.activeMedia.audio ? 0x5fc8ff : 0xbfd8ee);
    scene.add(mesh);
    remoteAvatars.set(participant.participantId, mesh);
    remoteTargets.set(participant.participantId, new THREE.Vector3(participant.rootTransform.x, 0.45, participant.rootTransform.z));
  }
  return mesh;
}

function pruneRemoteAvatars(currentIds: Set<string>): void {
  for (const [id, mesh] of remoteAvatars.entries()) {
    if (!currentIds.has(id)) {
      scene.remove(mesh);
      remoteAvatars.delete(id);
      remoteTargets.delete(id);
    }
  }
  debugState.remoteAvatarCount = remoteAvatars.size;
}

function updateRemoteAvatarInterpolation(delta: number): void {
  const smoothing = Math.min(1, delta * 10);
  for (const [participantId, mesh] of remoteAvatars.entries()) {
    const target = remoteTargets.get(participantId);
    if (!target) {
      continue;
    }
    mesh.position.lerp(target, smoothing);
  }
  debugState.remoteTargets = Array.from(remoteTargets.entries()).map(([id, target]) => ({ id, x: Number(target.x.toFixed(2)), z: Number(target.z.toFixed(2)) }));
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

  await upsertPresence(apiBaseUrl, roomId, {
    participantId,
    displayName,
    mode,
    rootTransform: {
      x: player.position.x,
      y: player.position.y,
      z: player.position.z
    },
    headTransform: {
      x: worldPosition.x,
      y: worldPosition.y,
      z: worldPosition.z
    },
    muted: !microphoneEnabled,
    activeMedia: {
      audio: audioActive,
      screenShare: false
    },
    updatedAt: new Date().toISOString()
  });
  debugState.lastPresenceSyncAt = Date.now();
}

async function refreshPresence(): Promise<void> {
  const people = await listPresence(apiBaseUrl, roomId);
  const activeIds = new Set<string>();

  for (const person of people) {
    if (person.participantId === participantId) {
      continue;
    }

    activeIds.add(person.participantId);
    const mesh = ensureRemoteAvatar(person);
    const material = mesh.material;
    if (material instanceof THREE.MeshStandardMaterial) {
      material.color.setHex(person.activeMedia.audio ? 0x5fc8ff : 0xbfd8ee);
    }
    const target = remoteTargets.get(person.participantId) ?? new THREE.Vector3();
    target.set(person.rootTransform.x, 0.45, person.rootTransform.z);
    remoteTargets.set(person.participantId, target);
    if (mesh.position.lengthSq() === 0) {
      mesh.position.copy(target);
    }
  }

  pruneRemoteAvatars(activeIds);
  debugState.remoteAvatarCount = remoteAvatars.size;
  debugState.lastPresenceRefreshAt = Date.now();
}

function setupAudio(room: Room): void {
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== Track.Kind.Audio) {
      return;
    }
    const element = track.attach();
    element.autoplay = true;
    element.style.display = "none";
    document.body.appendChild(element);
    debugState.audioState = "remote-track";
  });

  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    if (track.kind !== Track.Kind.Audio) {
      return;
    }
    track.detach().forEach((element) => element.remove());
  });
}

async function joinAudio(): Promise<void> {
  if (livekitRoom) {
    return;
  }

  setStatus("Joining audio...");
  debugState.audioState = "joining";
  const voicePlan = await planVoiceSession(apiBaseUrl, roomId, participantId);
  const room = new Room();
  setupAudio(room);
  await room.connect(voicePlan.livekitUrl, voicePlan.token);
  await room.localParticipant.setMicrophoneEnabled(true);
  livekitRoom = room;
  microphoneEnabled = true;
  muteButton.disabled = false;
  joinAudioButton.disabled = true;
  setStatus("Audio connected");
  debugState.audioState = "connected";
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
    const mode = renderer.xr.isPresenting ? "vr" : /android|iphone|ipad/i.test(navigator.userAgent) ? "mobile" : "desktop";
    void syncPresence(mode, Boolean(livekitRoom));
  }

  if (presenceAccumulator >= 0.12) {
    presenceAccumulator = 0;
    void refreshPresence().catch((error: unknown) => {
      console.error(error);
      setStatus("Presence sync issue");
    });
  }

  renderer.render(scene, camera);
});

async function main(): Promise<void> {
  const boot = await bootRuntime(apiBaseUrl, roomId, navigator.userAgent);
  roomNameEl.textContent = `${boot.template} - ${boot.roomId}`;
  setStatus(`Joined as ${displayName}`);

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

  const localAvatar = makeAvatar(0xffd166);
  localAvatar.position.set(0, 0.45, 6);
  scene.add(localAvatar);

  setInterval(() => {
    localAvatar.position.copy(player.position).setY(0.45);
  }, 50);

  await syncPresence(boot.joinMode, false);
  await refreshPresence();
}

void main().catch((error: unknown) => {
  console.error(error);
  setStatus("Runtime failed to boot");
});
