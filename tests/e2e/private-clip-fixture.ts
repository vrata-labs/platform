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
  const meshData = Buffer.from(new Float32Array([-1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 2, 0, 0]).buffer);
  const gltf = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "mover", mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: meshData.length }],
    bufferViews: [
      { buffer: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 8 },
      { buffer: 0, byteOffset: 44, byteLength: 24 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-1, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 2, type: "SCALAR", min: [0], max: [2] },
      { bufferView: 2, componentType: 5126, count: 2, type: "VEC3" },
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
  const model = Buffer.alloc(28 + chunk.length + meshData.length);
  [0x46546c67, 2, model.length, chunk.length, 0x4e4f534a].forEach((v, i) => model.writeUInt32LE(v, i * 4));
  chunk.copy(model, 20);
  model.writeUInt32LE(meshData.length, 20 + chunk.length);
  model.writeUInt32LE(0x004e4942, 24 + chunk.length);
  meshData.copy(model, 28 + chunk.length);
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
    expect((await audio()).playing).toBe(false);
    await audioButton.click();
    await expect.poll(audio, { timeout: 35_000 }).toEqual({ playing: true, audible: true, microphoneRequests: 0 });
    await audioButton.click();
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
