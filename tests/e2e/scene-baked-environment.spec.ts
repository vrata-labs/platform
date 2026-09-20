import { expect, test } from "@playwright/test";
import { deflateSync } from "node:zlib";

function whitePixelPng() {
  function chunk(type: string, data: Buffer) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255, 255]))), chunk("IEND", Buffer.alloc(0))
  ]).toString("base64");
}

function fixtureBundle() {
  const bytes = Buffer.alloc(140);
  [-.9, 0, 0, .9, 0, 0, .9, 3, 0, -.9, 3, 0].forEach((v, i) => bytes.writeFloatLE(v, i * 4));
  [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1].forEach((v, i) => bytes.writeFloatLE(v, 48 + i * 4));
  [0, 0, 1, 0, 1, 1, 0, 1].forEach((v, i) => bytes.writeFloatLE(v, 96 + i * 4));
  [0, 1, 2, 0, 2, 3].forEach((v, i) => bytes.writeUInt16LE(v, 128 + i * 2));
  const gltf = {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0, translation: [-1.1, 0, 0] }, { mesh: 1, translation: [1.1, 0, 0] }],
    meshes: [0, 1].map(material => ({ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_1: 2 }, indices: 3, material }] })),
    materials: [false, true].map(complete => ({
      name: complete ? "complete-irradiance" : "legacy-irradiance",
      pbrMetallicRoughness: { baseColorFactor: [.5, .5, .5, 1], metallicFactor: 0, roughnessFactor: .7 },
      emissiveFactor: [1, 1, 1], emissiveTexture: { index: 0, texCoord: 1 },
      extras: { vrataLightMap: true, vrataLightMapIntensity: 2, vrataOriginalEmissive: [0, 0, 0], vrataOriginalEmissiveIntensity: 0, vrataLightMapIncludesEnvironment: complete }
    })),
    textures: [{ source: 0 }],
    images: [{ uri: `data:image/png;base64,${whitePixelPng()}` }],
    buffers: [{ uri: `data:application/octet-stream;base64,${bytes.toString("base64")}`, byteLength: bytes.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48, target: 34962 },
      { buffer: 0, byteOffset: 48, byteLength: 48, target: 34962 },
      { buffer: 0, byteOffset: 96, byteLength: 32, target: 34962 },
      { buffer: 0, byteOffset: 128, byteLength: 12, target: 34963 }
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [-.9, 0, 0], max: [.9, 3, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 4, type: "VEC2" },
      { bufferView: 3, componentType: 5123, count: 6, type: "SCALAR" }
    ]
  };
  const dataUrl = (type: string, value: unknown) => `data:${type},${encodeURIComponent(JSON.stringify(value))}`;
  return dataUrl("application/json", {
    schemaVersion: 1, sceneId: "baked-environment-fixture", label: "Baked environment fixture", source: "project-authored e2e fixture",
    glbPath: dataUrl("model/gltf+json", gltf), renderMode: "clean", renderProfile: "baked-pbr-v1",
    spawnPoints: [{ id: "main", position: { x: 0, y: 0, z: 4 }, yaw: 0 }], bounds: { width: 10, height: 4, depth: 10 }
  });
}

test("baked environment compiles both complete and legacy irradiance materials", async ({ page, request }) => {
  const shaderErrors: string[] = [];
  page.on("pageerror", error => shaderErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && /shader|WebGLProgram|VALIDATE_STATUS/i.test(message.text())) shaderErrors.push(message.text());
  });
  const response = await request.post("/api/rooms", { headers: { "x-vrata-admin-token": "test-admin-token" }, data: {
    tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Baked environment material fixture", sceneBundleUrl: fixtureBundle(), guestAllowed: true
  } });
  expect(response.ok()).toBeTruthy();
  const room = await response.json();
  try {
    await page.goto(`/rooms/${room.roomId}?debug=1&scenefit=0`);
    await expect.poll(async () => page.evaluate(() => {
      const debug = (window as Window & { __VRATA_DEBUG__?: { sceneDebug?: { state?: string; failureReason?: string | null; materialSamples?: Array<{ name: string; bakedEnvironmentMode?: string }> } } }).__VRATA_DEBUG__?.sceneDebug;
      return { state: debug?.state, failureReason: debug?.failureReason, modes: Object.fromEntries((debug?.materialSamples ?? []).map(m => [m.name, m.bakedEnvironmentMode])) };
    }), { timeout: 30000 }).toEqual({ state: "loaded", failureReason: null, modes: { "legacy-irradiance": "legacy", "complete-irradiance": "specular-only" } });
    expect(shaderErrors).toEqual([]);
  } finally {
    const deleted = await request.delete(`/api/rooms/${room.roomId}`, { headers: { "x-vrata-admin-token": "test-admin-token" } });
    expect(deleted.ok()).toBeTruthy();
  }
});
