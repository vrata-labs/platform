import { createHash } from "node:crypto";
import { parse } from "acorn";
import { ROOM_PLUGIN_LIMITS, type RoomPluginArtifact, type RoomPluginManifest } from "./contracts.js";
import { roomPluginFields, roomPluginRecord, roomPluginUtf8ByteLength, validateRoomPluginData } from "./data.js";
import { fail } from "./errors.js";
import { parseRoomPluginArtifactEnvelope, validateRoomPluginManifest, validateRoomPluginSha256 } from "./manifest.js";
export { validateRoomPluginManifest, validateRoomPluginSha256 } from "./manifest.js";

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
  const { artifact, bytes, entryBytes } = parseRoomPluginArtifactEnvelope(input);
  const manifest = artifact.manifest;
  const entrySha256 = roomPluginSha256(entryBytes);
  if (manifest.entrySha256 !== entrySha256) fail("entry_checksum_mismatch", "$.manifest.entrySha256");
  const artifactSha256 = roomPluginSha256(bytes);
  if (expectedArtifactSha256 !== undefined && validateRoomPluginSha256(expectedArtifactSha256) !== artifactSha256) fail("artifact_checksum_mismatch");
  validateRoomPluginModule(artifact.entry);
  return Object.freeze({
    artifact,
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
