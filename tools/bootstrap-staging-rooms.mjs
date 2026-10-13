import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preflightSceneBundle } from "./patch-staging-scene-bundles.mjs";

export async function loadStagingCatalog() {
  return JSON.parse(await readFile(new URL("../infra/docker/staging-scene-catalog.json", import.meta.url), "utf8"));
}

export function validateStagingCatalog(catalog) {
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.rooms) || catalog.rooms.length === 0
    || !catalog.tenantId || !catalog.templateId || !catalog.templateVersion) throw new Error("staging_catalog_invalid");
  const ids = new Set();
  const scenes = new Set();
  for (const room of catalog.rooms) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(room?.roomId ?? "") || !/^sense-[a-z0-9-]+$/.test(room?.sceneId ?? "")
      || typeof room.name !== "string" || room.name.length < 3 || ids.has(room.roomId) || scenes.has(room.sceneId)) {
      throw new Error("staging_catalog_invalid_room");
    }
    ids.add(room.roomId);
    scenes.add(room.sceneId);
  }
  return catalog;
}

export async function bootstrapStagingRooms(input) {
  const catalog = validateStagingCatalog(input.catalog ?? await loadStagingCatalog());
  const base = new URL(input.baseUrl);
  const assets = new URL(input.assetBaseUrl);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password
    || !["https:", "http:"].includes(assets.protocol) || assets.username || assets.password
    || !input.adminToken || !/^[a-f0-9]{40}$/.test(input.version ?? "")) {
    throw new Error("staging_room_configuration_required");
  }
  const fetcher = input.fetchImpl ?? fetch;
  const call = (path, options = {}) => fetcher(new URL(path, base), {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers: { "x-vrata-admin-token": input.adminToken, "content-type": "application/json" }
  });
  const session = await call("/api/control-plane/session");
  if (!session.ok) throw new Error("staging_room_admin_unauthorized");
  const actor = await session.json();
  if (!actor.permissions?.includes("room.create")) throw new Error("staging_room_create_permission_required");
  const prepared = [];
  for (const room of catalog.rooms) {
    const suffix = room.versioned ? `${input.version}/scene.json` : "scene.json";
    const url = new URL(`/assets/scenes/${room.sceneId}/${suffix}`, assets).toString();
    await preflightSceneBundle(url, { fetchImpl: fetcher, attempts: input.preflightAttempts ?? 1, delayMs: 0 });
    prepared.push({ ...room, sceneBundleUrl: url });
  }
  const templateResponse = await call("/api/templates");
  if (!templateResponse.ok) throw new Error("staging_room_template_catalog_unavailable");
  const templates = await templateResponse.json();
  const results = [];
  for (const room of prepared) {
    let response = await call(`/api/rooms/${room.roomId}`);
    let created = false;
    if (response.status === 404) {
      if (!templates.items?.some(row => row.templateId === catalog.templateId && row.currentVersion === catalog.templateVersion)) {
        throw new Error("staging_room_template_unavailable");
      }
      response = await call("/api/rooms", {
        method: "POST",
        body: JSON.stringify({ roomId: room.roomId, name: room.name, tenantId: catalog.tenantId,
          templateId: catalog.templateId, templateVersion: catalog.templateVersion,
          sceneBundleUrl: room.sceneBundleUrl, visibility: "public", guestAllowed: true,
          features: { voice: true, spatialAudio: true, screenShare: true },
          avatarsEnabled: true, avatarSeatsEnabled: true })
      });
      created = response.status === 201;
      if (response.status === 409) response = await call(`/api/rooms/${room.roomId}`);
    }
    if (!response.ok) throw new Error(`staging_room_request_failed:${response.status}`);
    const current = await response.json();
    if (current.roomId !== room.roomId || current.tenantId !== catalog.tenantId || current.templateId !== catalog.templateId
      || current.templateVersion !== catalog.templateVersion) throw new Error("staging_room_identity_mismatch");
    results.push({ roomId: room.roomId, created });
  }
  return { rooms: results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bootstrapStagingRooms({ baseUrl: process.env.BASE_URL, assetBaseUrl: process.env.STAGING_ASSET_BASE_URL,
    adminToken: process.env.STAGING_ADMIN_TOKEN, version: process.env.STAGING_SCENE_BUNDLE_VERSION })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(/^staging_/.test(error.message) ? error.message : "staging_room_bootstrap_failed"); process.exitCode = 1; });
}
