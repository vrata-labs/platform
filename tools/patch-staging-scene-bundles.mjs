#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const defaultRooms = [
  {
    name: "Hall",
    roomId: process.env.STAGING_HALL_ROOM_ID ?? "42db8225-f671-4e46-9c28-9381d66a948c",
    sceneId: "sense-hall2-v1"
  },
  {
    name: "BlueOffice",
    roomId: process.env.STAGING_BLUEOFFICE_ROOM_ID ?? "0b537d34-7b92-4b51-854a-8c64cfb4c114",
    sceneId: "sense-blueoffice-glb-v4"
  }
];

const defaultBaseUrl = "https://89.169.161.91.sslip.io";
const defaultAdminToken = "noah-stage-admin";
const defaultBranch = "deploy/scene-bundles-stage-20260328";

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function deriveAssetBaseUrl(input, env = process.env) {
  if (env.STAGING_ASSET_BASE_URL) {
    return env.STAGING_ASSET_BASE_URL;
  }
  const url = new URL(input);
  return `${url.protocol}//state.${url.host}`;
}

export function resolveSceneBundleVersion(env = process.env, fallbackVersion = "") {
  const version = env.STAGING_SCENE_BUNDLE_VERSION ?? env.DEPLOY_SHA ?? env.GITHUB_SHA ?? fallbackVersion;
  if (!version) {
    if (env.STAGING_ALLOW_MUTABLE_SCENE_BUNDLE_URL === "1") {
      return null;
    }
    throw new Error("missing_scene_bundle_version");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(version)) {
    throw new Error("invalid_scene_bundle_version");
  }
  if (!/^[0-9a-f]{40}$/i.test(version) && env.STAGING_ALLOW_NON_SHA_SCENE_BUNDLE_VERSION !== "1") {
    throw new Error("invalid_scene_bundle_version:expected_full_git_sha");
  }
  return version;
}

function resolveGitHeadVersion() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export function desiredSceneBundleUrl(sceneId, input) {
  const assetBaseUrl = input.assetBaseUrl ? trimTrailingSlash(input.assetBaseUrl) : "";
  if (assetBaseUrl) {
    return input.version
      ? `${assetBaseUrl}/assets/scenes/${sceneId}/${input.version}/scene.json`
      : `${assetBaseUrl}/assets/scenes/${sceneId}/scene.json`;
  }
  const branch = input.branch ?? defaultBranch;
  return input.version
    ? `https://raw.githubusercontent.com/psilon2000/noah/${branch}/apps/runtime-web/public/assets/scenes/${sceneId}/${input.version}/scene.json`
    : `https://raw.githubusercontent.com/psilon2000/noah/${branch}/apps/runtime-web/public/assets/scenes/${sceneId}/scene.json`;
}

function isFetchableUrl(url) {
  return url.protocol === "http:" || url.protocol === "https:";
}

function collectManifestAssetUrls(manifest, bundleUrl) {
  const paths = new Set();
  if (typeof manifest.glbPath === "string" && manifest.glbPath.trim()) {
    paths.add(manifest.glbPath);
  }
  if (typeof manifest.preview === "string" && manifest.preview.trim()) {
    paths.add(manifest.preview);
  }
  if (Array.isArray(manifest.materialOverrides)) {
    for (const item of manifest.materialOverrides) {
      if (typeof item?.mapPath === "string" && item.mapPath.trim()) {
        paths.add(item.mapPath);
      }
    }
  }
  return Array.from(paths)
    .map((assetPath) => new URL(assetPath, bundleUrl))
    .filter(isFetchableUrl)
    .map((url) => url.toString());
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: {
      "cache-control": "no-cache",
      pragma: "no-cache"
    }
  });
  if (!response.ok) {
    throw new Error(`scene_bundle_preflight_manifest_failed:${response.status}:${url}`);
  }
  return response.json();
}

async function assertAssetAvailable(fetchImpl, assetUrl) {
  const headResponse = await fetchImpl(assetUrl, {
    method: "HEAD",
    headers: {
      "cache-control": "no-cache",
      pragma: "no-cache"
    }
  });
  if (headResponse.ok) return;

  const rangeResponse = await fetchImpl(assetUrl, {
    headers: {
      range: "bytes=0-0",
      "cache-control": "no-cache",
      pragma: "no-cache"
    }
  });
  if (!rangeResponse.ok) {
    throw new Error(`scene_bundle_preflight_asset_failed:${rangeResponse.status}:${assetUrl}`);
  }
  await rangeResponse.body?.cancel?.();
}

export async function preflightSceneBundle(targetUrl, input = {}) {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const attempts = input.attempts ?? 12;
  const delayMs = input.delayMs ?? 5000;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const manifest = await fetchJson(fetchImpl, targetUrl);
      if (typeof manifest.glbPath !== "string" || !manifest.glbPath.trim()) {
        throw new Error(`scene_bundle_preflight_missing_glb_path:${targetUrl}`);
      }
      const assetUrls = collectManifestAssetUrls(manifest, targetUrl);
      for (const assetUrl of assetUrls) {
        await assertAssetAvailable(fetchImpl, assetUrl);
      }
      return {
        sceneId: typeof manifest.sceneId === "string" ? manifest.sceneId : null,
        assetUrls
      };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`scene_bundle_preflight_failed:${targetUrl}`);
}

async function fetchRoom(baseUrl, roomId) {
  const response = await fetch(new URL(`/api/rooms/${roomId}`, baseUrl));
  if (!response.ok) {
    throw new Error(`failed_to_read_room:${roomId}:${response.status}`);
  }
  return response.json();
}

async function patchRoom(baseUrl, adminToken, roomId, sceneBundleUrl) {
  const response = await fetch(new URL(`/api/rooms/${roomId}`, baseUrl), {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-noah-admin-token": adminToken
    },
    body: JSON.stringify({ sceneBundleUrl })
  });

  if (!response.ok) {
    throw new Error(`failed_to_patch_room:${roomId}:${response.status}`);
  }
  return response.json();
}

async function patchRooms(input) {
  const targets = input.rooms.map((room) => ({
    ...room,
    targetUrl: desiredSceneBundleUrl(room.sceneId, {
      assetBaseUrl: input.assetBaseUrl,
      branch: input.branch,
      version: input.version
    })
  }));

  for (const target of targets) {
    await preflightSceneBundle(target.targetUrl, {
      attempts: input.preflightAttempts,
      delayMs: input.preflightDelayMs
    });
  }

  const results = [];
  for (const target of targets) {
    const previousRoom = await fetchRoom(input.baseUrl, target.roomId);
    const previousSceneBundleUrl = previousRoom?.sceneBundleUrl ?? previousRoom?.manifest?.sceneBundle?.url ?? null;
    const payload = await patchRoom(input.baseUrl, input.adminToken, target.roomId, target.targetUrl);
    const actualUrl = payload?.sceneBundleUrl ?? payload?.manifest?.sceneBundle?.url ?? null;
    if (actualUrl !== target.targetUrl) {
      throw new Error(`scene_bundle_url_mismatch:${target.roomId}`);
    }
    results.push({
      roomId: target.roomId,
      name: target.name,
      sceneId: target.sceneId,
      previousSceneBundleUrl,
      sceneBundleUrl: actualUrl
    });
  }

  return results;
}

async function restoreRoomsFromReport(input) {
  const report = JSON.parse(await readFile(input.reportPath, "utf8"));
  const rooms = Array.isArray(report.rooms) ? report.rooms : [];
  const results = [];
  for (const room of rooms) {
    if (!room?.roomId) continue;
    const payload = await patchRoom(input.baseUrl, input.adminToken, room.roomId, room.previousSceneBundleUrl ?? null);
    const actualUrl = payload?.sceneBundleUrl ?? payload?.manifest?.sceneBundle?.url ?? null;
    results.push({
      roomId: room.roomId,
      name: room.name ?? room.roomId,
      sceneBundleUrl: actualUrl
    });
  }
  return results;
}

function parseRestoreReportArg(argv) {
  const prefix = "--restore-report=";
  const inline = argv.find((entry) => entry.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf("--restore-report");
  return index >= 0 ? argv[index + 1] : null;
}

async function main() {
  const baseUrl = process.env.BASE_URL ?? defaultBaseUrl;
  const adminToken = process.env.STAGING_ADMIN_TOKEN ?? process.env.NOAH_ADMIN_TOKEN ?? defaultAdminToken;
  const restoreReportPath = parseRestoreReportArg(process.argv.slice(2));

  if (restoreReportPath) {
    const rooms = await restoreRoomsFromReport({ baseUrl, adminToken, reportPath: restoreReportPath });
    process.stdout.write(`${JSON.stringify({ baseUrl, restored: true, rooms }, null, 2)}\n`);
    return;
  }

  const branch = process.env.STAGING_SCENE_BUNDLE_BRANCH ?? defaultBranch;
  const assetBaseUrl = deriveAssetBaseUrl(baseUrl);
  const version = resolveSceneBundleVersion(process.env, resolveGitHeadVersion());
  const preflightAttempts = Number.parseInt(process.env.STAGING_SCENE_BUNDLE_PREFLIGHT_ATTEMPTS ?? "12", 10);
  const preflightDelayMs = Number.parseInt(process.env.STAGING_SCENE_BUNDLE_PREFLIGHT_DELAY_MS ?? "5000", 10);
  const rooms = await patchRooms({
    baseUrl,
    adminToken,
    branch,
    assetBaseUrl,
    version,
    rooms: defaultRooms,
    preflightAttempts,
    preflightDelayMs
  });
  const report = { baseUrl, branch, assetBaseUrl, version, rooms };
  if (process.env.STAGING_SCENE_BUNDLE_PATCH_REPORT) {
    await writeFile(process.env.STAGING_SCENE_BUNDLE_PATCH_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
