import * as THREE from "three";

export type RemoteBrowserVrKeyboardAction =
  | { type: "text"; text: string; key?: string }
  | { type: "key"; key: string };

export interface RemoteBrowserVrKeyboardKey {
  id: string;
  label: string;
  width: number;
  action: RemoteBrowserVrKeyboardAction;
}

export interface RemoteBrowserVrKeyboardView {
  root: THREE.Group;
  keyMeshes: THREE.Mesh[];
  keyById: Map<string, RemoteBrowserVrKeyboardKey>;
  meshById: Map<string, THREE.Mesh>;
  hoveredKeyId: string | null;
}

export interface RemoteBrowserVrKeyboardHit {
  key: RemoteBrowserVrKeyboardKey;
  point: THREE.Vector3;
  distanceM: number;
}

export interface RemoteBrowserVrKeyboardInputPlan {
  keyId: string | null;
  key?: string;
  text?: string;
}

export const REMOTE_BROWSER_VR_KEYBOARD_ROWS: RemoteBrowserVrKeyboardKey[][] = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((char) => textKey(`key-${char}`, char)),
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"].map((char) => textKey(`key-${char}`, char)),
  ["a", "s", "d", "f", "g", "h", "j", "k", "l", "."].map((char) => textKey(char === "." ? "key-dot" : `key-${char}`, char)),
  [
    ...["z", "x", "c", "v", "b", "n", "m"].map((char) => textKey(`key-${char}`, char)),
    textKey("key-dash", "-"),
    textKey("key-underscore", "_"),
    textKey("key-slash", "/")
  ],
  [
    { id: "key-space", label: "Space", width: 3, action: { type: "text", text: " ", key: " " } },
    { id: "key-backspace", label: "Back", width: 2, action: { type: "key", key: "Backspace" } },
    { id: "key-enter", label: "Enter", width: 2, action: { type: "key", key: "Enter" } },
    textKey("key-colon", ":"),
    textKey("key-at", "@"),
    { id: "key-dotcom", label: ".com", width: 1.7, action: { type: "text", text: ".com" } }
  ]
];

function textKey(id: string, text: string): RemoteBrowserVrKeyboardKey {
  return {
    id,
    label: text,
    width: 1,
    action: text.length === 1 ? { type: "text", text, key: text } : { type: "text", text }
  };
}

function createKeyTexture(label: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = "#111827";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "#ffc857";
    context.lineWidth = 8;
    context.strokeRect(6, 6, canvas.width - 12, canvas.height - 12);
    context.fillStyle = "#f8fafc";
    context.font = label.length > 1 ? "600 42px sans-serif" : "700 58px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, canvas.width / 2, canvas.height / 2 + 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createRemoteBrowserVrKeyboardView(): RemoteBrowserVrKeyboardView {
  const root = new THREE.Group();
  root.name = "remote-browser-vr-keyboard";
  root.position.set(0, -1.05, 0.07);
  root.visible = false;
  root.renderOrder = 1200;

  const keyMeshes: THREE.Mesh[] = [];
  const keyById = new Map<string, RemoteBrowserVrKeyboardKey>();
  const meshById = new Map<string, THREE.Mesh>();
  const keyHeight = 0.24;
  const unitWidth = 0.42;
  const gap = 0.045;
  const rowGap = 0.075;
  const totalHeight = REMOTE_BROWSER_VR_KEYBOARD_ROWS.length * keyHeight + (REMOTE_BROWSER_VR_KEYBOARD_ROWS.length - 1) * rowGap;

  for (let rowIndex = 0; rowIndex < REMOTE_BROWSER_VR_KEYBOARD_ROWS.length; rowIndex += 1) {
    const row = REMOTE_BROWSER_VR_KEYBOARD_ROWS[rowIndex]!;
    const rowWidth = row.reduce((sum, key) => sum + key.width * unitWidth, 0) + (row.length - 1) * gap;
    let x = -rowWidth / 2;
    const y = totalHeight / 2 - keyHeight / 2 - rowIndex * (keyHeight + rowGap);
    for (const key of row) {
      const width = key.width * unitWidth;
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        map: createKeyTexture(key.label),
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, keyHeight), material);
      mesh.name = `remote-browser-vr-key-${key.id}`;
      mesh.position.set(x + width / 2, y, 0);
      mesh.renderOrder = 1201;
      mesh.userData.remoteBrowserVrKeyId = key.id;
      root.add(mesh);
      keyMeshes.push(mesh);
      keyById.set(key.id, key);
      meshById.set(key.id, mesh);
      x += width + gap;
    }
  }

  return { root, keyMeshes, keyById, meshById, hoveredKeyId: null };
}

export function setRemoteBrowserVrKeyboardVisible(view: RemoteBrowserVrKeyboardView, visible: boolean): void {
  view.root.visible = visible;
  if (!visible) {
    setRemoteBrowserVrKeyboardHover(view, null);
  }
}

export function setRemoteBrowserVrKeyboardHover(view: RemoteBrowserVrKeyboardView, keyId: string | null): void {
  if (view.hoveredKeyId === keyId) {
    return;
  }
  for (const mesh of view.keyMeshes) {
    const material = mesh.material instanceof THREE.MeshBasicMaterial ? mesh.material : null;
    material?.color.setHex(mesh.userData.remoteBrowserVrKeyId === keyId ? 0xfff1a8 : 0xffffff);
  }
  view.hoveredKeyId = keyId;
}

export function resolveRemoteBrowserVrKeyboardHit(input: {
  view: RemoteBrowserVrKeyboardView;
  ray: THREE.Ray;
  raycaster: THREE.Raycaster;
}): RemoteBrowserVrKeyboardHit | null {
  if (!input.view.root.visible) {
    return null;
  }
  input.view.root.updateMatrixWorld(true);
  input.raycaster.ray.copy(input.ray);
  const hit = input.raycaster.intersectObjects(input.view.keyMeshes, false)[0];
  const keyId = typeof hit?.object.userData.remoteBrowserVrKeyId === "string" ? hit.object.userData.remoteBrowserVrKeyId : null;
  const key = keyId ? input.view.keyById.get(keyId) ?? null : null;
  if (!hit || !key) {
    return null;
  }
  return {
    key,
    point: hit.point.clone(),
    distanceM: hit.distance
  };
}

export function planRemoteBrowserVrKeyboardInput(input: {
  keyboardActive: boolean;
  confirmInteraction: boolean;
  hoveredKey: RemoteBrowserVrKeyboardKey | null;
}): RemoteBrowserVrKeyboardInputPlan {
  if (!input.keyboardActive || !input.confirmInteraction || !input.hoveredKey) {
    return { keyId: null };
  }
  const action = input.hoveredKey.action;
  if (action.type === "key") {
    return { keyId: input.hoveredKey.id, key: action.key };
  }
  return action.key
    ? { keyId: input.hoveredKey.id, key: action.key, text: action.text }
    : { keyId: input.hoveredKey.id, text: action.text };
}
