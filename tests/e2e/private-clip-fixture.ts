import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

export async function privateClipFixture() {
  // Optional operator-owned fixtures never enter the repo or public asset service.
  const dir = process.env.VRATA_LOCAL_CLIP_BUNDLE;
  if (dir) {
    const manifest = await readFile(resolve(dir, "scene.json"), "utf8");
    const sound = JSON.parse(manifest).sceneEffects?.[0]?.audio?.path as string | undefined;
    return {
      manifest,
      model: await readFile(resolve(dir, "scene.glb")),
      archive: await readFile(resolve(process.env.VRATA_LOCAL_CLIP_ARCHIVE!)),
      artifact: await readFile(resolve(process.env.VRATA_LOCAL_CLIP_PLUGIN!)),
      sound: sound ? { path: sound, bytes: await readFile(resolve(dir, sound)) } : undefined,
    };
  }
  const meshData = Buffer.from(new Float32Array([-1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, .5, 1]).buffer);
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==", "base64");
  const data = Buffer.concat([meshData, pixel], Math.ceil((meshData.length + pixel.length) / 4) * 4);
  const gltf = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0, 1, 3, 4, 11] }],
    nodes: [
      { name: "mover", mesh: 0 },
      { name: "switch-mount", mesh: 0, translation: [0, 1.5, 1], scale: [.3, .3, .3], children: [2] },
      { name: "switch-handle", mesh: 0, translation: [.2, .2, .1], scale: [.4, .4, .4] },
      { name: "glow", mesh: 1, translation: [-1, 1, 0] },
      { name: "tethered-body", translation: [1,0,1], children: [5, 8, 9, 10] },
      { name: "tethered-handle", mesh: 0, translation: [0,1.2,0], scale: [.1,.1,.1], children: [6,7] },
      { name: "tethered-tip", translation: [.5,0,0] },
      { name: "tethered-end", translation: [-.5,0,0] },
      { name: "tethered-connector", translation: [0,.8,0] },
      { name: "tethered-rest", mesh: 0, translation: [0,.8,0], scale: [.05,.05,.05] },
      { name: "tethered-sound" },
      { name: "tethered-smoke", mesh: 1 }
    ],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0 } }] },
      { primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 3 }, material: 0 }] }
    ],
    images: [{ mimeType: "image/png", bufferView: 4 }],
    textures: [{ source: 0 }],
    materials: [{
      pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
      emissiveTexture: { index: 0 }, emissiveFactor: [1, .5, .1]
    }],
    buffers: [{ byteLength: meshData.length + pixel.length }],
    bufferViews: [
      { buffer: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 8 },
      { buffer: 0, byteOffset: 44, byteLength: 24 },
      { buffer: 0, byteOffset: 68, byteLength: 24 },
      { buffer: 0, byteOffset: meshData.length, byteLength: pixel.length }
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-1, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 2, type: "SCALAR", min: [0], max: [2] },
      { bufferView: 2, componentType: 5126, count: 2, type: "VEC3" },
      { bufferView: 3, componentType: 5126, count: 3, type: "VEC2" }
    ],
    animations: [
      {
        name: "glide",
        samplers: [{ input: 1, output: 2 }],
        channels: [{ sampler: 0, target: { node: 0, path: "translation" } }],
      },
    ],
  };
  const text = JSON.stringify(gltf),
    chunk = Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4, " "));
  const model = Buffer.alloc(28 + chunk.length + data.length);
  [0x46546c67, 2, model.length, chunk.length, 0x4e4f534a].forEach((v, i) => model.writeUInt32LE(v, i * 4));
  chunk.copy(model, 20);
  model.writeUInt32LE(data.length, 20 + chunk.length);
  model.writeUInt32LE(0x004e4942, 24 + chunk.length);
  data.copy(model, 28 + chunk.length);
  const rate = 24_000, audio = Buffer.alloc(44 + rate * 2);
  audio.write("RIFF", 0); audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8); audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(rate, 24); audio.writeUInt32LE(rate * 2, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write("data", 36); audio.writeUInt32LE(rate * 2, 40);
  for (let t = 0; t < rate; t++) audio.writeInt16LE(Math.round(10_000 * Math.sin(t / rate * 440 * Math.PI * 2)), 44 + t * 2);
  const sound = { path: "audio/tone.wav", bytes: audio };
  const manifest = JSON.stringify({
    schemaVersion: 1,
    sceneId: "private-fixture",
    label: "Private fixture",
    source: "test",
    glbPath: "scene.glb",
    spawnPoints: [{ id: "main", position: { x: 0, y: 0, z: 3 }, yaw: 0 }],
    bounds: { width: 5, height: 4, depth: 5 },
    sceneEffects: [{
      id: "move", kind: "clip-loop", root: "mover", clips: ["glide"],
      audio: { path: sound.path, sha256: createHash("sha256").update(sound.bytes).digest("hex"), gain: 0.2, nearM: 1, farM: 8 }
    }, {
      id: "light", kind: "sprite-loop", root: "glow", atlas: { columns: 1, rows: 1, cycleSeconds: 1 },
      switch: { mount: "switch-mount", handle: "switch-handle", offQuaternion: [0, 0, 1, 0], initiallyOn: true }
    }, {
      id: "tethered", kind: "held-prop", root: "tethered-smoke", fixture: "tethered-body", handle: "tethered-handle",
      tip: "tethered-tip", tether: "tethered-end", connector: "tethered-connector", restHose: "tethered-rest", soundSource: "tethered-sound",
      pickupM: .35, reachM: 2, contactM: .14, hoseRadiusM: .008,
      burst: { columns: 1, rows: 1, durationSeconds: 1, intervalSeconds: 2 }
    }],
  });
  // Remote suites discover this test without building the local fixture SDK.
  const sdk = createRequire(resolve("apps/api/package.json"))("@vrata/room-plugin-sdk/artifact");
  const artifact = Buffer.from(
    sdk.createRoomPluginArtifact(
      {
        schemaVersion: 1,
        sdkApiVersion: 1,
        id: "test.movement",
        version: "1.0.0",
        displayName: "Movement",
        requestedCapabilities: ["scene.effects.setEnabled"],
        configSchema: {},
      },
      'export function init(c){return c.sdk.scene.effects.setEnabled("move",true);}',
    ).bytes,
  );
  return { manifest, model, artifact, archive: undefined, sound };
}

export async function assertPrivateHeldProp(page: Page) {
  const state = () => page.evaluate(() => (window as any).__VRATA_DEBUG__.sceneEffects
    .find((effect: { id: string }) => effect.id === "tethered"));
  const grip = (point: { x: number; y: number; z: number }, pressed: boolean) =>
    page.evaluate(({ point, pressed }) => (window as any).__VRATA_TEST__.setSyntheticXrState({
      rightController: point, rightGrip: point, rayDirection: { x: 0, y: 0, z: -1 }, gripPressed: pressed
    }), { point, pressed });
  const rest = (await state()).position;
  await page.evaluate(() => (window as any).__VRATA_TEST__.setSceneReviewPose({
    position: { x: 1, y: 0, z: 2.15 }, yaw: 0, pitch: 0, fovDegrees: 66
  }));
  await grip({ x: rest[0], y: rest[1], z: rest[2] }, true);
  await expect.poll(async () => [(await state()).holding, (await state()).bursts]).toEqual(["right", 0]);
  const { eye } = await page.evaluate(() => (window as any).__VRATA_TEST__.getSceneReviewCamera());
  const held = await state();
  const mouth = { x: eye[0] - (held.tip[0] - held.position[0]), y: eye[1] - .085, z: eye[2] - .085 };
  await grip(mouth, true);
  await expect.poll(async () => (await state()).touching).toBe(true);
  await expect.poll(async () => (await state()).bursts).toBeGreaterThan(0);
  await grip(mouth, false);
  await expect.poll(async () => {
    const current = await state();
    return [current.holding, current.touching, current.position];
  }).toEqual([null, false, rest]);
}

export async function assertPrivateClip(options: {
  page: Page;
  request: APIRequestContext;
  adminToken: string;
  roomId: string;
  origin: string;
  artifact: Buffer;
  first: boolean;
  sound?: boolean;
  inspect?: (page: Page) => Promise<void>;
}) {
  const { page, request, roomId, origin, artifact, first } = options,
    path = `${origin}/api/rooms/${roomId}/plugins`;
  const auth = { "x-vrata-admin-token": options.adminToken };
  const state = () =>
    page.evaluate(() => {
      const e = (window as any).__VRATA_DEBUG__.sceneEffects[0];
      return { playing: e.playing, position: e.position, clips: e.clips };
    });
  let toggle: ((enabled: boolean) => Promise<void>) | undefined;
  if (first) {
    expect((await state()).playing).toBe(false);
    const up = await request.post(`${path}/packages`, {
      headers: { ...auth, "content-type": "application/octet-stream" },
      data: artifact,
    });
    expect(up.status()).toBe(201);
    const { package: pkg } = await up.json();
    let revision = 0;
    toggle = async (enabled) => {
      const capabilities = ["scene.effects.setEnabled"];
      const response = await request.put(`${path}/bindings/${pkg.pluginId}`, {
        headers: auth,
        data: {
          expectedRevision: revision,
          packageId: pkg.packageId,
          version: pkg.version,
          artifactSha256: pkg.artifactSha256,
          enabled,
          config: {},
          approvedCapabilities: capabilities,
          capabilityApproval: { artifactSha256: pkg.artifactSha256, capabilities },
        },
      });
      expect(response.status()).toBe(200);
      revision = (await response.json()).revision;
    };
    await toggle(true);
  }
  await expect.poll(async () => (await state()).playing, { timeout: 45_000 }).toBe(true);
  const start = await state();
  await expect
    .poll(
      async () => {
        const now = await state();
        return (
          now.playing &&
          now.position.some((n: number, i: number) => Math.abs(start.position[i] - n) > 0.05) &&
          now.clips.every((c: { time: number }, i: number) => c.time !== start.clips[i].time)
        );
      },
      { timeout: 12_000 },
    )
    .toBe(true);
  const audioButton = page.locator("#scene-sounds");
  const audio = () => page.evaluate(() => {
    const d = (window as any).__VRATA_DEBUG__, probe = (window as any).__scenePlaybackProbe;
    const audible = probe.analysers.some((a: AnalyserNode) => {
      const data = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(data);
      return data.some(x => Math.abs(x) > 0.0001);
    });
    return { playing: Boolean(d.sceneEffects[0].audio?.playing), audible, microphoneRequests: probe.microphoneRequests };
  });
  if (options.sound) {
    if (!(await audioButton.isVisible())) await page.locator("#meeting-nav-audio").click();
    await expect(audioButton).toHaveAttribute("aria-pressed", "false");
    await expect(audioButton).toHaveAccessibleName(/^(Scene sounds|Звуки сцены)$/);
    const off = audioButton.locator('[data-scene-sounds-state="off"]');
    const on = audioButton.locator('[data-scene-sounds-state="on"]');
    await expect(off).toBeVisible();
    await expect(on).toBeHidden();
    expect((await audio()).playing).toBe(false);
    await audioButton.click();
    await expect(on).toBeVisible();
    await expect(off).toBeHidden();
    await expect.poll(audio, { timeout: 35_000 }).toEqual({ playing: true, audible: true, microphoneRequests: 0 });
    await audioButton.click();
    await expect(off).toBeVisible();
    await expect(on).toBeHidden();
    await expect.poll(async () => (await audio()).playing).toBe(false);
    expect((await state()).playing).toBe(true);
    await audioButton.click();
    await expect.poll(async () => (await audio()).playing, { timeout: 20_000 }).toBe(true);
  }
  await options.inspect?.(page);
  if (toggle) {
    await toggle(false);
    await expect.poll(async () => [(await state()).playing, options.sound ? (await audio()).playing : false], { timeout: 12_000 }).toEqual([false, false]);
    await toggle(true);
    await expect.poll(async () => (await state()).playing, { timeout: 45_000 }).toBe(true);
  }
}
