#!/usr/bin/env node

const baseUrl = process.env.BASE_URL ?? "https://89.169.161.91.sslip.io";
const adminToken = process.env.STAGING_ADMIN_TOKEN ?? process.env.NOAH_ADMIN_TOKEN ?? "noah-stage-admin";
const branch = process.env.STAGING_SCENE_BUNDLE_BRANCH ?? "deploy/scene-bundles-stage-20260328";

function deriveAssetBaseUrl(input) {
  const url = new URL(input);
  if (process.env.STAGING_ASSET_BASE_URL) {
    return process.env.STAGING_ASSET_BASE_URL;
  }
  return `${url.protocol}//assets.${url.host}`;
}

const assetBaseUrl = deriveAssetBaseUrl(baseUrl);

const rooms = [
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

function desiredSceneBundleUrl(sceneId) {
  if (assetBaseUrl) {
    return `${assetBaseUrl}/assets/scenes/${sceneId}/scene.json`;
  }
  return `https://raw.githubusercontent.com/psilon2000/noah/${branch}/apps/runtime-web/public/assets/scenes/${sceneId}/scene.json`;
}

async function patchRoom(room) {
  const targetUrl = desiredSceneBundleUrl(room.sceneId);
  const response = await fetch(new URL(`/api/rooms/${room.roomId}`, baseUrl), {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-noah-admin-token": adminToken
    },
    body: JSON.stringify({
      sceneBundleUrl: targetUrl
    })
  });

  if (!response.ok) {
    throw new Error(`failed_to_patch_room:${room.roomId}:${response.status}`);
  }

  const payload = await response.json();
  const actualUrl = payload?.sceneBundleUrl ?? payload?.manifest?.sceneBundle?.url ?? null;
  if (actualUrl !== targetUrl) {
    throw new Error(`scene_bundle_url_mismatch:${room.roomId}`);
  }

  return {
    roomId: room.roomId,
    name: room.name,
    sceneBundleUrl: actualUrl
  };
}

async function main() {
  const results = [];
  for (const room of rooms) {
    results.push(await patchRoom(room));
  }
  process.stdout.write(`${JSON.stringify({ baseUrl, branch, rooms: results }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
