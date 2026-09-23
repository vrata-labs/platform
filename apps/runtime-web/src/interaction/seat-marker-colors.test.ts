import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  createSeatMarkerGeometries, createSeatMarkerParts, updateSeatMarkerParts, SEAT_MARKER_COLORS
} from "./seat-marker-geometry.js";

// Keep color-space conversion, per-part propagation and animation state separate.
// Failure output records component values, not screenshots or scene lighting.
test("seat marker colors preserve exact palette endpoints on every material", () => {
  const geometry = createSeatMarkerGeometries();
  const parts = createSeatMarkerParts(geometry);
  const snapshot = () => ({
    revision: THREE.REVISION,
    workingSpace: THREE.ColorManagement.workingColorSpace,
    colorManagement: THREE.ColorManagement.enabled,
    parts: Object.fromEntries(Object.entries(parts).filter(([name]) => name !== "hit").map(([name, mesh]) => {
      const material = mesh.material;
      const color = material instanceof THREE.ShaderMaterial ? material.uniforms.tint.value as THREE.Color
        : (material as THREE.MeshBasicMaterial).color;
      return [name, { rgb: color.toArray(), hex: color.getHexString() }];
    }))
  });
  try {
    for (const [name, hex] of Object.entries(SEAT_MARKER_COLORS)) {
      assert.equal(new THREE.Color(hex).getHex(), hex, `palette round trip: ${name}`);
    }
    for (const [emphasis, pending, expected] of [[0, false, SEAT_MARKER_COLORS.free], [1, false, SEAT_MARKER_COLORS.hovered], [0, true, SEAT_MARKER_COLORS.pending], [0.5, true, SEAT_MARKER_COLORS.pending], [0, false, SEAT_MARKER_COLORS.free]] as const) {
      updateSeatMarkerParts(parts, emphasis, pending);
      const actual = snapshot();
      for (const [name, value] of Object.entries(actual.parts)) {
        assert.equal(value.hex, expected.toString(16).padStart(6, "0"), JSON.stringify({ name, emphasis, pending, expected, actual, implementation: updateSeatMarkerParts.toString() }));
      }
    }
  } finally {
    for (const resource of Object.values(geometry)) resource.dispose();
    const materials = new Set(Object.values(parts).map(mesh => mesh.material));
    for (const material of materials) material.dispose();
  }
});
