import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isSceneAudioPath } from "@vrata/shared-types";
import type { RoomRecord, Storage } from "./storage-contracts.js";
import { getManagedAccessBlockReason, managedRoomCutoffMs } from "./room-session-control.js";
import { privateSceneApproval, privateSceneStore, readPrivateSceneFile, type PrivateSceneVersion } from "./private-scene-release.js";

interface View {
  tenant: string;
  room: string;
  version: string;
  hash: string;
  grant: string;
  exp: number;
  purpose: "view";
}
function key(secret: string) {
  return Buffer.from(hkdfSync("sha256", secret, "", "vrata/private-scene-view/v1", 32));
}
function encode(view: View, secret: string) {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(secret), nonce);
  const data = Buffer.concat([cipher.update(JSON.stringify(view), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString("base64url");
}
function decode(cap: string, secret: string): View | null {
  try {
    const data = Buffer.from(cap, "base64url");
    if (data.toString("base64url") !== cap || data.length <= 28) return null;
    const d = createDecipheriv("aes-256-gcm", key(secret), data.subarray(0, 12));
    d.setAuthTag(data.subarray(12, 28));
    const view = JSON.parse(Buffer.concat([d.update(data.subarray(28)), d.final()]).toString()) as View;
    return view.purpose === "view" && view.exp > Date.now() ? view : null;
  } catch {
    return null;
  }
}
export function privateAssetOrigin(env = process.env) {
  const raw = env.VRATA_PRIVATE_ASSET_ORIGIN;
  if (!raw) return null;
  const url = new URL(raw);
  return url.origin === raw &&
    url.origin !== env.RUNTIME_BASE_URL &&
    (url.protocol === "https:" ||
      (env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
    ? url
    : null;
}
export function servesPrivateVersion(room: RoomRecord | null, version: PrivateSceneVersion) {
  const m = room?.managed,
    a = privateSceneApproval();
  return (
    !!m &&
    !!a &&
    m.kind === "custom" &&
    m.publishedVersionId === version.bundleVersionId &&
    m.bundleContentHash === version.contentHash &&
    room!.tenantId === version.tenantId &&
    version.tenantId === a.tenantId &&
    a.ownerSubject === m.ownerSubject &&
    a.bundleId === version.bundleId &&
    !getManagedAccessBlockReason(room)
  );
}
export function privateDescriptor(
  room: RoomRecord,
  version: PrivateSceneVersion,
  grantId: string,
  expiresAtSeconds: number,
  secret: string
) {
  const origin = privateAssetOrigin(),
    now = Date.now();
  const exp = Math.min(now + 600_000, expiresAtSeconds * 1000, managedRoomCutoffMs(room) ?? 0);
  if (!origin || exp <= now || !servesPrivateVersion(room, version)) return null;
  const cap = encode(
    {
      tenant: room.tenantId,
      room: room.roomId,
      grant: grantId,
      version: version.bundleVersionId,
      hash: version.contentHash,
      exp,
      purpose: "view"
    },
    secret
  );
  const baseUrl = `${origin.origin}/c/${cap}/`;
  return {
    roomId: room.roomId,
    bundleVersionId: version.bundleVersionId,
    contentHash: version.contentHash,
    purpose: "view",
    baseUrl,
    manifestUrl: baseUrl + "scene.json",
    expiresAt: new Date(exp).toISOString(),
    refreshAfter: new Date(Math.max(now, exp - 30_000)).toISOString(),
    maxRefreshAttempts: 1
  };
}
export async function servePrivateAsset(req: IncomingMessage, res: ServerResponse, storage: Storage, secret: string) {
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  const deny = (status = 404) => {
    res.statusCode = status;
    res.end();
  };
  // Never log the request URI, expose a storage URL, or accept an account or room cookie here.
  try {
    const asset = privateAssetOrigin(),
      app = process.env.RUNTIME_BASE_URL;
    if (!asset || !app || req.headers.host !== asset.host || !["GET", "HEAD"].includes(req.method ?? "")) return deny();
    if (req.headers.origin && req.headers.origin !== new URL(app).origin) return deny();
    res.setHeader("access-control-allow-origin", new URL(app).origin);
    const match = /^\/c\/([A-Za-z0-9_-]{43,2048})\/(.{1,74})$/.exec(req.url ?? "");
    const path = match?.[2];
    if (path !== "scene.json" && path !== "scene.glb" && !isSceneAudioPath(path)) return deny(403);
    const scope = match && decode(match[1]!, secret);
    if (!scope) return deny(403);
    const [room, v, g] = await Promise.all([
      storage.getRoom(scope.room),
      storage.getPrivateSceneVersion(scope.tenant, scope.version),
      storage.getManagedRoomGrant(scope.grant)
    ]);
    if (
      !v ||
      !room ||
      !servesPrivateVersion(room, v) ||
      v.contentHash !== scope.hash ||
      !g ||
      g.revokedAt ||
      g.subject !== room.managed!.ownerSubject ||
      g.roomId !== scope.room
    )
      return deny(403);
    const file = v.files.find((f) => f.path === path);
    if (!file) return deny();
    const bytes = req.method === "HEAD" ? null : await readPrivateSceneFile(v, file, privateSceneStore());
    if (scope.exp <= Date.now()) return deny(403);
    res.writeHead(200, { "content-type": file.contentType, "content-length": file.sizeBytes });
    res.end(bytes ?? undefined);
  } catch {
    return deny(503);
  }
}
