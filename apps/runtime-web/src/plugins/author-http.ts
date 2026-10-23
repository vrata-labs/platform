import { ROOM_PLUGIN_LIMITS, parseRoomPluginJson, validateRoomPluginCapabilities, validateRoomPluginData,
  validateRoomPluginManifest, validateRoomPluginSha256, type RoomPluginCapability, type RoomPluginConfig, type RoomPluginManifest } from "@vrata/room-plugin-sdk";
import { boundedRoomPluginBody } from "./http.js";

export const ROOM_PLUGIN_LIBRARY_BYTES = 512 * 1024;
const LIBRARY_ITEMS = 32;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const packageStates = ["reserved", "ready", "cleanup-pending"] as const;

export interface RoomPluginAuthorPackage {
  packageId: string; pluginId: string; version: string; artifactSha256: string; byteLength: number;
  manifest: RoomPluginManifest; state: (typeof packageStates)[number]; uploadSettled: boolean;
}
export interface RoomPluginAuthorBinding {
  packageId: string; pluginId: string; version: string; artifactSha256: string; enabled: boolean;
  /** Changes with every write of this binding; a form draft based on an older value is stale. */
  bindingRevision: number;
  config: RoomPluginConfig; approvedCapabilities: readonly RoomPluginCapability[];
}
export interface RoomPluginAuthorLibrary {
  revision: number; packages: readonly RoomPluginAuthorPackage[]; bindings: readonly RoomPluginAuthorBinding[];
}
export interface RoomPluginBindingWrite {
  packageId: string; version: string; artifactSha256: string; enabled: boolean;
  config: RoomPluginConfig; approvedCapabilities: readonly RoomPluginCapability[];
}

export type RoomPluginAuthorFailure = "unsupported" | "forbidden" | "session" | "conflict" | "approval-required" | "quota"
  | "bound" | "invalid-package" | "version-conflict" | "version-deleted" | "config-invalid" | "too-large" | "pending" | "unavailable";
/** Fixed failure classes only; server text, paths and bodies are never displayed. */
export class RoomPluginAuthorError extends Error {
  constructor(readonly failure: RoomPluginAuthorFailure) { super(failure); this.name = "RoomPluginAuthorError"; }
}
function invalid(): never { throw new RoomPluginAuthorError("unavailable"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function counter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function identifier(value: unknown, pattern: RegExp, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || !pattern.test(value)) invalid();
  return value;
}
const pluginId = (value: unknown) => identifier(value, /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/, 64);
const version = (value: unknown) => identifier(value, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/, 32);
function config(value: unknown): RoomPluginConfig {
  const result = record(validateRoomPluginData(value, { maxBytes: ROOM_PLUGIN_LIMITS.configBytes }));
  if (Object.keys(result).length > ROOM_PLUGIN_LIMITS.configFields
    || Object.values(result).some(item => !["string", "number", "boolean"].includes(typeof item))) invalid();
  return result as RoomPluginConfig;
}

export function parseRoomPluginAuthorLibrary(bytes: Uint8Array | string): RoomPluginAuthorLibrary {
  try {
    const root = record(parseRoomPluginJson(bytes, { maxBytes: ROOM_PLUGIN_LIBRARY_BYTES }));
    if (!Array.isArray(root.packages) || !Array.isArray(root.bindings) || root.packages.length > LIBRARY_ITEMS || root.bindings.length > LIBRARY_ITEMS) invalid();
    const packages = root.packages.map(input => {
      const value = record(input), manifest = validateRoomPluginManifest(value.manifest);
      const state = packageStates.find(item => item === value.state);
      const result = { packageId: identifier(value.packageId, uuid, 36), pluginId: pluginId(value.pluginId), version: version(value.version),
        artifactSha256: validateRoomPluginSha256(value.artifactSha256), byteLength: counter(value.byteLength), manifest,
        state: state ?? invalid(), uploadSettled: value.uploadSettled === true };
      if (manifest.id !== result.pluginId || manifest.version !== result.version) invalid();
      return Object.freeze(result);
    });
    const bindings = root.bindings.map(input => {
      const value = record(input);
      if (typeof value.enabled !== "boolean") invalid();
      return Object.freeze({ packageId: identifier(value.packageId, uuid, 36), pluginId: pluginId(value.pluginId), version: version(value.version),
        artifactSha256: validateRoomPluginSha256(value.artifactSha256), enabled: value.enabled, bindingRevision: counter(value.bindingRevision), config: config(value.config),
        approvedCapabilities: validateRoomPluginCapabilities(value.approvedCapabilities) });
    });
    if (new Set(bindings.map(binding => binding.pluginId)).size !== bindings.length) invalid();
    return Object.freeze({ revision: counter(root.revision), packages: Object.freeze(packages), bindings: Object.freeze(bindings) });
  } catch { throw new RoomPluginAuthorError("unavailable"); }
}

export function roomPluginAuthorFailure(status: number, code: unknown, route: "library" | "upload" | "binding" | "package" = "library"): RoomPluginAuthorFailure {
  switch (code) {
    // A deleted release stays an immutable tombstone; re-uploading the same version never succeeds.
    case "plugin_invalid_transition": if (route === "upload") return "version-deleted"; break;
    case "plugin_identity_not_active": return "unsupported";
    case "plugin_author_forbidden": case "plugin_request_forbidden": return "forbidden";
    case "identity_required": case "identity_session_expired": return "session";
    case "plugin_revision_conflict": case "plugin_package_not_found": case "plugin_binding_changed": return "conflict";
    case "plugin_capability_approval_required": return "approval-required";
    case "plugin_quota_exceeded": case "plugin_history_quota_exceeded": return "quota";
    case "plugin_package_bound": return "bound";
    case "plugin_version_conflict": return "version-conflict";
    case "plugin_body_too_large": return "too-large";
    case "plugin_operation_pending": case "plugin_upload_pending": case "plugin_package_not_ready": case "room_plugin_cleanup_pending": return "pending";
  }
  // An API without plugin routes answers a generic 404: no author panel, not an error.
  if (status === 404) return "unsupported";
  if (status === 401) return "session";
  if (status === 413) return "too-large";
  if (status === 400 && typeof code === "string") return route === "binding" ? "config-invalid" : "invalid-package";
  return "unavailable";
}

/** Room-author routes with the caller's own RS2 session; no admin token, cookies or redirects. */
export function createRoomPluginAuthorHttp(input: { apiBaseUrl: string; roomId: string; token(): string | null; fetch?: typeof fetch }) {
  const fetcher = input.fetch ?? globalThis.fetch;
  const base = `/api/rooms/${encodeURIComponent(input.roomId)}/plugins/`;
  async function call(path: string, method: string, body: Uint8Array | object | undefined, maximum: number, timeoutMs: number,
    route: Parameters<typeof roomPluginAuthorFailure>[2]): Promise<Uint8Array> {
    const token = input.token();
    if (!token) throw new RoomPluginAuthorError("session");
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const binary = body instanceof Uint8Array;
      const response = await Reflect.apply(fetcher, globalThis, [new URL(base + path, input.apiBaseUrl).href, {
        method, credentials: "omit", redirect: "error", cache: "no-store", signal: abort.signal,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": binary ? "application/octet-stream" : "application/json" }) },
        ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) })
      }]) as Response;
      if (response.ok) return await boundedRoomPluginBody(response, maximum);
      let code: unknown;
      try { code = record(parseRoomPluginJson(await boundedRoomPluginBody(response, 2048))).error; } catch { code = undefined; }
      throw new RoomPluginAuthorError(roomPluginAuthorFailure(response.status, code, route));
    } catch (error) {
      if (error instanceof RoomPluginAuthorError) throw error;
      throw new RoomPluginAuthorError("unavailable");
    } finally { clearTimeout(timer); abort.abort(); }
  }
  const revisionOf = (bytes: Uint8Array) => {
    try { return counter(record(parseRoomPluginJson(bytes, { maxBytes: 1024 })).revision); }
    catch { throw new RoomPluginAuthorError("unavailable"); }
  };
  const segment = (value: string) => encodeURIComponent(value);
  return {
    async library(): Promise<RoomPluginAuthorLibrary> {
      return parseRoomPluginAuthorLibrary(await call("packages", "GET", undefined, ROOM_PLUGIN_LIBRARY_BYTES, 8000, "library"));
    },
    async upload(bytes: Uint8Array): Promise<void> {
      if (bytes.byteLength > ROOM_PLUGIN_LIMITS.artifactBytes) throw new RoomPluginAuthorError("too-large");
      await call("packages", "POST", bytes, 64 * 1024, 20_000, "upload");
    },
    /** approval names the exact capabilities the author just confirmed for this exact artifact. */
    async bind(pluginIdValue: string, expectedRevision: number, write: RoomPluginBindingWrite,
      approval: readonly RoomPluginCapability[] | null): Promise<number> {
      const body = { expectedRevision, packageId: write.packageId, version: write.version, artifactSha256: write.artifactSha256,
        enabled: write.enabled, config: write.config, approvedCapabilities: [...write.approvedCapabilities],
        ...(approval ? { capabilityApproval: { artifactSha256: write.artifactSha256, capabilities: [...approval] } } : {}) };
      return revisionOf(await call(`bindings/${segment(pluginId(pluginIdValue))}`, "PUT", body, 1024, 8000, "binding"));
    },
    async unbind(pluginIdValue: string, expectedRevision: number): Promise<number> {
      return revisionOf(await call(`bindings/${segment(pluginId(pluginIdValue))}`, "DELETE", { expectedRevision }, 1024, 8000, "binding"));
    },
    async remove(packageId: string): Promise<void> {
      await call(`packages/${segment(identifier(packageId, uuid, 36))}`, "DELETE", undefined, 1024, 8000, "package");
    }
  };
}
