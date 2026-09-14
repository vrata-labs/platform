import * as THREE from "three";
import { DEFAULT_MEDIA_SURFACE_ID, LAPTOP_MEDIA_SURFACE_ID, WHITEBOARD_MEDIA_SURFACE_ID } from "@vrata/shared-types";
import { LEGACY_MEDIA_SURFACE_NEAR_CONTACT_DISTANCE_M, type SceneBundleMediaSurface } from "../scene-bundle.js";

const WHITEBOARD_PENCIL_CONTACT_DISTANCE_M = LEGACY_MEDIA_SURFACE_NEAR_CONTACT_DISTANCE_M;

export const DEBUG_SURFACE_ID = DEFAULT_MEDIA_SURFACE_ID;
export const DEBUG_SURFACE_WIDTH_M = 5.8;
export const DEBUG_SURFACE_HEIGHT_M = 3.3;
const WHITEBOARD_SURFACE_WIDTH_M = 3.2;
const WHITEBOARD_SURFACE_HEIGHT_M = 2.0;
const LAPTOP_SURFACE_WIDTH_M = 1.9;
const LAPTOP_SURFACE_HEIGHT_M = 1.1;
const DEBUG_SURFACE_WIDTH_PX = 1920;
export const DEBUG_SURFACE_HEIGHT_PX = 1080;

export interface RuntimeMediaSurfaceDefinition {
  surfaceId: string;
  label?: string;
  widthM: number;
  heightM: number;
  widthPx: number;
  heightPx: number;
  position: {
    x: number;
    y: number;
    z: number;
  };
  yaw: number;
  pitch: number;
  roll: number;
  visible: boolean;
  inputEnabled: boolean;
  maxDistanceM: number;
  manifestDefined: boolean;
  manifestFormat: "default" | "f3" | "legacy";
  color: number;
}

export const DEFAULT_RUNTIME_MEDIA_SURFACES: RuntimeMediaSurfaceDefinition[] = [
  {
    surfaceId: DEBUG_SURFACE_ID,
    label: "Main screen",
    widthM: DEBUG_SURFACE_WIDTH_M,
    heightM: DEBUG_SURFACE_HEIGHT_M,
    widthPx: DEBUG_SURFACE_WIDTH_PX,
    heightPx: DEBUG_SURFACE_HEIGHT_PX,
    position: { x: 0, y: 2.2, z: -6.6 },
    yaw: 0,
    pitch: 0,
    roll: 0,
    visible: true,
    inputEnabled: true,
    maxDistanceM: WHITEBOARD_PENCIL_CONTACT_DISTANCE_M,
    manifestDefined: false,
    manifestFormat: "default",
    color: 0xffffff
  },
  {
    surfaceId: WHITEBOARD_MEDIA_SURFACE_ID,
    label: "Whiteboard wall",
    widthM: WHITEBOARD_SURFACE_WIDTH_M,
    heightM: WHITEBOARD_SURFACE_HEIGHT_M,
    widthPx: DEBUG_SURFACE_WIDTH_PX,
    heightPx: DEBUG_SURFACE_HEIGHT_PX,
    position: { x: -4.6, y: 2.0, z: -5.8 },
    yaw: 0.18,
    pitch: 0,
    roll: 0,
    visible: true,
    inputEnabled: true,
    maxDistanceM: WHITEBOARD_PENCIL_CONTACT_DISTANCE_M,
    manifestDefined: false,
    manifestFormat: "default",
    color: 0xf8fafc
  },
  {
    surfaceId: LAPTOP_MEDIA_SURFACE_ID,
    label: "Laptop screen",
    widthM: LAPTOP_SURFACE_WIDTH_M,
    heightM: LAPTOP_SURFACE_HEIGHT_M,
    widthPx: 1280,
    heightPx: 720,
    position: { x: 3.7, y: 1.45, z: -4.2 },
    yaw: -0.28,
    pitch: 0,
    roll: 0,
    visible: true,
    inputEnabled: true,
    maxDistanceM: WHITEBOARD_PENCIL_CONTACT_DISTANCE_M,
    manifestDefined: false,
    manifestFormat: "default",
    color: 0xf8fbff
  }
];

export function createMediaSurfaceMesh(widthM: number, heightM: number, color = 0xffffff): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(widthM, heightM),
    new THREE.MeshBasicMaterial({ color, toneMapped: false })
  );
}

export function applyMediaSurfaceTransform(object: THREE.Object3D, definition: Pick<RuntimeMediaSurfaceDefinition, "position" | "yaw" | "pitch" | "roll">): void {
  object.position.set(definition.position.x, definition.position.y, definition.position.z);
  object.rotation.set(definition.pitch, definition.yaw, definition.roll);
}

export interface RuntimeMediaSurfaceView {
  surfaceId: string;
  label?: string;
  object: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  widthPx: number;
  heightPx: number;
  widthM: number;
  heightM: number;
  visible: boolean;
  inputEnabled: boolean;
  maxDistanceM: number;
  position: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  roll: number;
  manifestPosition: { x: number; y: number; z: number } | null;
  manifestYaw: number | null;
  manifestFormat: "default" | "f3" | "legacy";
}

export function updateMediaSurfaceView(view: RuntimeMediaSurfaceView, definition: RuntimeMediaSurfaceDefinition): void {
  if (view.widthM !== definition.widthM || view.heightM !== definition.heightM) {
    view.object.geometry.dispose();
    view.object.geometry = new THREE.PlaneGeometry(definition.widthM, definition.heightM);
  }
  view.surfaceId = definition.surfaceId;
  view.label = definition.label;
  view.widthPx = definition.widthPx;
  view.heightPx = definition.heightPx;
  view.widthM = definition.widthM;
  view.heightM = definition.heightM;
  view.visible = definition.visible;
  view.inputEnabled = definition.inputEnabled;
  view.maxDistanceM = definition.maxDistanceM;
  view.position = { ...definition.position };
  view.yaw = definition.yaw;
  view.pitch = definition.pitch;
  view.roll = definition.roll;
  view.manifestPosition = definition.manifestDefined ? { ...definition.position } : null;
  view.manifestYaw = definition.manifestDefined ? definition.yaw : null;
  view.manifestFormat = definition.manifestFormat;
  view.object.userData.surfaceId = definition.surfaceId;
  view.object.visible = definition.visible;
  view.object.material.color.setHex(definition.color);
  applyMediaSurfaceTransform(view.object, definition);
}

export function createMediaSurfaceView(definition: RuntimeMediaSurfaceDefinition, object = createMediaSurfaceMesh(definition.widthM, definition.heightM, definition.color)): RuntimeMediaSurfaceView {
  const view: RuntimeMediaSurfaceView = {
    surfaceId: definition.surfaceId,
    label: definition.label,
    object,
    widthPx: definition.widthPx,
    heightPx: definition.heightPx,
    widthM: definition.widthM,
    heightM: definition.heightM,
    visible: definition.visible,
    inputEnabled: definition.inputEnabled,
    maxDistanceM: definition.maxDistanceM,
    position: { ...definition.position },
    yaw: definition.yaw,
    pitch: definition.pitch,
    roll: definition.roll,
    manifestPosition: definition.manifestDefined ? { ...definition.position } : null,
    manifestYaw: definition.manifestDefined ? definition.yaw : null,
    manifestFormat: definition.manifestFormat
  };
  updateMediaSurfaceView(view, definition);
  return view;
}

export function runtimeMediaSurfaceDefinitionFromScene(surface: SceneBundleMediaSurface): RuntimeMediaSurfaceDefinition {
  const fallback = DEFAULT_RUNTIME_MEDIA_SURFACES.find((definition) => definition.surfaceId === surface.surfaceId);
  return {
    surfaceId: surface.surfaceId,
    label: surface.label ?? fallback?.label,
    widthM: surface.widthM,
    heightM: surface.heightM,
    widthPx: surface.pixelDimensions.width ?? fallback?.widthPx ?? DEBUG_SURFACE_WIDTH_PX,
    heightPx: surface.pixelDimensions.height ?? fallback?.heightPx ?? DEBUG_SURFACE_HEIGHT_PX,
    position: {
      x: surface.position.x,
      y: surface.position.y,
      z: surface.position.z
    },
    yaw: surface.yaw,
    pitch: surface.pitch,
    roll: surface.roll,
    visible: surface.visible,
    inputEnabled: surface.input.enabled,
    maxDistanceM: surface.input.maxDistanceM,
    manifestDefined: true,
    manifestFormat: surface.manifestFormat,
    color: fallback?.color ?? 0xffffff
  };
}
