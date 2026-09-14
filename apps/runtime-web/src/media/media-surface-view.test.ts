import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { DEFAULT_MEDIA_SURFACE_ID, LAPTOP_MEDIA_SURFACE_ID, WHITEBOARD_MEDIA_SURFACE_ID } from "@vrata/shared-types";
import type { SceneBundleMediaSurface } from "../scene-bundle.js";
import {
  DEBUG_SURFACE_ID,
  DEBUG_SURFACE_WIDTH_M,
  DEBUG_SURFACE_HEIGHT_M,
  DEBUG_SURFACE_HEIGHT_PX,
  DEFAULT_RUNTIME_MEDIA_SURFACES,
  applyMediaSurfaceTransform,
  createMediaSurfaceMesh,
  createMediaSurfaceView,
  runtimeMediaSurfaceDefinitionFromScene,
  updateMediaSurfaceView,
  type RuntimeMediaSurfaceDefinition
} from "./media-surface-view.js";

function definition(overrides: Partial<RuntimeMediaSurfaceDefinition> = {}): RuntimeMediaSurfaceDefinition {
  return {
    ...DEFAULT_RUNTIME_MEDIA_SURFACES[0]!,
    position: { x: 1, y: 2, z: -3 },
    ...overrides
  };
}

function sceneSurface(overrides: Partial<SceneBundleMediaSurface> = {}): SceneBundleMediaSurface {
  return {
    surfaceId: "scene-screen",
    manifestFormat: "f3",
    representation: "platform-runtime-plane",
    frontFace: "local-positive-z",
    position: { x: 1, y: 2, z: -3 },
    yaw: 0.4,
    pitch: 0.2,
    roll: -0.3,
    widthM: 4,
    heightM: 2,
    pixelDimensions: {},
    input: { enabled: true, maxDistanceM: 1.25 },
    visible: true,
    ...overrides
  };
}

function disposeMesh(mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>): void {
  mesh.geometry.dispose();
  mesh.material.dispose();
}

test("default media surfaces preserve order, dimensions, placement, colors and contact distance", () => {
  assert.equal(DEBUG_SURFACE_ID, DEFAULT_MEDIA_SURFACE_ID);
  assert.equal(DEBUG_SURFACE_WIDTH_M, 5.8);
  assert.equal(DEBUG_SURFACE_HEIGHT_M, 3.3);
  assert.equal(DEBUG_SURFACE_HEIGHT_PX, 1080);
  const common = {
    pitch: 0, roll: 0, visible: true, inputEnabled: true,
    maxDistanceM: 0.06, manifestDefined: false, manifestFormat: "default"
  };
  assert.deepEqual(DEFAULT_RUNTIME_MEDIA_SURFACES, [
    {
      ...common, surfaceId: DEFAULT_MEDIA_SURFACE_ID, label: "Main screen",
      widthM: 5.8, heightM: 3.3, widthPx: 1920, heightPx: 1080,
      position: { x: 0, y: 2.2, z: -6.6 }, yaw: 0, color: 0xffffff
    },
    {
      ...common, surfaceId: WHITEBOARD_MEDIA_SURFACE_ID, label: "Whiteboard wall",
      widthM: 3.2, heightM: 2.0, widthPx: 1920, heightPx: 1080,
      position: { x: -4.6, y: 2.0, z: -5.8 }, yaw: 0.18, color: 0xf8fafc
    },
    {
      ...common, surfaceId: LAPTOP_MEDIA_SURFACE_ID, label: "Laptop screen",
      widthM: 1.9, heightM: 1.1, widthPx: 1280, heightPx: 720,
      position: { x: 3.7, y: 1.45, z: -4.2 }, yaw: -0.28, color: 0xf8fbff
    }
  ]);
});

test("createMediaSurfaceMesh preserves plane and material defaults", () => {
  const mesh = createMediaSurfaceMesh(4, 2);
  try {
    assert.ok(mesh.geometry instanceof THREE.PlaneGeometry);
    assert.equal(mesh.geometry.parameters.width, 4);
    assert.equal(mesh.geometry.parameters.height, 2);
    assert.ok(mesh.material instanceof THREE.MeshBasicMaterial);
    assert.equal(mesh.material.color.getHex(), 0xffffff);
    assert.equal(mesh.material.toneMapped, false);
    assert.equal(mesh.material.side, THREE.FrontSide);
    assert.equal(mesh.parent, null);
  } finally {
    disposeMesh(mesh);
  }
});

test("createMediaSurfaceMesh accepts a custom color without tone mapping", () => {
  const mesh = createMediaSurfaceMesh(1.9, 1.1, 0xf8fbff);
  try {
    assert.equal(mesh.material.color.getHex(), 0xf8fbff);
    assert.equal(mesh.material.toneMapped, false);
  } finally {
    disposeMesh(mesh);
  }
});

test("applyMediaSurfaceTransform preserves pitch/yaw/roll ordering and existing Euler order", () => {
  const object = new THREE.Object3D();
  object.rotation.order = "YXZ";
  object.scale.set(2, 3, 4);
  const input = definition({ yaw: 0.4, pitch: 0.2, roll: -0.3 });
  const before = structuredClone(input);
  applyMediaSurfaceTransform(object, input);
  assert.deepEqual(object.position.toArray(), [1, 2, -3]);
  assert.deepEqual(object.rotation.toArray(), [0.2, 0.4, -0.3, "YXZ"]);
  assert.deepEqual(object.scale.toArray(), [2, 3, 4]);
  assert.deepEqual(input, before);
});

test("createMediaSurfaceView initializes all metadata and independent manifest coordinates", () => {
  const input = definition({ label: "Scene screen", manifestDefined: true, manifestFormat: "f3" });
  const before = structuredClone(input);
  const view = createMediaSurfaceView(input);
  try {
    const { object, ...metadata } = view;
    const { color, manifestDefined, ...expected } = input;
    assert.deepEqual(metadata, { ...expected, manifestPosition: input.position, manifestYaw: input.yaw });
    assert.notEqual(view.position, input.position);
    assert.notEqual(view.manifestPosition, input.position);
    assert.notEqual(view.position, view.manifestPosition);
    assert.equal(object.userData.surfaceId, input.surfaceId);
    assert.equal(object.visible, input.visible);
    assert.equal(object.material.color.getHex(), color);
    assert.equal(manifestDefined, true);
    assert.deepEqual(input, before);
  } finally {
    disposeMesh(view.object);
  }
});

test("createMediaSurfaceView reuses a supplied mesh and retains its parent, material and children", () => {
  const input = definition();
  const mesh = createMediaSurfaceMesh(input.widthM, input.heightM, 0x123456);
  const parent = new THREE.Group();
  const preview = new THREE.Object3D();
  parent.add(mesh);
  mesh.add(preview);
  mesh.userData.custom = "keep";
  const geometry = mesh.geometry;
  const material = mesh.material;
  const view = createMediaSurfaceView(input, mesh);
  try {
    assert.equal(view.object, mesh);
    assert.equal(mesh.parent, parent);
    assert.deepEqual(mesh.children, [preview]);
    assert.equal(mesh.geometry, geometry);
    assert.equal(mesh.material, material);
    assert.equal(mesh.userData.custom, "keep");
    assert.equal(mesh.material.color.getHex(), input.color);
    assert.equal(view.manifestPosition, null);
    assert.equal(view.manifestYaw, null);
  } finally {
    disposeMesh(mesh);
  }
});

for (const dimension of ["widthM", "heightM"] as const) {
  test(`updateMediaSurfaceView disposes old geometry before replacing a changed ${dimension}`, () => {
    const input = definition();
    const view = createMediaSurfaceView(input);
    const previousGeometry = view.object.geometry;
    const previousMaterial = view.object.material;
    let disposals = 0;
    previousGeometry.addEventListener("dispose", () => {
      disposals += 1;
      assert.equal(view.object.geometry, previousGeometry);
      assert.equal(view[dimension], input[dimension]);
    });
    const next = definition({ [dimension]: input[dimension] + 1 });
    updateMediaSurfaceView(view, next);
    try {
      assert.equal(disposals, 1);
      assert.notEqual(view.object.geometry, previousGeometry);
      assert.equal(view.object.material, previousMaterial);
      assert.equal(view.object.geometry.parameters.width, next.widthM);
      assert.equal(view.object.geometry.parameters.height, next.heightM);
      assert.equal(view.widthM, next.widthM);
      assert.equal(view.heightM, next.heightM);
      updateMediaSurfaceView(view, next);
      assert.equal(disposals, 1);
    } finally {
      disposeMesh(view.object);
    }
  });
}

test("pixel and metadata updates preserve geometry, material and texture identity", () => {
  const view = createMediaSurfaceView(definition());
  const geometry = view.object.geometry;
  const material = view.object.material;
  const texture = new THREE.Texture();
  view.object.material.map = texture;
  let disposals = 0;
  geometry.addEventListener("dispose", () => { disposals += 1; });
  const next = definition({
    surfaceId: "updated", label: undefined, widthPx: 800, heightPx: 600,
    visible: false, inputEnabled: false, maxDistanceM: 2.5,
    position: { x: -4, y: 3, z: 2 }, yaw: 0.5, pitch: -0.6, roll: 0.7,
    color: 0x123456, manifestDefined: true, manifestFormat: "legacy"
  });
  const before = structuredClone(next);
  updateMediaSurfaceView(view, next);
  try {
    assert.equal(disposals, 0);
    assert.equal(view.object.geometry, geometry);
    assert.equal(view.object.material, material);
    assert.equal(view.object.material.map, texture);
    assert.equal(view.object.material.color.getHex(), 0x123456);
    assert.equal(view.object.visible, false);
    assert.equal(view.object.userData.surfaceId, "updated");
    assert.deepEqual(view.object.position.toArray(), [-4, 3, 2]);
    assert.deepEqual(view.object.rotation.toArray(), [-0.6, 0.5, 0.7, "XYZ"]);
    const { object: _object, ...metadata } = view;
    const { color: _color, manifestDefined: _manifestDefined, ...expected } = next;
    assert.deepEqual(metadata, { ...expected, manifestPosition: next.position, manifestYaw: next.yaw });
    assert.deepEqual(next, before);
    next.position.x = 99;
    assert.equal(view.position.x, -4);
    assert.equal(view.manifestPosition?.x, -4);
  } finally {
    disposeMesh(view.object);
    texture.dispose();
  }
});

test("returning to a default surface clears manifest metadata and an absent label", () => {
  const view = createMediaSurfaceView(definition({ manifestDefined: true, manifestFormat: "f3", label: "Old" }));
  try {
    updateMediaSurfaceView(view, definition({ label: undefined }));
    assert.equal(view.label, undefined);
    assert.equal(view.manifestPosition, null);
    assert.equal(view.manifestYaw, null);
    assert.equal(view.manifestFormat, "default");
  } finally {
    disposeMesh(view.object);
  }
});

test("scene conversion copies all manifest fields and defaults unknown pixel dimensions and color", () => {
  const input = sceneSurface({ visible: false, input: { enabled: false, maxDistanceM: 0.75 } });
  const before = structuredClone(input);
  const result = runtimeMediaSurfaceDefinitionFromScene(input);
  assert.deepEqual(result, {
    surfaceId: "scene-screen", label: undefined, widthM: 4, heightM: 2,
    widthPx: 1920, heightPx: 1080, position: { x: 1, y: 2, z: -3 },
    yaw: 0.4, pitch: 0.2, roll: -0.3, visible: false, inputEnabled: false,
    maxDistanceM: 0.75, manifestDefined: true, manifestFormat: "f3", color: 0xffffff
  });
  assert.notEqual(result.position, input.position);
  assert.deepEqual(input, before);
  input.position.x = 99;
  assert.equal(result.position.x, 1);
});

for (const fallback of DEFAULT_RUNTIME_MEDIA_SURFACES) {
  test(`scene conversion inherits label, pixel size and color for ${fallback.surfaceId}`, () => {
    const result = runtimeMediaSurfaceDefinitionFromScene(sceneSurface({ surfaceId: fallback.surfaceId }));
    assert.equal(result.label, fallback.label);
    assert.equal(result.widthPx, fallback.widthPx);
    assert.equal(result.heightPx, fallback.heightPx);
    assert.equal(result.color, fallback.color);
    assert.equal(result.widthM, 4);
    assert.equal(result.heightM, 2);
    assert.equal(result.manifestDefined, true);
  });
}

test("explicit scene labels and pixel dimensions take precedence over known defaults", () => {
  const result = runtimeMediaSurfaceDefinitionFromScene(sceneSurface({
    surfaceId: LAPTOP_MEDIA_SURFACE_ID, label: "Custom laptop",
    pixelDimensions: { width: 2048, height: 1024 }, manifestFormat: "legacy"
  }));
  assert.equal(result.label, "Custom laptop");
  assert.equal(result.widthPx, 2048);
  assert.equal(result.heightPx, 1024);
  assert.equal(result.manifestFormat, "legacy");
});

test("scene conversion resolves missing width and height independently", () => {
  const widthOnly = runtimeMediaSurfaceDefinitionFromScene(sceneSurface({
    surfaceId: LAPTOP_MEDIA_SURFACE_ID, pixelDimensions: { width: 800 }
  }));
  const heightOnly = runtimeMediaSurfaceDefinitionFromScene(sceneSurface({
    surfaceId: LAPTOP_MEDIA_SURFACE_ID, pixelDimensions: { height: 600 }
  }));
  assert.deepEqual([widthOnly.widthPx, widthOnly.heightPx], [800, 720]);
  assert.deepEqual([heightOnly.widthPx, heightOnly.heightPx], [1280, 600]);
});

test("scene conversion retains nullish fallback semantics instead of adding validation", () => {
  // Validation belongs to scene-bundle parsing, not this conversion boundary.
  const result = runtimeMediaSurfaceDefinitionFromScene(sceneSurface({
    surfaceId: LAPTOP_MEDIA_SURFACE_ID, label: "", pixelDimensions: { width: 0, height: 0 }
  }));
  assert.equal(result.label, "");
  assert.equal(result.widthPx, 0);
  assert.equal(result.heightPx, 0);
});
