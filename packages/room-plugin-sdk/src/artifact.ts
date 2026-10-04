import { createHash } from "node:crypto";
import { parse } from "acorn";
import { ROOM_PLUGIN_LIMITS, ROOM_PLUGIN_SCHEMA_VERSION, ROOM_PLUGIN_SDK_API_VERSION, type RoomPluginArtifact, type RoomPluginManifest } from "./contracts.js";
import { validateRoomPluginCapabilities, validateRoomPluginConfigSchema } from "./config.js";
import { parseRoomPluginJson, roomPluginFields, roomPluginRecord, roomPluginUtf8ByteLength, validateRoomPluginData } from "./data.js";
import { fail } from "./errors.js";
import { isRoomPluginPlainText } from "./text.js";

export interface ValidatedRoomPluginArtifact {
  artifact: RoomPluginArtifact;
  /** Hash of exact input bytes, including whitespace and key ordering. */
  artifactSha256: string;
  entrySha256: string;
  byteLength: number;
  entryByteLength: number;
  /** Owned copy of the validated input, suitable for immutable blob storage. */
  bytes: Uint8Array;
}

export function roomPluginSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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

/** Parse syntax only. Never loads, evaluates or executes a plugin module. */
export function validateRoomPluginModule(entry: unknown): asserts entry is string {
  if (typeof entry !== "string" || !entry.trim()) fail("invalid_module", "$.entry");
  roomPluginUtf8ByteLength(entry, ROOM_PLUGIN_LIMITS.artifactBytes, "artifact_too_large");
  let tree: unknown;
  try {
    tree = parse(entry, { ecmaVersion: 2020, sourceType: "module" });
  } catch {
    // Syntax errors and parser stack exhaustion are bounded diagnostics, not source echoes.
    fail("invalid_module", "$.entry");
  }
  const pending: unknown[] = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    if (record.type === "ImportDeclaration" || record.type === "ImportExpression" ||
      ((record.type === "ExportAllDeclaration" || record.type === "ExportNamedDeclaration") && record.source !== null && record.source !== undefined) ||
      (record.type === "MetaProperty" && (record.meta as Record<string, unknown>).name === "import")) {
      fail("module_import_forbidden", "$.entry");
    }
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item === "object") pending.push(item);
      } else if (child && typeof child === "object") pending.push(child);
    }
  }
}

/** Shared by external packaging tools and the author API. Requires original upload bytes. */
export function validateRoomPluginArtifact(input: string | Uint8Array, expectedArtifactSha256?: string): ValidatedRoomPluginArtifact {
  // Bound before copying, decoding, JSON.parse, hashing or parsing JavaScript.
  if (typeof input === "string") roomPluginUtf8ByteLength(input, ROOM_PLUGIN_LIMITS.artifactBytes, "artifact_too_large");
  else if (!(input instanceof Uint8Array)) fail("invalid_data");
  else if (input.byteLength > ROOM_PLUGIN_LIMITS.artifactBytes) fail("artifact_too_large");
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  const envelope = roomPluginRecord(parseRoomPluginJson(bytes, { maxBytes: ROOM_PLUGIN_LIMITS.artifactBytes, sizeError: "artifact_too_large" }), "$", "invalid_manifest");
  roomPluginFields(envelope, ["manifest", "entry"], [], "$");
  const manifest = validateRoomPluginManifest(envelope.manifest);
  if (typeof envelope.entry !== "string") fail("invalid_module", "$.entry");
  const entryBytes = new TextEncoder().encode(envelope.entry);
  const entrySha256 = roomPluginSha256(entryBytes);
  if (manifest.entrySha256 !== entrySha256) fail("entry_checksum_mismatch", "$.manifest.entrySha256");
  const artifactSha256 = roomPluginSha256(bytes);
  if (expectedArtifactSha256 !== undefined && validateRoomPluginSha256(expectedArtifactSha256) !== artifactSha256) fail("artifact_checksum_mismatch");
  validateRoomPluginModule(envelope.entry);
  return Object.freeze({
    artifact: envelope as unknown as RoomPluginArtifact,
    artifactSha256,
    entrySha256,
    byteLength: bytes.byteLength,
    entryByteLength: entryBytes.byteLength,
    bytes
  });
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) result[key] = canonical((value as Record<string, unknown>)[key]);
    return result;
  }
  return value;
}

/** Deterministic UTF-8 packaging of already bundled JS. No build/install scripts or URLs. */
export function createRoomPluginArtifact(manifestInput: Omit<RoomPluginManifest, "entrySha256">, entry: string): ValidatedRoomPluginArtifact {
  const manifest = roomPluginRecord(validateRoomPluginData(manifestInput, { maxBytes: ROOM_PLUGIN_LIMITS.artifactBytes, sizeError: "artifact_too_large" }), "$.manifest", "invalid_manifest");
  roomPluginFields(manifest, ["schemaVersion", "sdkApiVersion", "id", "version", "displayName", "requestedCapabilities", "configSchema"], [], "$.manifest");
  if (typeof entry !== "string") fail("invalid_module", "$.entry");
  roomPluginUtf8ByteLength(entry, ROOM_PLUGIN_LIMITS.artifactBytes, "artifact_too_large");
  const withChecksum = { ...manifest, entrySha256: roomPluginSha256(new TextEncoder().encode(entry)) };
  validateRoomPluginManifest(withChecksum);
  // Bound escaped JSON too: 1 MiB of source can exceed 1 MiB when placed in JSON.
  const envelope = validateRoomPluginData({ manifest: withChecksum, entry }, { maxBytes: ROOM_PLUGIN_LIMITS.artifactBytes, sizeError: "artifact_too_large" });
  return validateRoomPluginArtifact(JSON.stringify(canonical(envelope)) + "\n");
}
