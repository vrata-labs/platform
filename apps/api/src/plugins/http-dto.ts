import { ROOM_PLUGIN_LIMITS, parseRoomPluginJson, validateRoomPluginCapabilities,
  validateRoomPluginData, type RoomPluginConfig, type RoomPluginManifest } from "@vrata/room-plugin-sdk";
import { validateRoomPluginSha256 } from "@vrata/room-plugin-sdk/artifact";
import type { RoomPluginAuthorLibrary, RoomPluginRuntimeSnapshot } from "./access-contracts.js";
import { RoomPluginStorageError, type RoomPluginBindingInput, type RoomPluginPackage, type StoredRoomPluginBinding } from "./contracts.js";
import { ROOM_PLUGIN_STORAGE_LIMITS } from "./policy.js";

export const ROOM_PLUGIN_BINDING_HTTP_BYTES = ROOM_PLUGIN_STORAGE_LIMITS.bindingEnvelopeBytes + 128;

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RoomPluginStorageError("plugin_invalid_binding");
  return input as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (Object.keys(value).some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new RoomPluginStorageError("plugin_invalid_binding");
  }
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new RoomPluginStorageError("plugin_invalid_binding");
  return value;
}
export function parseRoomPluginBindingHttpBody(bytes: Uint8Array): { expectedRevision: number; input: RoomPluginBindingInput } {
  const body = record(parseRoomPluginJson(bytes, { maxBytes: ROOM_PLUGIN_BINDING_HTTP_BYTES }));
  fields(body, ["expectedRevision", "packageId", "version", "artifactSha256", "enabled", "config", "approvedCapabilities"], ["capabilityApproval"]);
  const expectedRevision = revision(body.expectedRevision);
  if (typeof body.packageId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.packageId)
    || typeof body.version !== "string" || body.version.length > 32 || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(body.version)
    || typeof body.enabled !== "boolean") throw new RoomPluginStorageError("plugin_invalid_binding");
  const config = record(validateRoomPluginData(body.config, { maxBytes: ROOM_PLUGIN_LIMITS.configBytes }));
  if (Object.keys(config).length > ROOM_PLUGIN_LIMITS.configFields || Object.entries(config).some(([key, value]) =>
    !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || !["string", "number", "boolean"].includes(typeof value))) {
    throw new RoomPluginStorageError("plugin_invalid_binding");
  }
  const input: RoomPluginBindingInput = { packageId: body.packageId, version: body.version,
    artifactSha256: validateRoomPluginSha256(body.artifactSha256), enabled: body.enabled,
    config: config as RoomPluginConfig, approvedCapabilities: validateRoomPluginCapabilities(body.approvedCapabilities) };
  if (body.capabilityApproval !== undefined) {
    const approval = record(body.capabilityApproval); fields(approval, ["artifactSha256", "capabilities"]);
    input.capabilityApproval = { artifactSha256: validateRoomPluginSha256(approval.artifactSha256),
      capabilities: validateRoomPluginCapabilities(approval.capabilities) };
  }
  validateRoomPluginData(input, { maxBytes: ROOM_PLUGIN_STORAGE_LIMITS.bindingEnvelopeBytes });
  return { expectedRevision, input };
}
export function parseRoomPluginUnbindHttpBody(bytes: Uint8Array): number {
  const body = record(parseRoomPluginJson(bytes, { maxBytes: 128 }));
  fields(body, ["expectedRevision"]); return revision(body.expectedRevision);
}

function manifestDto(value: RoomPluginManifest) {
  return { schemaVersion: value.schemaVersion, sdkApiVersion: value.sdkApiVersion, id: value.id,
    version: value.version, displayName: value.displayName, requestedCapabilities: [...value.requestedCapabilities],
    configSchema: structuredClone(value.configSchema), entrySha256: value.entrySha256 };
}
export function roomPluginPackageHttpDto(value: Readonly<RoomPluginPackage>) {
  return { packageId: value.packageId, pluginId: value.pluginId, version: value.version, artifactSha256: value.artifactSha256,
    byteLength: value.byteLength, manifest: manifestDto(value.manifest), state: value.state,
    uploadSettled: value.uploadSettled, createdAt: value.createdAt };
}
export function roomPluginBindingHttpDto(value: StoredRoomPluginBinding) {
  return { bindingId: value.bindingId, packageId: value.packageId, pluginId: value.pluginId, version: value.version,
    artifactSha256: value.artifactSha256, enabled: value.enabled, generation: value.generation, bindingRevision: value.bindingRevision,
    config: structuredClone(value.config), approvedCapabilities: [...value.approvedCapabilities] };
}
export function roomPluginLibraryHttpDto(value: RoomPluginAuthorLibrary) {
  return { packages: value.packages.map(roomPluginPackageHttpDto), bindings: value.bindings.map(roomPluginBindingHttpDto), revision: value.revision };
}
export function roomPluginRuntimeHttpDto(roomId: string, value: RoomPluginRuntimeSnapshot) {
  return { schemaVersion: 1, sdkApiVersion: 1, revision: value.revision, leaseExpiresAtMs: value.leaseExpiresAtMs,
    bindings: value.bindings.filter(binding => binding.enabled).map(binding => ({ ...roomPluginBindingHttpDto(binding),
      contentUrl: `/api/rooms/${encodeURIComponent(roomId)}/plugins/packages/${encodeURIComponent(binding.packageId)}/content` })) };
}
