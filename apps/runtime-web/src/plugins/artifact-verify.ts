import { ROOM_PLUGIN_LIMITS, parseRoomPluginArtifactEnvelope, validateRoomPluginConfig, type RoomPluginArtifact, type RoomPluginConfig } from "@vrata/room-plugin-sdk";
import type { RoomPluginRuntimeBinding } from "./runtime-dto.js";
import { RoomPluginRuntimeError } from "./runtime-errors.js";

export interface VerifiedRoomPluginArtifact { artifact: RoomPluginArtifact; config: RoomPluginConfig }
async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength); new Uint8Array(buffer).set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

/** Hash exact private bytes before a VM exists; never import/evaluate the entry. */
export async function verifyRoomPluginArtifact(bytes: Uint8Array, binding: RoomPluginRuntimeBinding): Promise<VerifiedRoomPluginArtifact> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > ROOM_PLUGIN_LIMITS.artifactBytes) throw new RoomPluginRuntimeError("invalid-artifact");
  if (!globalThis.crypto?.subtle) throw new RoomPluginRuntimeError("insecure-context");
  try {
    const owned = new Uint8Array(bytes);
    if (await sha256(owned) !== binding.artifactSha256) throw new RoomPluginRuntimeError("integrity-failed");
    const envelope = parseRoomPluginArtifactEnvelope(owned);
    const { manifest } = envelope.artifact;
    if (manifest.id !== binding.pluginId || manifest.version !== binding.version
      || binding.approvedCapabilities.some(capability => !manifest.requestedCapabilities.includes(capability))) {
      throw new RoomPluginRuntimeError("invalid-artifact");
    }
    if (await sha256(envelope.entryBytes) !== manifest.entrySha256) throw new RoomPluginRuntimeError("integrity-failed");
    const config = validateRoomPluginConfig(manifest.configSchema, binding.config);
    return Object.freeze({ artifact: envelope.artifact, config });
  } catch (error) {
    if (error instanceof RoomPluginRuntimeError) throw error;
    throw new RoomPluginRuntimeError("invalid-artifact");
  }
}
