import type { IncomingMessage, ServerResponse } from "node:http";
import { ROOM_PLUGIN_LIMITS } from "@vrata/room-plugin-sdk";
import type { Storage } from "../storage-contracts.js";
import { json } from "../http-responses.js";
import { releaseFencedResponse } from "../identity/response-release.js";
import { RoomPluginAccessError, type RoomPluginAuthorActor } from "./access-contracts.js";
import type { RoomPluginBlobStorage } from "./blob-storage.js";
import { ROOM_PLUGIN_BINDING_HTTP_BYTES, parseRoomPluginBindingHttpBody, parseRoomPluginUnbindHttpBody,
  roomPluginLibraryHttpDto, roomPluginPackageHttpDto, roomPluginRuntimeHttpDto } from "./http-dto.js";
import { RoomPluginHttpError, roomPluginHttpError } from "./http-errors.js";
import { createRoomPluginHttpPackageService } from "./package-http-service.js";
import { readRoomPluginRequestBytes, RoomPluginRequestBodyError } from "./request-body.js";

export interface RoomPluginHttpDependencies {
  storage: Storage;
  getBlobs: () => RoomPluginBlobStorage;
  /** Parent verifies the current RS2 MAC/session deadline or explicit platform administrator header. */
  resolveActor: (request: IncomingMessage, roomId: string) => Promise<RoomPluginAuthorActor>;
}

function assertHeaders(request: IncomingMessage): void {
  const authorization = request.headers.authorization, admin = request.headers["x-vrata-admin-token"];
  for (const name of ["authorization", "x-vrata-admin-token", "origin"]) {
    if (request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === name).length > 1) {
      throw new RoomPluginHttpError(400, "plugin_invalid_request");
    }
  }
  if (authorization !== undefined && admin !== undefined) throw new RoomPluginHttpError(400, "plugin_invalid_request");
  if (authorization !== undefined && (typeof authorization !== "string" || authorization.length > 4103
    // RFC authentication schemes are case-insensitive; the RS2 prefix and credential bytes are not.
    || !/^[Bb][Ee][Aa][Rr][Ee][Rr] rs2\.[A-Za-z0-9_-]{1,3000}\.[A-Za-z0-9_-]{43}$/.test(authorization))) {
    throw new RoomPluginHttpError(401, "identity_required");
  }
  if (admin !== undefined && (typeof admin !== "string" || !admin || admin.length > 4096 || /[\s,]/.test(admin))) {
    throw new RoomPluginHttpError(401, "identity_required");
  }
  if (authorization === undefined && admin === undefined) throw new RoomPluginHttpError(401, "identity_required");
  const origin = request.headers.origin, allowed = process.env.API_CORS_ORIGIN;
  // Only configured origins are trusted; never derive authority from the caller's Host header.
  if (origin !== undefined && (typeof origin !== "string" || origin === "null" || origin.length > 2048
    || allowed && allowed !== "*" && origin !== allowed)) throw new RoomPluginHttpError(403, "plugin_request_forbidden");
}
function segment(encoded: string, kind: "room" | "package" | "plugin"): string {
  let value: string;
  try { value = decodeURIComponent(encoded); } catch { throw new RoomPluginHttpError(400, "plugin_invalid_request"); }
  if (!value || Buffer.byteLength(value) > 512 || /[\u0000-\u001f\u007f/\\]/.test(value)
    || kind === "package" && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
    || kind === "plugin" && (value.length > 64 || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value))) {
    throw new RoomPluginHttpError(400, "plugin_invalid_request");
  }
  return value;
}

export async function handleRoomPluginHttp(request: IncomingMessage, response: ServerResponse, url: URL,
  deps: RoomPluginHttpDependencies): Promise<boolean> {
  const family = /^\/api\/rooms\/([^/]+)\/plugins(?:\/(.*))?$/.exec(url.pathname);
  if (!family) return false;
  let released = false;
  const send = (status: number, body: unknown) => { json(response, status, body); released = true; };
  const fenced = async (run: (release: () => void) => Promise<void>, sendResponse: () => void) => {
    await releaseFencedResponse({ run, send: sendResponse, onReleased: () => { released = true; }, onDenied: () => {} });
  };
  try {
    // Mandatory shared protocol plumbing. Floor 1 does not resolve actors, credentials, metadata or blobs.
    const minimum = await deps.storage.identityProtocol.minimum();
    if (!Number.isSafeInteger(minimum) || minimum < 1) throw new Error("invalid_identity_protocol");
    if (minimum < 2) throw new RoomPluginAccessError("plugin_identity_not_active");
    const route = family[2] ?? "";
    const packageRoute = /^packages\/([^/]+)(\/content)?$/.exec(route);
    const bindingRoute = /^bindings\/([^/]+)$/.exec(route);
    if (route !== "packages" && route !== "runtime" && !packageRoute && !bindingRoute) return false;
    assertHeaders(request);
    const roomId = segment(family[1], "room");
    const actor = await deps.resolveActor(request, roomId);
    const actorRoom = actor.actorType === "room-session" ? actor.proof.roomId : actor.scope.roomId;
    if (actorRoom !== roomId || (actor.actorType === "administrator") !== (request.headers["x-vrata-admin-token"] !== undefined)) {
      throw new RoomPluginHttpError(401, "identity_required");
    }
    // Runtime and source bytes require an actual session, never an administrator author override.
    const runtimeRoute = route === "runtime" || packageRoute?.[2] === "/content";
    if (runtimeRoute && actor.actorType !== "room-session") throw new RoomPluginHttpError(401, "identity_required");
    const access = deps.storage.roomPluginAccess;
    const service = createRoomPluginHttpPackageService(access, deps.getBlobs);
    if (runtimeRoute) {
      if (request.method !== "GET") throw new RoomPluginHttpError(405, "plugin_method_not_allowed");
      if (actor.actorType !== "room-session") throw new RoomPluginHttpError(401, "identity_required");
      const runtime = access.runtime(actor);
      // Reject all URL credentials/claims, including optional caller-selected binding tuples.
      if (url.search) throw new RoomPluginHttpError(400, "plugin_invalid_request");
      if (route === "runtime") {
        let body: unknown;
        await fenced(release => runtime.releaseSnapshot(snapshot => { body = roomPluginRuntimeHttpDto(roomId, snapshot); release(); }),
          () => send(200, body));
      } else {
        const packageId = segment(packageRoute![1], "package");
        await service.releaseContent(runtime, packageId, (bytes, value) => {
          response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(bytes.byteLength),
            "content-disposition": `attachment; filename="${value.packageId}.vrata-plugin.json"`,
            "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'; base-uri 'none'",
            "cross-origin-resource-policy": "same-origin", "cache-control": "no-store", "referrer-policy": "no-referrer",
            "x-artifact-sha256": value.artifactSha256, "etag": `"${value.artifactSha256}"`,
            "access-control-allow-origin": process.env.API_CORS_ORIGIN ?? "*" });
          response.end(Buffer.from(bytes)); released = true;
        });
      }
      return true;
    }
    const author = access.author(actor);
    await author.authorize(); // Guests fail before body validation, Acorn parsing or config/secret reads.
    if (url.search) throw new RoomPluginHttpError(400, "plugin_invalid_request");
    const ack = async (status: number, body: unknown) => {
      // Ignore fresh library metadata: only the known own result may be acknowledged after live authorization.
      await fenced(release => author.releaseLibrary(() => { release(); }), () => send(status, body));
    };
    if (route === "packages" && request.method === "GET") {
      let body: unknown;
      await fenced(release => author.releaseLibrary(library => { body = roomPluginLibraryHttpDto(library); release(); }), () => send(200, body));
    } else if (route === "packages" && request.method === "POST") {
      const bytes = await readRoomPluginRequestBytes(request, ROOM_PLUGIN_LIMITS.artifactBytes);
      const value = await service.savePackage(author, bytes);
      await ack(201, { package: roomPluginPackageHttpDto(value) });
    } else if (packageRoute && !packageRoute[2] && request.method === "DELETE") {
      const packageId = segment(packageRoute[1], "package");
      await service.deletePackage(author, packageId);
      await ack(200, { deleted: true, packageId });
    } else if (bindingRoute && request.method === "PUT") {
      const pluginId = segment(bindingRoute[1], "plugin");
      const body = parseRoomPluginBindingHttpBody(await readRoomPluginRequestBytes(request, ROOM_PLUGIN_BINDING_HTTP_BYTES));
      const result = await author.putBinding(pluginId, body.input, body.expectedRevision);
      await ack(200, { ok: true, revision: result.revision });
    } else if (bindingRoute && request.method === "DELETE") {
      const pluginId = segment(bindingRoute[1], "plugin");
      const expectedRevision = parseRoomPluginUnbindHttpBody(await readRoomPluginRequestBytes(request, 128));
      const result = await author.removeBinding(pluginId, expectedRevision);
      await ack(200, { ok: true, revision: result.revision });
    } else throw new RoomPluginHttpError(405, "plugin_method_not_allowed");
    return true;
  } catch (error) {
    // The parent owns global metrics/error handling for a COMMIT failure after synchronous release.
    if (released || response.headersSent || response.writableEnded) throw error;
    if (error instanceof RoomPluginRequestBodyError) {
      response.setHeader("connection", "close");
      response.once("finish", () => { request.destroy(); });
    }
    const failure = roomPluginHttpError(error); send(failure.status, failure.body); return true;
  }
}
