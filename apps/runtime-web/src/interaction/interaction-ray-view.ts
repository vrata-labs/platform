import * as THREE from "three";

import type { InteractionRayDebugSample } from "./interaction-ray.js";
import type { InteractionTarget } from "./interaction-targets.js";

export type InteractionRayMode = "none" | "cursor" | "xr-right-stick";

export interface InteractionRayDebugState {
  active: boolean;
  mode: InteractionRayMode;
  targetKind: "none" | "floor" | "seat" | "surface";
  seatId: string | null;
  point: null | { x: number; y: number; z: number };
  origin: null | { x: number; y: number; z: number };
  direction: null | { x: number; y: number; z: number };
  source: null | { index: number; handedness: string | null };
}

export interface InteractionRayView {
  lineGeometry: THREE.BufferGeometry;
  lineMaterial: THREE.LineBasicMaterial;
  line: THREE.Line;
  beamMaterial: THREE.MeshBasicMaterial;
  beam: THREE.Mesh;
  reticleMaterial: THREE.MeshBasicMaterial;
  reticle: THREE.Mesh;
  end: THREE.Vector3;
  beamMidpoint: THREE.Vector3;
  beamDirection: THREE.Vector3;
  beamUp: THREE.Vector3;
  points: [THREE.Vector3, THREE.Vector3];
}

function roundPoint(point: THREE.Vector3): { x: number; y: number; z: number } {
  return {
    x: Number(point.x.toFixed(2)),
    y: Number(point.y.toFixed(2)),
    z: Number(point.z.toFixed(2))
  };
}

export function createInteractionRayView(scene: THREE.Scene): InteractionRayView {
  const lineGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -1)
  ]);
  const lineMaterial = new THREE.LineBasicMaterial({
    color: 0x00f6ff,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false
  });
  const line = new THREE.Line(lineGeometry, lineMaterial);
  line.visible = false;
  line.renderOrder = 1000;
  scene.add(line);

  const beamMaterial = new THREE.MeshBasicMaterial({
    color: 0x00f6ff,
    transparent: true,
    opacity: 0.82,
    depthTest: false,
    depthWrite: false,
    toneMapped: false
  });
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.025, 1, 12, 1, true),
    beamMaterial
  );
  beam.visible = false;
  beam.renderOrder = 1001;
  scene.add(beam);

  const reticleMaterial = new THREE.MeshBasicMaterial({
    color: 0x00f6ff,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
    toneMapped: false
  });
  const reticle = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 16, 16),
    reticleMaterial
  );
  reticle.visible = false;
  reticle.renderOrder = 1002;
  scene.add(reticle);

  return {
    lineGeometry,
    lineMaterial,
    line,
    beamMaterial,
    beam,
    reticleMaterial,
    reticle,
    end: new THREE.Vector3(),
    beamMidpoint: new THREE.Vector3(),
    beamDirection: new THREE.Vector3(),
    beamUp: new THREE.Vector3(0, 1, 0),
    points: [new THREE.Vector3(), new THREE.Vector3()]
  };
}

export function clearInteractionRayView(input: {
  view: InteractionRayView;
  state: InteractionRayDebugState;
  mode?: InteractionRayMode;
  markTelemetry?: (kind: string) => void;
  forceRayOffTelemetry?: boolean;
}): void {
  if (input.state.active || input.forceRayOffTelemetry) {
    input.markTelemetry?.("ray_off");
  }
  input.view.line.visible = false;
  input.view.beam.visible = false;
  input.view.reticle.visible = false;
  input.state.active = false;
  input.state.mode = input.mode ?? input.state.mode;
  input.state.targetKind = "none";
  input.state.seatId = null;
  input.state.point = null;
  input.state.origin = null;
  input.state.direction = null;
  input.state.source = null;
}

export function setInteractionRayDebugTarget(input: {
  state: InteractionRayDebugState;
  target: InteractionTarget;
  mode: InteractionRayMode;
  debug?: InteractionRayDebugSample | null;
}): void {
  input.state.active = true;
  input.state.mode = input.mode;
  input.state.targetKind = input.target.kind;
  input.state.seatId = input.target.kind === "seat" ? input.target.seatAnchor.id : null;
  input.state.point = input.target.kind === "none" ? null : roundPoint(input.target.point);
  if (input.debug) {
    input.state.origin = input.debug.origin;
    input.state.direction = input.debug.direction;
    input.state.source = input.debug.source;
  }
}

export function showInteractionRayView(input: {
  view: InteractionRayView;
  state: InteractionRayDebugState;
  ray: THREE.Ray;
  target: Exclude<InteractionTarget, { kind: "none" }>;
  mode: InteractionRayMode;
  debug?: InteractionRayDebugSample | null;
  markTelemetry?: (kind: string) => void;
}): void {
  const color = input.target.kind === "seat" ? 0xb8ff8d : 0x00f6ff;
  showInteractionRayPointView({
    view: input.view,
    state: input.state,
    ray: input.ray,
    point: input.target.point,
    targetKind: input.target.kind,
    mode: input.mode,
    debug: input.debug,
    color,
    markTelemetry: input.markTelemetry
  });
  input.state.seatId = input.target.kind === "seat" ? input.target.seatAnchor.id : null;
}

export function showInteractionRayPointView(input: {
  view: InteractionRayView;
  state: InteractionRayDebugState;
  ray: THREE.Ray;
  point: THREE.Vector3;
  targetKind: Exclude<InteractionRayDebugState["targetKind"], "none">;
  mode: InteractionRayMode;
  debug?: InteractionRayDebugSample | null;
  color?: number;
  markTelemetry?: (kind: string) => void;
}): void {
  const color = input.color ?? 0x00f6ff;
  const view = input.view;

  view.points[0].copy(input.ray.origin);
  view.end.copy(input.point);
  view.points[1].copy(view.end);
  view.lineGeometry.setFromPoints(view.points);

  const length = view.end.distanceTo(input.ray.origin);
  view.line.visible = true;
  view.lineMaterial.color.setHex(color);
  if (length > 0.001) {
    view.beamDirection.copy(view.end).sub(input.ray.origin).normalize();
    view.beamMidpoint.copy(input.ray.origin).add(view.end).multiplyScalar(0.5);
    view.beam.position.copy(view.beamMidpoint);
    view.beam.quaternion.setFromUnitVectors(view.beamUp, view.beamDirection);
    view.beam.scale.set(1, length, 1);
    view.beam.visible = true;
    view.beamMaterial.color.setHex(color);
  } else {
    view.beam.visible = false;
  }

  view.reticle.visible = true;
  view.reticle.position.copy(input.point);
  view.reticleMaterial.color.setHex(color);
  input.state.active = true;
  input.state.mode = input.mode;
  input.state.targetKind = input.targetKind;
  input.state.seatId = null;
  input.state.point = roundPoint(input.point);
  if (input.debug) {
    input.state.origin = input.debug.origin;
    input.state.direction = input.debug.direction;
    input.state.source = input.debug.source;
  }
  input.markTelemetry?.("ray_on");
}
