import { ROOM_PLUGIN_LIMITS, parseRoomPluginJson, validateRoomPluginCapabilities, validateRoomPluginData,
  validateRoomPluginSha256, type RoomPluginBinding, type RoomPluginConfig } from "@vrata/room-plugin-sdk";
import { RoomPluginRuntimeError } from "./runtime-errors.js";

export const ROOM_PLUGIN_RUNTIME_CONFIG_BYTES = 64 * 1024;
export interface RoomPluginRuntimeBinding extends RoomPluginBinding { packageId: string; contentUrl: string }
export interface RoomPluginRuntimeSnapshot {
  schemaVersion: 1; sdkApiVersion: 1; revision: number; leaseExpiresAtMs: number;
  bindings: readonly RoomPluginRuntimeBinding[];
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function invalid(): never { throw new RoomPluginRuntimeError("invalid-runtime-config"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) invalid();
}
function counter(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
export function roomPluginContentPath(roomId: string, packageId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/plugins/packages/${encodeURIComponent(packageId)}/content`;
}

/** Host-only DTO. Never pass the native binding identity or URL into the VM. */
export function parseRoomPluginRuntimeSnapshot(bytes: string | Uint8Array, roomId: string): RoomPluginRuntimeSnapshot {
  try {
    const root = record(parseRoomPluginJson(bytes, { maxBytes: ROOM_PLUGIN_RUNTIME_CONFIG_BYTES }));
    fields(root, ["schemaVersion", "sdkApiVersion", "revision", "leaseExpiresAtMs", "bindings"]);
    if (root.schemaVersion !== 1 || root.sdkApiVersion !== 1) invalid();
    const revision = counter(root.revision), leaseExpiresAtMs = counter(root.leaseExpiresAtMs);
    if (!leaseExpiresAtMs || !Array.isArray(root.bindings) || root.bindings.length > ROOM_PLUGIN_LIMITS.enabledPluginsPerRoom) invalid();
    const bindingIds = new Set<string>(), pluginIds = new Set<string>(), packageIds = new Set<string>();
    const bindings = root.bindings.map(input => {
      const value = record(input);
      fields(value, ["bindingId", "packageId", "pluginId", "version", "artifactSha256", "enabled", "generation", "bindingRevision", "config", "approvedCapabilities", "contentUrl"]);
      if (typeof value.bindingId !== "string" || !uuid.test(value.bindingId) || bindingIds.has(value.bindingId)
        || typeof value.packageId !== "string" || !uuid.test(value.packageId) || packageIds.has(value.packageId)
        || typeof value.pluginId !== "string" || value.pluginId.length > 64 || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value.pluginId) || pluginIds.has(value.pluginId)
        || typeof value.version !== "string" || value.version.length > 32 || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value.version)
        || value.enabled !== true || value.contentUrl !== roomPluginContentPath(roomId, value.packageId)) invalid();
      const generation = counter(value.generation), bindingRevision = counter(value.bindingRevision);
      if (bindingRevision > revision) invalid();
      const config = record(validateRoomPluginData(value.config, { maxBytes: ROOM_PLUGIN_LIMITS.configBytes }));
      if (Object.keys(config).length > ROOM_PLUGIN_LIMITS.configFields
        || Object.values(config).some(item => !["string", "number", "boolean"].includes(typeof item))) invalid();
      bindingIds.add(value.bindingId); packageIds.add(value.packageId); pluginIds.add(value.pluginId);
      return Object.freeze({ bindingId: value.bindingId, packageId: value.packageId, pluginId: value.pluginId,
        version: value.version, artifactSha256: validateRoomPluginSha256(value.artifactSha256), enabled: true,
        generation, bindingRevision, config: config as RoomPluginConfig,
        approvedCapabilities: validateRoomPluginCapabilities(value.approvedCapabilities), contentUrl: value.contentUrl }) as RoomPluginRuntimeBinding;
    });
    return Object.freeze({ schemaVersion: 1, sdkApiVersion: 1, revision, leaseExpiresAtMs, bindings: Object.freeze(bindings) });
  } catch { throw new RoomPluginRuntimeError("invalid-runtime-config"); }
}
