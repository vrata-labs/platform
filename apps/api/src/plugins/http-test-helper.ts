import { createRoomPluginArtifact, validateRoomPluginArtifact } from "@vrata/room-plugin-sdk/artifact";
import type { IncomingMessage } from "node:http";
import { IncomingMessage as HttpRequest } from "node:http";
import { Socket } from "node:net";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import type { Storage } from "../storage-contracts.js";
import { RoomPluginAccessError, type RoomPluginAccessFactory, type RoomPluginAuthorAccess, type RoomPluginAuthorActor,
  type RoomPluginCleanupTicket, type RoomPluginContentTicket, type RoomPluginRuntimeAccess, type RoomPluginUploadTicket } from "./access-contracts.js";
import type { RoomPluginBlobStorage } from "./blob-storage.js";
import type { RoomPluginPackage, StoredRoomPluginBinding } from "./contracts.js";

export const httpTestBearer = `Bearer rs2.e30.${"a".repeat(43)}`;
export function pluginHttpFixture() {
  const bytes = createRoomPluginArtifact({ schemaVersion: 1, sdkApiVersion: 1, id: "fixture", version: "1.0.0", displayName: "Fixture",
    requestedCapabilities: ["status.set"], configSchema: { label: { type: "string", required: false, minLength: 0, maxLength: 4096 } } },
  "globalThis.__plugin_http_executed = true; export function init() {}").bytes;
  const validated = validateRoomPluginArtifact(bytes);
  const value: RoomPluginPackage = { tenantId: "tenant", roomId: "room", packageId: "11111111-1111-4111-8111-111111111111",
    pluginId: "fixture", version: "1.0.0", artifactSha256: validated.artifactSha256, byteLength: bytes.byteLength,
    manifest: validated.artifact.manifest, storageKey: "private-object-key", backendFingerprint: "a".repeat(64),
    state: "reserved", uploadSettled: false, createdAt: "2026-10-06T00:00:00.000Z" };
  const actor: RoomPluginAuthorActor = { actorType: "room-session", proof: { tenantId: "tenant", roomId: "room",
    identityId: "identity", participantId: "participant", authEpoch: 1 }, expiresAtSeconds: Math.floor(Date.now() / 1000) + 900 };
  let revision = 0, floor = 2, denial: unknown;
  let bindings: StoredRoomPluginBinding[] = [];
  const calls: string[] = [], objects = new Map<string, Uint8Array>();
  const admit = () => { if (denial) throw denial; };
  const ticket = (disposition: RoomPluginUploadTicket["disposition"]) => ({ package: structuredClone(value), disposition }) as RoomPluginUploadTicket;
  const deletion = () => ({ package: structuredClone(value) }) as RoomPluginCleanupTicket;
  const author: RoomPluginAuthorAccess = {
    async authorize() { calls.push("authorize"); admit(); },
    async reservePackage(input, fingerprint) {
      calls.push("reserve"); admit();
      validateRoomPluginArtifact(input, value.artifactSha256);
      if (fingerprint !== value.backendFingerprint) throw new Error("fingerprint mismatch");
      return ticket(value.state === "ready" ? "ready" : value.uploadSettled ? "resume" : "write");
    },
    async publishPackage() { calls.push("publish"); admit(); value.state = "ready"; return structuredClone(value); },
    async putBinding(pluginId, input, expected) {
      calls.push("bind"); admit();
      if (expected !== revision) throw new Error("unexpected revision");
      bindings = [{ ...input, tenantId: value.tenantId, roomId: value.roomId, pluginId, bindingId: "binding", generation: ++revision,
        bindingRevision: revision }];
      return { revision, bindings: structuredClone(bindings) };
    },
    async removeBinding(_plugin, expected) { calls.push("unbind"); admit();
      if (expected !== revision) throw new Error("unexpected revision");
      revision++; bindings = []; return { revision, bindings: [] }; },
    async beginPackageDeletion() { calls.push("delete-intent"); admit(); value.state = "cleanup-pending"; return deletion(); },
    async releaseLibrary(send) { calls.push("release-library"); admit();
      send({ revision, packages: value.state === "deleted" ? [] : [structuredClone(value)], bindings: structuredClone(bindings) }); }
  };
  const runtime: RoomPluginRuntimeAccess = {
    async releaseSnapshot(send) { calls.push("release-snapshot"); admit();
      send({ revision, bindings: structuredClone(bindings), leaseExpiresAtMs: Math.min(Date.now() + 5000, actor.expiresAtSeconds * 1000) }); },
    async prepareBoundContent() { calls.push("prepare-content"); admit();
      const binding = bindings.find(binding => binding.enabled && binding.packageId === value.packageId);
      if (!binding) throw new RoomPluginAccessError("plugin_content_not_bound");
      return { package: structuredClone(value), binding: structuredClone(binding), revision } as RoomPluginContentTicket; },
    async releaseBoundContent(saved, data, send) { calls.push("release-content"); admit();
      const validated = validateRoomPluginArtifact(data, saved.package.artifactSha256);
      if (revision !== saved.revision) throw new RoomPluginAccessError("plugin_binding_changed");
      send(validated.bytes); }
  };
  const access: RoomPluginAccessFactory = { author: () => author, runtime: () => runtime, continuation: {
    async settleUpload(_ticket, outcome) { calls.push(`settle-${outcome}`); value.uploadSettled = true;
      if (outcome === "acked") return null;
      if (value.state === "ready") return null;
      value.state = "cleanup-pending"; return deletion(); },
    async abandonUnpublished() { calls.push("abandon");
      if (value.state === "ready") return null;
      value.state = "cleanup-pending"; return deletion(); },
    async confirmDeletion() { calls.push("confirm-delete"); value.state = "deleted"; }
  } };
  const blobs: RoomPluginBlobStorage = { backendFingerprint: value.backendFingerprint!,
    async put(_scope, key, data) { calls.push("put"); objects.set(key, new Uint8Array(data)); },
    async read(_scope, key) { calls.push("read"); const data = objects.get(key); if (!data) throw new Error("object missing"); return new Uint8Array(data); },
    async delete(_scope, key) { calls.push("delete"); objects.delete(key); }
  };
  const storage = { identityProtocol: { minimum: async () => { calls.push("floor"); return floor; } },
    get roomPluginAccess() { calls.push("access"); return access; },
    get roomPlugins() { throw new Error("HTTP must not access raw plugin storage"); } } as unknown as Storage;
  const deps = { storage, getBlobs: () => { calls.push("config"); return blobs; },
    resolveActor: async (_req: IncomingMessage, _room: string): Promise<RoomPluginAuthorActor> => { calls.push("resolve-actor"); return actor; } };
  return { bytes, value, actor, calls, objects, author, runtime, access, blobs, deps,
    setDenial(error: unknown) { denial = error; }, setFloor(value: number) { floor = value; },
    setBindings(value: StoredRoomPluginBinding[], nextRevision = revision) { bindings = structuredClone(value); revision = nextRevision; },
    ticket, deletion };
}

export function pluginHttpRequest(method: string, headers: Record<string, string> = { authorization: httpTestBearer }, body?: Uint8Array) {
  const request = new HttpRequest(new Socket()); request.method = method;
  request.headers = headers; request.rawHeaders = Object.entries(headers).flat();
  if (body) request.push(Buffer.from(body));
  request.push(null);
  return request;
}
export function pluginHttpResponse() {
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number; headersSent: boolean; writableEnded: boolean; sends: number; headers: Record<string, string>; bytes: Buffer;
    setHeader: (key: string, value: string) => void;
    writeHead: (status: number, headers: Record<string, string>) => void;
    end: (body: string | Uint8Array) => void;
  };
  Object.assign(response, { statusCode: 0, headersSent: false, writableEnded: false, sends: 0, headers: {}, bytes: Buffer.alloc(0) });
  response.setHeader = (name, value) => { response.headers[name.toLowerCase()] = value; };
  response.writeHead = (status, headers) => { response.statusCode = status; response.headersSent = true; Object.assign(response.headers, headers); };
  response.end = body => { response.sends++; response.bytes = Buffer.from(body); response.writableEnded = true; response.emit("finish"); };
  return { response: response as unknown as ServerResponse, captured: response,
    json: () => JSON.parse(response.bytes.toString("utf8")) as Record<string, any> };
}
