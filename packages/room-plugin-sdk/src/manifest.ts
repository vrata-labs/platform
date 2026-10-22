import { ROOM_PLUGIN_LIMITS, ROOM_PLUGIN_SCHEMA_VERSION, ROOM_PLUGIN_SDK_API_VERSION, type RoomPluginArtifact, type RoomPluginManifest } from "./contracts.js";
import { validateRoomPluginCapabilities, validateRoomPluginConfigSchema } from "./config.js";
import { parseRoomPluginJson, roomPluginFields, roomPluginRecord, roomPluginUtf8ByteLength, validateRoomPluginData } from "./data.js";
import { fail } from "./errors.js";
import { isRoomPluginPlainText } from "./text.js";

export function validateRoomPluginSha256(value: unknown, path = "$"): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("invalid_hash", path);
  return value;
}

export function validateRoomPluginManifest(value: unknown): RoomPluginManifest {
  const manifest = roomPluginRecord(validateRoomPluginData(value, { maxBytes: ROOM_PLUGIN_LIMITS.artifactBytes, sizeError: "artifact_too_large" }), "$.manifest", "invalid_manifest");
  roomPluginFields(manifest, ["schemaVersion", "sdkApiVersion", "id", "version", "displayName", "requestedCapabilities", "configSchema", "entrySha256"], [], "$.manifest");
  if (manifest.schemaVersion !== ROOM_PLUGIN_SCHEMA_VERSION) fail("unsupported_schema_version", "$.manifest.schemaVersion");
  if (manifest.sdkApiVersion !== ROOM_PLUGIN_SDK_API_VERSION) fail("unsupported_sdk_api_version", "$.manifest.sdkApiVersion");
  if (typeof manifest.id !== "string" || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(manifest.id) || manifest.id.length > 64) fail("invalid_manifest", "$.manifest.id");
  if (typeof manifest.version !== "string" || manifest.version.length > 32 || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(manifest.version)) fail("invalid_manifest", "$.manifest.version");
  if (!isRoomPluginPlainText(manifest.displayName) || !manifest.displayName.trim() || roomPluginUtf8ByteLength(manifest.displayName) > 128) fail("invalid_manifest", "$.manifest.displayName");
  validateRoomPluginCapabilities(manifest.requestedCapabilities);
  validateRoomPluginConfigSchema(manifest.configSchema);
  validateRoomPluginSha256(manifest.entrySha256, "$.manifest.entrySha256");
  return manifest as unknown as RoomPluginManifest;
}

export interface RoomPluginArtifactEnvelope {
  artifact: RoomPluginArtifact;
  /** Owned exact input; parsing alone does not establish either checksum. */
  bytes: Uint8Array;
  entryBytes: Uint8Array;
  byteLength: number;
  entryByteLength: number;
}

/** Browser-safe bounded shape validation. The caller must verify both hashes;
 * Node packaging additionally validates module syntax without executing it. */
export function parseRoomPluginArtifactEnvelope(input: string | Uint8Array): RoomPluginArtifactEnvelope {
  if (typeof input === "string") roomPluginUtf8ByteLength(input, ROOM_PLUGIN_LIMITS.artifactBytes, "artifact_too_large");
  else if (!(input instanceof Uint8Array)) fail("invalid_data");
  else if (input.byteLength > ROOM_PLUGIN_LIMITS.artifactBytes) fail("artifact_too_large");
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  const envelope = roomPluginRecord(parseRoomPluginJson(bytes, { maxBytes: ROOM_PLUGIN_LIMITS.artifactBytes, sizeError: "artifact_too_large" }), "$", "invalid_manifest");
  roomPluginFields(envelope, ["manifest", "entry"], [], "$");
  validateRoomPluginManifest(envelope.manifest);
  if (typeof envelope.entry !== "string") fail("invalid_module", "$.entry");
  const entryBytes = new TextEncoder().encode(envelope.entry);
  return Object.freeze({ artifact: envelope as unknown as RoomPluginArtifact, bytes, entryBytes,
    byteLength: bytes.byteLength, entryByteLength: entryBytes.byteLength });
}
