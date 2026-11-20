type InlineSceneBundleInput = {
  sceneId: string;
  label: string;
  color?: [number, number, number];
  spawn?: { x: number; y: number; z: number };
  spawnYaw?: number;
  renderProfile?: "neutral-pbr";
  seatAnchors?: Array<{ id: string; position: { x: number; y: number; z: number }; seatHeight: number; yaw: number; radius: number }>;
};

function dataUrl(contentType: string, value: unknown): string {
  return `data:${contentType},${encodeURIComponent(JSON.stringify(value))}`;
}

export function inlineSceneBundleUrl(input: InlineSceneBundleInput): string {
  const color = input.color ?? [0.239, 0.545, 0.992];
  const gltf = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0 },
        indices: 1,
        material: 0
      }]
    }],
    materials: [{
      pbrMetallicRoughness: {
        baseColorFactor: [...color, 1],
        metallicFactor: 0,
        roughnessFactor: 1
      },
      doubleSided: true
    }],
    buffers: [{
      uri: "data:application/octet-stream;base64,AACAvwAAAAAAAAAAAACAPwAAAAAAAAAAAAAAAAAAAEAAAAAAAAABAAIAAAA=",
      byteLength: 44
    }],
    bufferViews: [{
      buffer: 0,
      byteOffset: 0,
      byteLength: 36,
      target: 34962
    }, {
      buffer: 0,
      byteOffset: 36,
      byteLength: 6,
      target: 34963
    }],
    accessors: [{
      bufferView: 0,
      componentType: 5126,
      count: 3,
      type: "VEC3",
      min: [-1, 0, 0],
      max: [1, 2, 0]
    }, {
      bufferView: 1,
      componentType: 5123,
      count: 3,
      type: "SCALAR",
      min: [0],
      max: [2]
    }]
  };

  return dataUrl("application/json", {
    schemaVersion: 1,
    sceneId: input.sceneId,
    label: input.label,
    source: "vrata-inline-test-fixture",
    glbPath: dataUrl("model/gltf+json", gltf),
    renderProfile: input.renderProfile,
    spawnPoints: [{
      id: "main",
      position: input.spawn ?? { x: 0, y: 0, z: 4 },
      yaw: input.spawnYaw
    }],
    ...(input.seatAnchors ? { anchors: { teleportFloorY: 0, seatAnchors: input.seatAnchors } } : {}),
    bounds: { width: 20, height: 8, depth: 20 },
    notes: "Inline e2e fixture; public releases do not bundle scene asset files."
  });
}

/** Eight seats in runtime coordinates, the seat identifiers the auto-seat scenarios use. */
export function lightSeatSceneBundleUrl(): string {
  return inlineSceneBundleUrl({ sceneId: "t16-light-seats", label: "Light seats regression", seatAnchors:
    Array.from({ length: 8 }, (_, index) => ({ id: `seat-${String(index + 1).padStart(2, "0")}`,
      position: { x: index - 3.5, y: 0, z: 0 }, seatHeight: .48, yaw: 0, radius: .35 })) });
}
