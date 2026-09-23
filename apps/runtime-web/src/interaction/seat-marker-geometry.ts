import * as THREE from "three";

// Design dimensions, in metres; anchor.radius is an interaction tolerance, not upholstery size.
export const SEAT_MARKER_DIMENSIONS = Object.freeze({
  diameter: 0.38,
  height: 0.12,
  // Keep the original picking envelope independent of the smaller artwork.
  hitDiameter: 0.44,
  hitHeight: 0.14,
  seatGap: 0.02,
  capThickness: 0.013,
  rimThickness: 0.0035,
  arrowWidth: 0.12,
  arrowLift: 0.0026
});
export const SEAT_MARKER_COLORS = Object.freeze({ free: 0x64d7ff, hovered: 0xa1efff, pending: 0xffd166 });

export function createSeatMarkerGeometries() {
  const d = SEAT_MARKER_DIMENSIONS;
  const radius = (d.diameter - d.rimThickness) / 2;
  const arrow = new THREE.Shape();
  const halfWidth = d.arrowWidth / 2;
  // Scale every chevron coordinate from its original 14 cm width, not just the span.
  const arrowScale = d.arrowWidth / 0.14;
  // The symmetric chevron tip is local -Z, like the seated camera's forward axis.
  arrow.moveTo(-halfWidth, -0.015 * arrowScale);
  arrow.lineTo(-halfWidth + 0.017 * arrowScale, -0.034 * arrowScale);
  arrow.lineTo(0, 0.018 * arrowScale);
  arrow.lineTo(halfWidth - 0.017 * arrowScale, -0.034 * arrowScale);
  arrow.lineTo(halfWidth, -0.015 * arrowScale);
  arrow.lineTo(0, 0.052 * arrowScale);
  arrow.closePath();
  return {
    disk: new THREE.CircleGeometry(radius, 48).rotateX(-Math.PI / 2),
    side: new THREE.CylinderGeometry(radius, radius, d.height - d.capThickness, 48, 1, true),
    cap: new THREE.CylinderGeometry(radius, radius, d.capThickness, 48, 1, true),
    rim: new THREE.TorusGeometry(radius, d.rimThickness / 2, 6, 48).rotateX(Math.PI / 2),
    arrow: new THREE.ShapeGeometry(arrow).rotateX(-Math.PI / 2),
    hit: new THREE.CylinderGeometry(d.hitDiameter / 2, d.hitDiameter / 2, d.hitHeight, 24)
  };
}
export type SeatMarkerGeometries = ReturnType<typeof createSeatMarkerGeometries>;

const HOVER_COLOR = new THREE.Color(SEAT_MARKER_COLORS.hovered);

function basicMaterial(opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: SEAT_MARKER_COLORS.free, opacity, transparent: true,
    depthTest: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, forceSinglePass: true
  });
}

function sideMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      tint: { value: new THREE.Color(SEAT_MARKER_COLORS.free) },
      strength: { value: 0 }
    },
    vertexShader: `
      varying float markerHeight;
      void main() {
        markerHeight = uv.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 tint;
      uniform float strength;
      varying float markerHeight;
      void main() {
        float edge = pow(abs(markerHeight * 2.0 - 1.0), 3.0);
        float alpha = mix(0.12, 0.40, edge) + strength * mix(0.10, 0.16, edge);
        gl_FragColor = vec4(tint, alpha);
        #include <colorspace_fragment>
      }
    `,
    transparent: true, depthTest: true, depthWrite: false,
    toneMapped: false, side: THREE.DoubleSide
  });
}

export function createSeatMarkerParts(geometry: SeatMarkerGeometries) {
  const d = SEAT_MARKER_DIMENSIONS;
  const top = new THREE.Mesh(geometry.disk, basicMaterial(0.19));
  const bottom = new THREE.Mesh(geometry.disk, basicMaterial(0.12));
  const side = new THREE.Mesh(geometry.side, sideMaterial());
  const cap = new THREE.Mesh(geometry.cap, basicMaterial(0.30));
  const rimMaterial = basicMaterial(0.82);
  const upperRim = new THREE.Mesh(geometry.rim, rimMaterial);
  const lowerRim = new THREE.Mesh(geometry.rim, rimMaterial);
  const direction = new THREE.Mesh(geometry.arrow, basicMaterial(0.98));
  const hit = new THREE.Mesh(geometry.hit, new THREE.MeshBasicMaterial({
    visible: false, depthWrite: false, colorWrite: false, side: THREE.DoubleSide
  }));
  bottom.position.y = d.seatGap;
  side.position.y = d.seatGap + (d.height - d.capThickness) / 2;
  cap.position.y = d.seatGap + d.height - d.capThickness / 2;
  top.position.y = d.seatGap + d.height;
  lowerRim.position.y = d.seatGap + d.rimThickness / 2;
  upperRim.position.y = d.seatGap + d.height - d.rimThickness / 2;
  direction.position.y = top.position.y + d.arrowLift;
  hit.position.y = d.seatGap + d.hitHeight / 2;
  const parts = { bottom, side, cap, top, lowerRim, upperRim, direction, hit };
  // Opaque furniture still occludes these surfaces; only their internal blending order is fixed.
  for (const [index, [name, mesh]] of Object.entries(parts).entries()) {
    mesh.name = `seat-marker-${name}`;
    mesh.renderOrder = index;
  }
  return parts;
}
export type SeatMarkerParts = ReturnType<typeof createSeatMarkerParts>;

export function updateSeatMarkerParts(parts: SeatMarkerParts, emphasis: number, pending: boolean): void {
  const color = parts.top.material.color;
  color.setHex(pending ? SEAT_MARKER_COLORS.pending : SEAT_MARKER_COLORS.free);
  if (!pending) color.lerp(HOVER_COLOR, emphasis);
  parts.bottom.material.color.copy(color);
  parts.cap.material.color.copy(color);
  parts.lowerRim.material.color.copy(color);
  parts.direction.material.color.copy(color);
  parts.side.material.uniforms.tint.value.copy(color);
  parts.side.material.uniforms.strength.value = emphasis;
  parts.top.material.opacity = 0.19 + emphasis * 0.13;
  parts.bottom.material.opacity = 0.12 + emphasis * 0.08;
  parts.cap.material.opacity = 0.30 + emphasis * 0.16;
  parts.lowerRim.material.opacity = 0.82 + emphasis * 0.18;
}
