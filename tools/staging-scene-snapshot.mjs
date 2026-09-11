#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { defaultRooms, preflightSceneBundle } from "./patch-staging-scene-bundles.mjs";

function apiBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("invalid_scene_snapshot_base_url");
  }
  return url.origin;
}

function validateRoomIds(rooms) {
  if (!Array.isArray(rooms) || rooms.length === 0) {
    throw new Error("invalid_scene_snapshot_rooms");
  }
  const ids = new Set();
  for (const room of rooms) {
    if (typeof room?.roomId !== "string" || !room.roomId.trim()
      || room.roomId === "." || room.roomId === ".." || ids.has(room.roomId)) {
      throw new Error("invalid_scene_snapshot_room_id");
    }
    ids.add(room.roomId);
  }
}

function validateSceneUrl(value) {
  if (value === null) return;
  if (typeof value !== "string" || !["http:", "https:"].includes(new URL(value).protocol)) {
    throw new Error("invalid_scene_snapshot_scene_url");
  }
}

async function roomRequest(input, roomId, method = "GET", sceneBundleUrl) {
  const response = await (input.fetchImpl ?? fetch)(new URL(`/api/rooms/${encodeURIComponent(roomId)}`, input.baseUrl), {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers: {
      "cache-control": "no-cache",
      ...(input.adminToken ? { "x-vrata-admin-token": input.adminToken } : {}),
      ...(method === "PATCH" ? { "content-type": "application/json" } : {})
    },
    ...(method === "PATCH" ? { body: JSON.stringify({ sceneBundleUrl }) } : {})
  });
  if (!response.ok) throw new Error(`scene_snapshot_room_request_failed:${method}:${roomId}:${response.status}`);
  const payload = await response.json();
  if (payload?.roomId !== roomId) throw new Error(`scene_snapshot_room_id_mismatch:${roomId}`);
  // An explicitly cleared room URL must not fall back to a stale manifest field.
  const value = Object.hasOwn(payload, "sceneBundleUrl")
    ? payload.sceneBundleUrl ?? null
    : payload.manifest?.sceneBundle?.url ?? null;
  validateSceneUrl(value);
  return value;
}

export async function captureSceneSnapshot(input) {
  const baseUrl = apiBaseUrl(input.baseUrl);
  const rooms = input.rooms ?? defaultRooms;
  validateRoomIds(rooms);
  const snapshotRooms = [];
  for (const room of rooms) {
    const sceneBundleUrl = await roomRequest({ ...input, baseUrl }, room.roomId);
    snapshotRooms.push({ roomId: room.roomId, sceneBundleUrl });
  }
  const snapshot = { schemaVersion: 1, baseUrl, rooms: snapshotRooms };
  // Read every room before any rollout; never overwrite this pre-rollout snapshot.
  // URLs may contain private query strings, so keep the file out of public artifacts.
  await writeFile(input.reportPath, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return snapshot;
}

export async function restoreSceneSnapshot(input) {
  const baseUrl = apiBaseUrl(input.baseUrl);
  if (!input.adminToken) throw new Error("missing_scene_snapshot_admin_token");
  const snapshot = JSON.parse(await readFile(input.reportPath, "utf8"));
  if (snapshot?.schemaVersion !== 1 || snapshot.baseUrl !== baseUrl) {
    throw new Error("invalid_scene_snapshot_target");
  }
  validateRoomIds(snapshot.rooms);
  const expectedRooms = input.rooms ?? defaultRooms;
  validateRoomIds(expectedRooms);
  const expectedIds = new Set(expectedRooms.map((room) => room.roomId));
  if (snapshot.rooms.length !== expectedIds.size || snapshot.rooms.some((room) => !expectedIds.has(room.roomId))) {
    throw new Error("invalid_scene_snapshot_room_scope");
  }
  for (const room of snapshot.rooms) {
    if (!Object.hasOwn(room, "sceneBundleUrl")) throw new Error("invalid_scene_snapshot_scene_url");
    validateSceneUrl(room.sceneBundleUrl);
  }

  const failures = [];
  // A failed room must not prevent restoration of the remaining rooms.
  for (const room of snapshot.rooms) {
    try {
      await roomRequest({ ...input, baseUrl }, room.roomId, "PATCH", room.sceneBundleUrl);
    } catch (cause) {
      failures.push(new Error(`patch:${room.roomId}`, { cause }));
    }
  }
  // Verify only after ALL writes, using fresh GETs rather than PATCH responses.
  for (const room of snapshot.rooms) {
    try {
      const actualUrl = await roomRequest({ ...input, baseUrl }, room.roomId);
      if (actualUrl !== room.sceneBundleUrl) throw new Error("scene_snapshot_url_mismatch");
      if (actualUrl !== null) {
        await preflightSceneBundle(actualUrl, {
          fetchImpl: (url, options) => (input.fetchImpl ?? fetch)(url, {
            ...options,
            signal: AbortSignal.timeout(30000)
          }),
          attempts: input.preflightAttempts ?? 12,
          delayMs: input.preflightDelayMs ?? 5000
        });
      }
    } catch (cause) {
      failures.push(new Error(`verify:${room.roomId}`, { cause }));
    }
  }
  if (failures.length) {
    // Do not log original errors: asset URLs may contain credentials or signed queries.
    throw new AggregateError(failures, `scene_snapshot_restore_failed:${failures.map((error) => error.message).join(",")}`);
  }
  return snapshot;
}

async function main() {
  const [action, reportPath, ...extra] = process.argv.slice(2);
  if (!["capture", "restore"].includes(action) || !reportPath || extra.length) {
    throw new Error("usage: staging-scene-snapshot.mjs <capture|restore> <report-path>");
  }
  if (!process.env.BASE_URL) throw new Error("missing_scene_snapshot_base_url");
  const input = { baseUrl: process.env.BASE_URL, adminToken: process.env.STAGING_ADMIN_TOKEN, reportPath };
  const snapshot = await (action === "capture" ? captureSceneSnapshot(input) : restoreSceneSnapshot(input));
  process.stdout.write(`scene_snapshot_${action}_verified:${snapshot.rooms.length}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Avoid printing URLs, tokens or filesystem paths on failure.
    const message = error instanceof Error && /^(scene_snapshot_|missing_scene_snapshot_|invalid_scene_snapshot_|usage:)/.test(error.message)
      ? error.message : "scene_snapshot_operation_failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
