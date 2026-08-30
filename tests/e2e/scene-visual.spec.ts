import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

interface ReviewView {
  id: string;
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  fovDegrees: number;
}

const crc32Table = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return crc >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(files: Record<string, string | Buffer>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, rawContent] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name);
    const content = Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(rawContent);
    const checksum = crc32(content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(content.byteLength, 18);
    localHeader.writeUInt32LE(content.byteLength, 22);
    localHeader.writeUInt16LE(nameBuffer.byteLength, 26);
    localParts.push(localHeader, nameBuffer, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(content.byteLength, 20);
    centralHeader.writeUInt32LE(content.byteLength, 24);
    centralHeader.writeUInt16LE(nameBuffer.byteLength, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.byteLength + nameBuffer.byteLength + content.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function runtimeView(view: ReviewView, flipZ: boolean) {
  const position = {
    x: view.position.x,
    y: view.position.y - 1.6,
    z: flipZ ? -view.position.z : view.position.z
  };
  const target = {
    x: view.target.x,
    y: view.target.y,
    z: flipZ ? -view.target.z : view.target.z
  };
  const delta = {
    x: target.x - position.x,
    y: target.y - view.position.y,
    z: target.z - position.z
  };
  const horizontalDistance = Math.hypot(delta.x, delta.z);
  return {
    id: view.id,
    position,
    yaw: Math.atan2(-delta.x, -delta.z),
    pitch: Math.atan2(delta.y, horizontalDistance),
    fovDegrees: view.fovDegrees
  };
}

test("@private-assets @scene-visual captures fixed runtime review views", async ({ page, request }) => {
  test.setTimeout(120_000);
  const assetPath = process.env.SCENE_VISUAL_ASSET_PATH;
  const manifestPath = process.env.SCENE_VISUAL_MANIFEST_PATH;
  const configPath = process.env.SCENE_VISUAL_CONFIG_PATH;
  const outputDir = process.env.SCENE_VISUAL_OUTPUT_DIR;
  const adminToken = process.env.STAGING_ADMIN_TOKEN ?? "test-admin-token";
  const apiPort = process.env.E2E_API_PORT ?? process.env.API_PORT ?? "4000";
  const baseUrl = process.env.BASE_URL ?? `http://127.0.0.1:${apiPort}`;
  test.skip(!assetPath || !manifestPath || !configPath || !outputDir, "Scene visual capture paths are not configured.");

  const [asset, manifestSource, configSource] = await Promise.all([
    readFile(resolve(assetPath!)),
    readFile(resolve(manifestPath!), "utf8"),
    readFile(resolve(configPath!), "utf8")
  ]);
  const manifest = JSON.parse(manifestSource) as Record<string, unknown>;
  const config = JSON.parse(configSource) as { reviewViews?: ReviewView[] };
  expect(config.reviewViews?.length).toBeGreaterThan(0);
  manifest.glbPath = "scene.glb";
  manifest.renderProfile = "baked-pbr-v1";
  delete manifest.preview;
  if (process.env.SCENE_VISUAL_STRIP_ANCHORS === "1") {
    delete manifest.anchors;
  }

  const bundleId = `scene-visual-${Date.now()}`;
  const uploadResponse = await request.post("/api/scene-bundles/uploads", {
    headers: { "x-vrata-admin-token": adminToken },
    multipart: {
      bundleId,
      version: "v1",
      bundle: {
        name: `${bundleId}.zip`,
        mimeType: "application/zip",
        buffer: createStoredZip({
          "scene.json": `${JSON.stringify(manifest, null, 2)}\n`,
          "scene.glb": asset
        })
      }
    }
  });
  expect(uploadResponse.status()).toBe(201);
  const uploaded = await uploadResponse.json() as {
    publicUrl: string;
    validation?: { issues?: Array<{ severity: string; code: string }> };
  };
  expect(uploaded.validation?.issues?.filter((issue) => issue.severity === "error") ?? []).toEqual([]);

  const roomResponse = await request.post("/api/rooms", {
    headers: { "x-vrata-admin-token": adminToken },
    data: {
      tenantId: "demo-tenant",
      templateId: "meeting-room-basic",
      name: `Scene Visual ${basename(assetPath!)}`,
      sceneBundleUrl: ["127.0.0.1", "localhost"].includes(new URL(uploaded.publicUrl).hostname)
        ? new URL(new URL(uploaded.publicUrl).pathname, baseUrl).toString()
        : uploaded.publicUrl,
      avatarConfig: { avatarsEnabled: false }
    }
  });
  expect(roomResponse.ok()).toBeTruthy();
  const room = await roomResponse.json() as { roomLink: string };
  const roomUrl = new URL(room.roomLink, baseUrl);
  roomUrl.protocol = new URL(baseUrl).protocol;
  roomUrl.host = new URL(baseUrl).host;
  roomUrl.searchParams.set("debug", "1");
  roomUrl.searchParams.set("clean", "1");
  roomUrl.searchParams.set("scenefit", "0");
  roomUrl.searchParams.set("role", "host");

  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto(roomUrl.toString(), { waitUntil: "domcontentloaded" });
  await expect.poll(async () => page.evaluate(() => (
    window as Window & { __VRATA_DEBUG__?: { sceneDebug?: { state?: string } } }
  ).__VRATA_DEBUG__?.sceneDebug?.state), {
    timeout: 45_000,
    intervals: [250, 500, 1000]
  }).toBe("loaded");

  const reviewRendering = {
    environmentIntensity: Number.parseFloat(process.env.SCENE_VISUAL_ENVIRONMENT_INTENSITY ?? "0.35"),
    exposure: Number.parseFloat(process.env.SCENE_VISUAL_EXPOSURE ?? "1.2")
  };
  const renderingApplied = await page.evaluate((settings) => (
    window as Window & {
      __VRATA_TEST__?: { setSceneReviewRendering?: (value: typeof settings) => boolean };
    }
  ).__VRATA_TEST__?.setSceneReviewRendering?.(settings) ?? false, reviewRendering);
  expect(renderingApplied).toBe(true);

  const flipZ = process.env.SCENE_VISUAL_FLIP_Z === "1";
  await mkdir(resolve(outputDir!), { recursive: true });
  for (const view of config.reviewViews ?? []) {
    const pose = runtimeView(view, flipZ);
    const applied = await page.evaluate((input) => (
      window as Window & {
        __VRATA_TEST__?: { setSceneReviewPose?: (value: typeof input) => boolean };
      }
    ).__VRATA_TEST__?.setSceneReviewPose?.(input) ?? false, pose);
    expect(applied).toBe(true);
    await page.evaluate(() => new Promise<void>((resolveFrame) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()));
    }));
    const dataUrl = await page.locator("#scene > canvas").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL("image/png"));
    await writeFile(resolve(outputDir!, `${view.id}.png`), Buffer.from(dataUrl.split(",")[1] ?? "", "base64"));
  }

  const diagnostics = await page.evaluate(() => (
    window as Window & { __VRATA_DEBUG__?: { sceneDebug?: {
      renderProfile?: string;
      missingAssets?: string[];
      lightMappedMaterialCount?: number;
      screenshot?: {
        averageColor?: { r: number; g: number; b: number; a: number };
        darkPixelRatio?: number;
      };
    } } }
  ).__VRATA_DEBUG__?.sceneDebug ?? null);
  expect(diagnostics?.renderProfile).toBe("baked-pbr-v1");
  expect(diagnostics?.missingAssets).toEqual([]);
  expect(diagnostics?.lightMappedMaterialCount).toBeGreaterThan(0);
  expect(diagnostics?.screenshot?.darkPixelRatio).toBeLessThan(0.98);
  const averageColor = diagnostics?.screenshot?.averageColor;
  expect((averageColor?.r ?? 0) + (averageColor?.g ?? 0) + (averageColor?.b ?? 0)).toBeGreaterThan(30);
  expect((averageColor?.r ?? 255) + (averageColor?.g ?? 255) + (averageColor?.b ?? 255)).toBeLessThan(740);
  expect(averageColor?.a).toBe(255);
  await writeFile(resolve(outputDir!, "scene-debug.json"), `${JSON.stringify(diagnostics, null, 2)}\n`);
  await writeFile(resolve(outputDir!, "capture-settings.json"), `${JSON.stringify(reviewRendering, null, 2)}\n`);
});
