import * as THREE from "three";

import { XR_MENU_ACTIONS, type XrMenuAction } from "./xr-menu.js";

const PANEL_WIDTH = 0.46;
const BUTTON_HEIGHT = 0.075;
const BUTTON_GAP = 0.015;
const TITLE_HEIGHT = 0.06;
const MENU_DISTANCE = 0.65;
const MENU_DROP = 0.12;

/** The menu button the ray points at; target resolution only, nothing is changed. */
export function resolveXrMenuHit(ray: THREE.Ray, raycaster: THREE.Raycaster, buttons: readonly THREE.Object3D[], maxDistance = 3): { action: XrMenuAction; distance: number } | null {
  raycaster.ray.copy(ray);
  for (const hit of raycaster.intersectObjects(buttons as THREE.Object3D[], false)) {
    if (hit.distance > maxDistance) break;
    const action = hit.object.userData.xrMenuAction;
    if (XR_MENU_ACTIONS.includes(action)) return { action: action as XrMenuAction, distance: hit.distance };
  }
  return null;
}

/** Where the menu opens: in front of the head, a little lower, facing it, upright. */
export function resolveXrMenuPlacement(head: THREE.Vector3, viewDirection: THREE.Vector3): { position: THREE.Vector3; yaw: number } {
  const flat = new THREE.Vector3(viewDirection.x, 0, viewDirection.z);
  if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1);
  flat.normalize();
  return {
    position: head.clone().addScaledVector(flat, MENU_DISTANCE).add(new THREE.Vector3(0, -MENU_DROP, 0)),
    // The panel's front (+Z) looks back at the head.
    yaw: Math.atan2(-flat.x, -flat.z)
  };
}

function drawLabel(canvas: HTMLCanvasElement, text: string, style: { background: string; color: string; size: number }): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = style.background;
  const radius = canvas.height * 0.3;
  context.beginPath();
  context.roundRect(4, 4, canvas.width - 8, canvas.height - 8, radius);
  context.fill();
  context.fillStyle = style.color;
  context.font = `600 ${style.size}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  let size = style.size;
  while (size > 18 && context.measureText(text).width > canvas.width - 40) {
    size -= 2;
    context.font = `600 ${size}px system-ui, sans-serif`;
  }
  context.fillText(text, canvas.width / 2, canvas.height / 2);
}

interface LabelPlane {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  drawn: string;
}

function createLabelPlane(width: number, height: number): LabelPlane {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = Math.round(512 * height / width);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false }));
  mesh.renderOrder = 1000;
  return { mesh, canvas, texture, drawn: "" };
}

export interface XrMenuView {
  group: THREE.Group;
  buttons: readonly THREE.Object3D[];
  placeInFront(camera: THREE.Camera): void;
  setVisible(visible: boolean): void;
  /** World centers of the buttons, for diagnostics and browser tests. */
  buttonCenters(): Record<XrMenuAction, { x: number; y: number; z: number }>;
  render(input: { title: string; labels: Record<XrMenuAction, string>; hovered: XrMenuAction | null; armed: boolean; ray: THREE.Ray | null; hitDistance: number | null }): void;
  dispose(): void;
}

export function createXrMenuView(): XrMenuView {
  const group = new THREE.Group();
  group.name = "xr-menu";
  group.visible = false;
  const rows = XR_MENU_ACTIONS.length;
  const panelHeight = TITLE_HEIGHT + rows * (BUTTON_HEIGHT + BUTTON_GAP) + BUTTON_GAP * 2;
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_WIDTH + 0.03, panelHeight),
    new THREE.MeshBasicMaterial({ color: 0x08111f, transparent: true, opacity: 0.88, depthTest: false }));
  backdrop.renderOrder = 999;
  group.add(backdrop);
  const top = panelHeight / 2 - BUTTON_GAP;
  const title = createLabelPlane(PANEL_WIDTH, TITLE_HEIGHT);
  title.mesh.position.set(0, top - TITLE_HEIGHT / 2, 0.001);
  group.add(title.mesh);
  const buttons = new Map<XrMenuAction, LabelPlane>();
  XR_MENU_ACTIONS.forEach((action, index) => {
    const label = createLabelPlane(PANEL_WIDTH - 0.02, BUTTON_HEIGHT);
    label.mesh.position.set(0, top - TITLE_HEIGHT - BUTTON_GAP - index * (BUTTON_HEIGHT + BUTTON_GAP) - BUTTON_HEIGHT / 2, 0.002);
    label.mesh.userData.xrMenuAction = action;
    label.mesh.name = `xr-menu-${action}`;
    group.add(label.mesh);
    buttons.set(action, label);
  });
  // The menu draws its own pointer: the room's aim ray rests while the menu is open.
  const pointer = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0x8be9fd, depthTest: false }));
  pointer.renderOrder = 1001;
  pointer.frustumCulled = false;
  pointer.visible = false;
  const pointerRoot = new THREE.Group();
  pointerRoot.name = "xr-menu-pointer";
  pointerRoot.add(pointer);

  function update(plane: LabelPlane, text: string, style: { background: string; color: string; size: number }): void {
    const key = `${text}|${style.background}`;
    if (plane.drawn === key) return;
    drawLabel(plane.canvas, text, style);
    plane.texture.needsUpdate = true;
    plane.drawn = key;
  }

  return {
    group,
    buttons: [...buttons.values()].map((plane) => plane.mesh),
    placeInFront(camera) {
      const head = camera.getWorldPosition(new THREE.Vector3());
      const placement = resolveXrMenuPlacement(head, camera.getWorldDirection(new THREE.Vector3()));
      group.position.copy(placement.position);
      group.rotation.set(0, placement.yaw, 0);
      group.updateMatrixWorld(true);
      if (pointerRoot.parent !== group.parent && group.parent) group.parent.add(pointerRoot);
    },
    buttonCenters() {
      const centers = {} as Record<XrMenuAction, { x: number; y: number; z: number }>;
      for (const [action, plane] of buttons) {
        const center = plane.mesh.getWorldPosition(new THREE.Vector3());
        centers[action] = { x: Number(center.x.toFixed(3)), y: Number(center.y.toFixed(3)), z: Number(center.z.toFixed(3)) };
      }
      return centers;
    },
    setVisible(visible) {
      group.visible = visible;
      if (!visible) pointer.visible = false;
    },
    render(input) {
      update(title, input.title, { background: "rgba(0,0,0,0)", color: "#9fb3c8", size: 34 });
      for (const [action, plane] of buttons) {
        const hovered = input.hovered === action;
        const danger = action === "leave";
        update(plane, input.labels[action], {
          background: hovered ? (danger ? "#b3261e" : "#2f6fde") : danger && input.armed ? "#7a1d17" : "rgba(255,255,255,0.12)",
          color: "#ffffff",
          size: 40
        });
      }
      pointer.visible = Boolean(input.ray) && group.visible;
      if (input.ray) {
        const length = input.hitDistance ?? 1.2;
        pointerRoot.position.copy(input.ray.origin);
        pointerRoot.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), input.ray.direction.clone().normalize());
        pointer.scale.set(1, 1, length);
      }
    },
    dispose() {
      pointerRoot.removeFromParent();
      group.removeFromParent();
      for (const plane of [title, ...buttons.values()]) {
        plane.texture.dispose();
        plane.mesh.geometry.dispose();
        plane.mesh.material.dispose();
      }
      backdrop.geometry.dispose();
      (backdrop.material as THREE.Material).dispose();
      pointer.geometry.dispose();
      (pointer.material as THREE.Material).dispose();
    }
  };
}
