import * as THREE from "three";

export type RemoteBrowserVrKeyboardLayoutId = "en-US" | "ru-RU";

export type RemoteBrowserVrKeyboardAction =
  | { type: "text"; text: string; key?: string }
  | { type: "key"; key: string }
  | { type: "layout-next" };

export interface RemoteBrowserVrKeyboardKey {
  id: string;
  label: string;
  width: number;
  action: RemoteBrowserVrKeyboardAction;
}

export interface RemoteBrowserVrKeyboardLayout {
  id: RemoteBrowserVrKeyboardLayoutId;
  label: string;
  rows: RemoteBrowserVrKeyboardKey[][];
}

export type RemoteBrowserVrKeyboardTarget =
  | { kind: "toggle" }
  | { kind: "key"; keyId: string };

export interface RemoteBrowserVrKeyboardView {
  root: THREE.Group;
  keyboardRoot: THREE.Group;
  toggleMesh: THREE.Mesh;
  keyMeshes: THREE.Mesh[];
  keyById: Map<string, RemoteBrowserVrKeyboardKey>;
  meshById: Map<string, THREE.Mesh>;
  active: boolean;
  open: boolean;
  currentLayoutId: RemoteBrowserVrKeyboardLayoutId;
  availableLayoutIds: RemoteBrowserVrKeyboardLayoutId[];
  hoveredTarget: RemoteBrowserVrKeyboardTarget | null;
  pressedTarget: RemoteBrowserVrKeyboardTarget | null;
}

export type RemoteBrowserVrKeyboardHit =
  | { kind: "toggle"; point: THREE.Vector3; distanceM: number }
  | { kind: "key"; key: RemoteBrowserVrKeyboardKey; point: THREE.Vector3; distanceM: number };

export interface RemoteBrowserVrKeyboardInputPlan {
  keyId: string | null;
  key?: string;
  text?: string;
  layoutNext?: boolean;
  toggleKeyboard?: boolean;
}

export const REMOTE_BROWSER_VR_KEYBOARD_LAYOUTS: Record<RemoteBrowserVrKeyboardLayoutId, RemoteBrowserVrKeyboardLayout> = {
  "en-US": {
    id: "en-US",
    label: "EN",
    rows: [
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
        { id: "key-space", label: "Space", width: 2.7, action: { type: "text", text: " ", key: " " } },
        { id: "key-backspace", label: "Back", width: 1.6, action: { type: "key", key: "Backspace" } },
        { id: "key-enter", label: "Enter", width: 1.6, action: { type: "key", key: "Enter" } },
        layoutNextKey("RU"),
        textKey("key-colon", ":"),
        textKey("key-at", "@"),
        { id: "key-dotcom", label: ".com", width: 1.5, action: { type: "text", text: ".com" } }
      ]
    ]
  },
  "ru-RU": {
    id: "ru-RU",
    label: "RU",
    rows: [
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((char) => textKey(`key-${char}`, char)),
      [
        textKey("key-ru-io", "й"),
        textKey("key-ru-tse", "ц"),
        textKey("key-ru-u", "у"),
        textKey("key-ru-ka", "к"),
        textKey("key-ru-ie", "е"),
        textKey("key-ru-en", "н"),
        textKey("key-ru-ge", "г"),
        textKey("key-ru-sha", "ш"),
        textKey("key-ru-shcha", "щ"),
        textKey("key-ru-ze", "з"),
        textKey("key-ru-ha", "х")
      ],
      [
        textKey("key-ru-ef", "ф"),
        textKey("key-ru-yeru", "ы"),
        textKey("key-ru-ve", "в"),
        textKey("key-ru-a", "а"),
        textKey("key-ru-pe", "п"),
        textKey("key-ru-er", "р"),
        textKey("key-ru-o", "о"),
        textKey("key-ru-el", "л"),
        textKey("key-ru-de", "д"),
        textKey("key-ru-zhe", "ж"),
        textKey("key-ru-e", "э")
      ],
      [
        textKey("key-ru-ya", "я"),
        textKey("key-ru-che", "ч"),
        textKey("key-ru-es", "с"),
        textKey("key-ru-em", "м"),
        textKey("key-ru-i", "и"),
        textKey("key-ru-te", "т"),
        textKey("key-ru-soft", "ь"),
        textKey("key-ru-be", "б"),
        textKey("key-ru-yu", "ю"),
        textKey("key-dot", "."),
        textKey("key-slash", "/")
      ],
      [
        { id: "key-space", label: "Пробел", width: 2.7, action: { type: "text", text: " ", key: " " } },
        { id: "key-backspace", label: "Назад", width: 1.6, action: { type: "key", key: "Backspace" } },
        { id: "key-enter", label: "Ввод", width: 1.6, action: { type: "key", key: "Enter" } },
        layoutNextKey("EN"),
        textKey("key-dash", "-"),
        textKey("key-at", "@"),
        { id: "key-dotru", label: ".ru", width: 1.5, action: { type: "text", text: ".ru" } }
      ]
    ]
  }
};

function textKey(id: string, text: string): RemoteBrowserVrKeyboardKey {
  return {
    id,
    label: text,
    width: 1,
    action: text.length === 1 ? { type: "text", text, key: text } : { type: "text", text }
  };
}

function layoutNextKey(label: string): RemoteBrowserVrKeyboardKey {
  return {
    id: "key-layout-next",
    label,
    width: 1.15,
    action: { type: "layout-next" }
  };
}

function createLabelTexture(input: { label: string; fill: string; stroke: string; fontScale?: number }): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = input.fill;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = input.stroke;
    context.lineWidth = 8;
    context.strokeRect(6, 6, canvas.width - 12, canvas.height - 12);
    context.fillStyle = "#f8fafc";
    const scale = input.fontScale ?? 1;
    context.font = input.label.length > 1 ? `600 ${Math.round(42 * scale)}px sans-serif` : `700 ${Math.round(58 * scale)}px sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(input.label, canvas.width / 2, canvas.height / 2 + 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function setMeshTextureLabel(mesh: THREE.Mesh, label: string, fill: string, stroke: string): void {
  const material = mesh.material instanceof THREE.MeshBasicMaterial ? mesh.material : null;
  if (!material) {
    return;
  }
  material.map?.dispose();
  material.map = createLabelTexture({ label, fill, stroke, fontScale: label.length > 5 ? 0.78 : 1 });
  material.needsUpdate = true;
}

function createLabelMesh(input: { width: number; height: number; label: string; fill: string; stroke: string }): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(input.width, input.height),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: createLabelTexture(input),
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false
    })
  );
}

function targetId(target: RemoteBrowserVrKeyboardTarget | null): string | null {
  if (!target) {
    return null;
  }
  return target.kind === "toggle" ? "toggle" : `key:${target.keyId}`;
}

function disposeMesh(mesh: THREE.Mesh): void {
  mesh.geometry.dispose();
  if (mesh.material instanceof THREE.MeshBasicMaterial) {
    mesh.material.map?.dispose();
    mesh.material.dispose();
  }
}

export function createRemoteBrowserVrKeyboardView(input: {
  layoutIds?: RemoteBrowserVrKeyboardLayoutId[];
  initialLayoutId?: RemoteBrowserVrKeyboardLayoutId;
} = {}): RemoteBrowserVrKeyboardView {
  const root = new THREE.Group();
  root.name = "remote-browser-vr-keyboard-root";
  root.visible = false;
  root.renderOrder = 1200;

  const keyboardRoot = new THREE.Group();
  keyboardRoot.name = "remote-browser-vr-keyboard";
  keyboardRoot.position.set(0, -2.62, 0.12);
  keyboardRoot.visible = false;
  keyboardRoot.renderOrder = 1200;
  root.add(keyboardRoot);

  const toggleMesh = createLabelMesh({ width: 1.2, height: 0.28, label: "Keyboard", fill: "#172033", stroke: "#ffc857" });
  toggleMesh.name = "remote-browser-vr-keyboard-toggle";
  toggleMesh.position.set(2.18, -1.92, 0.12);
  toggleMesh.renderOrder = 1202;
  toggleMesh.userData.remoteBrowserVrTargetKind = "toggle";
  root.add(toggleMesh);

  const availableLayoutIds = (input.layoutIds?.filter((id) => id in REMOTE_BROWSER_VR_KEYBOARD_LAYOUTS) ?? ["en-US", "ru-RU"]);
  const initialLayoutId = input.initialLayoutId && availableLayoutIds.includes(input.initialLayoutId)
    ? input.initialLayoutId
    : availableLayoutIds[0] ?? "en-US";
  const view: RemoteBrowserVrKeyboardView = {
    root,
    keyboardRoot,
    toggleMesh,
    keyMeshes: [],
    keyById: new Map(),
    meshById: new Map(),
    active: false,
    open: false,
    currentLayoutId: initialLayoutId,
    availableLayoutIds,
    hoveredTarget: null,
    pressedTarget: null
  };
  setRemoteBrowserVrKeyboardLayout(view, initialLayoutId);
  return view;
}

export function setRemoteBrowserVrKeyboardActive(view: RemoteBrowserVrKeyboardView, active: boolean): void {
  view.active = active;
  view.root.visible = active;
  view.toggleMesh.visible = active;
  if (!active) {
    setRemoteBrowserVrKeyboardOpen(view, false);
    setRemoteBrowserVrKeyboardTargets(view, null, null);
  }
}

export function setRemoteBrowserVrKeyboardOpen(view: RemoteBrowserVrKeyboardView, open: boolean): void {
  view.open = open;
  view.keyboardRoot.visible = open;
  setMeshTextureLabel(view.toggleMesh, open ? "Hide" : "Keyboard", "#172033", open ? "#ff8c42" : "#ffc857");
  if (!open) {
    setRemoteBrowserVrKeyboardTargets(view, view.hoveredTarget?.kind === "toggle" ? view.hoveredTarget : null, view.pressedTarget?.kind === "toggle" ? view.pressedTarget : null);
  }
}

export function setRemoteBrowserVrKeyboardLayout(view: RemoteBrowserVrKeyboardView, layoutId: RemoteBrowserVrKeyboardLayoutId): void {
  const layout = REMOTE_BROWSER_VR_KEYBOARD_LAYOUTS[layoutId];
  view.currentLayoutId = layout.id;
  for (const mesh of view.keyMeshes) {
    view.keyboardRoot.remove(mesh);
    disposeMesh(mesh);
  }
  view.keyMeshes = [];
  view.keyById.clear();
  view.meshById.clear();

  const keyHeight = 0.24;
  const unitWidth = 0.38;
  const gap = 0.042;
  const rowGap = 0.075;
  const totalHeight = layout.rows.length * keyHeight + (layout.rows.length - 1) * rowGap;

  for (let rowIndex = 0; rowIndex < layout.rows.length; rowIndex += 1) {
    const row = layout.rows[rowIndex]!;
    const rowWidth = row.reduce((sum, key) => sum + key.width * unitWidth, 0) + (row.length - 1) * gap;
    let x = -rowWidth / 2;
    const y = totalHeight / 2 - keyHeight / 2 - rowIndex * (keyHeight + rowGap);
    for (const key of row) {
      const width = key.width * unitWidth;
      const mesh = createLabelMesh({ width, height: keyHeight, label: key.label, fill: "#111827", stroke: "#ffc857" });
      mesh.name = `remote-browser-vr-key-${key.id}`;
      mesh.position.set(x + width / 2, y, 0);
      mesh.renderOrder = 1201;
      mesh.userData.remoteBrowserVrTargetKind = "key";
      mesh.userData.remoteBrowserVrKeyId = key.id;
      view.keyboardRoot.add(mesh);
      view.keyMeshes.push(mesh);
      view.keyById.set(key.id, key);
      view.meshById.set(key.id, mesh);
      x += width + gap;
    }
  }
  setRemoteBrowserVrKeyboardTargets(view, null, null);
}

export function cycleRemoteBrowserVrKeyboardLayout(view: RemoteBrowserVrKeyboardView): RemoteBrowserVrKeyboardLayoutId {
  const currentIndex = Math.max(0, view.availableLayoutIds.indexOf(view.currentLayoutId));
  const nextLayoutId = view.availableLayoutIds[(currentIndex + 1) % view.availableLayoutIds.length] ?? view.currentLayoutId;
  setRemoteBrowserVrKeyboardLayout(view, nextLayoutId);
  return nextLayoutId;
}

export function setRemoteBrowserVrKeyboardTargets(view: RemoteBrowserVrKeyboardView, hovered: RemoteBrowserVrKeyboardTarget | null, pressed: RemoteBrowserVrKeyboardTarget | null): void {
  const hoveredId = targetId(hovered);
  const pressedId = targetId(pressed);
  if (targetId(view.hoveredTarget) === hoveredId && targetId(view.pressedTarget) === pressedId) {
    return;
  }
  const toggleMaterial = view.toggleMesh.material instanceof THREE.MeshBasicMaterial ? view.toggleMesh.material : null;
  toggleMaterial?.color.setHex(pressedId === "toggle" ? 0xffd166 : hoveredId === "toggle" ? 0xfff1a8 : 0xffffff);
  for (const mesh of view.keyMeshes) {
    const id = `key:${String(mesh.userData.remoteBrowserVrKeyId)}`;
    const material = mesh.material instanceof THREE.MeshBasicMaterial ? mesh.material : null;
    material?.color.setHex(pressedId === id ? 0xffd166 : hoveredId === id ? 0xfff1a8 : 0xffffff);
  }
  view.hoveredTarget = hovered;
  view.pressedTarget = pressed;
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
  const toggleHit = input.raycaster.intersectObject(input.view.toggleMesh, false)[0];
  if (toggleHit) {
    return { kind: "toggle", point: toggleHit.point.clone(), distanceM: toggleHit.distance };
  }
  if (!input.view.keyboardRoot.visible) {
    return null;
  }
  const keyHit = input.raycaster.intersectObjects(input.view.keyMeshes, false)[0];
  const keyId = typeof keyHit?.object.userData.remoteBrowserVrKeyId === "string" ? keyHit.object.userData.remoteBrowserVrKeyId : null;
  const key = keyId ? input.view.keyById.get(keyId) ?? null : null;
  if (!keyHit || !key) {
    return null;
  }
  return {
    kind: "key",
    key,
    point: keyHit.point.clone(),
    distanceM: keyHit.distance
  };
}

export function targetFromRemoteBrowserVrKeyboardHit(hit: RemoteBrowserVrKeyboardHit | null): RemoteBrowserVrKeyboardTarget | null {
  if (!hit) {
    return null;
  }
  return hit.kind === "toggle" ? { kind: "toggle" } : { kind: "key", keyId: hit.key.id };
}

export function planRemoteBrowserVrKeyboardInput(input: {
  keyboardActive: boolean;
  confirmInteraction: boolean;
  hit: RemoteBrowserVrKeyboardHit | null;
}): RemoteBrowserVrKeyboardInputPlan {
  if (!input.keyboardActive || !input.confirmInteraction || !input.hit) {
    return { keyId: null };
  }
  if (input.hit.kind === "toggle") {
    return { keyId: null, toggleKeyboard: true };
  }
  const action = input.hit.key.action;
  if (action.type === "layout-next") {
    return { keyId: input.hit.key.id, layoutNext: true };
  }
  if (action.type === "key") {
    return { keyId: input.hit.key.id, key: action.key };
  }
  return action.key
    ? { keyId: input.hit.key.id, key: action.key, text: action.text }
    : { keyId: input.hit.key.id, text: action.text };
}
