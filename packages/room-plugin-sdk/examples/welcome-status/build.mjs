import { readFile, writeFile } from "node:fs/promises";
import { createRoomPluginArtifact, validateRoomPluginArtifact } from "@vrata/room-plugin-sdk/artifact";

// Preserve source bytes; malformed UTF-8 must fail rather than silently become U+FFFD.
const entry = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
  await readFile(new URL("./entry.js", import.meta.url))
);

const artifact = createRoomPluginArtifact({
  schemaVersion: 1,
  sdkApiVersion: 1,
  id: "welcome-status",
  version: "1.0.0",
  displayName: "Welcome status",
  requestedCapabilities: ["status.set"],
  configSchema: { greeting: { type: "string", required: false, minLength: 1, maxLength: 256 } }
}, entry);
const output = new URL("./welcome-status.vrata-plugin.json", import.meta.url);
await writeFile(output, artifact.bytes);
const validated = validateRoomPluginArtifact(await readFile(output), artifact.artifactSha256);
console.log(JSON.stringify({ artifact: "welcome-status.vrata-plugin.json", sha256: validated.artifactSha256, bytes: validated.byteLength }));
