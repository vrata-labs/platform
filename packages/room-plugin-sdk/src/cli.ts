#!/usr/bin/env node
import { createRoomPluginArtifact, roomPluginSha256, validateRoomPluginArtifact, type ValidatedRoomPluginArtifact } from "./artifact.js";
import { ROOM_PLUGIN_LIMITS, type RoomPluginManifest } from "./contracts.js";
import { parseRoomPluginJson } from "./data.js";
import { RoomPluginValidationError } from "./errors.js";
import { decodeRoomPluginFile, readRoomPluginFile, RoomPluginCliError, writeRoomPluginFile } from "./cli-io.js";

type Command = "bundle" | "pack" | "validate" | "help";
const args = process.argv.slice(2);
const command: Command | undefined = args[0] === "--help" ? "help" : ["bundle", "pack", "validate"].includes(args[0] ?? "") ? args[0] as Command : undefined;

function options(required: readonly string[], optional: readonly string[] = []): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key || !required.includes(key) && !optional.includes(key) || Object.hasOwn(result, key) || !value || value.startsWith("--")) throw new RoomPluginCliError("cli_usage", 2);
    result[key] = value;
  }
  if (required.some(key => !Object.hasOwn(result, key))) throw new RoomPluginCliError("cli_usage", 2);
  return result;
}

function summary(value: ValidatedRoomPluginArtifact): object {
  return { artifactSha256: value.artifactSha256, entrySha256: value.entrySha256, bytes: value.byteLength, entryBytes: value.entryByteLength };
}

async function run(): Promise<object> {
  switch (command) {
    case "help":
      if (args.length !== 1) throw new RoomPluginCliError("cli_usage", 2);
      return { commands: ["bundle --entry <file> --out <module.js> [--root <project-directory>]", "pack --manifest <file> --entry <bundled.js> --out <artifact.vrata-plugin.json>", "validate <artifact.vrata-plugin.json>"] };
    case "bundle": {
      const value = options(["--entry", "--out"], ["--root"]);
      // Compiler loading is exclusive to this explicit author-local command, never the API validator.
      const { bundleRoomPluginFile } = await import("./cli-bundle.js");
      const bytes = await bundleRoomPluginFile(value["--entry"]!, value["--root"]);
      await writeRoomPluginFile(value["--out"]!, bytes);
      return { entrySha256: roomPluginSha256(bytes), bytes: bytes.byteLength };
    }
    case "pack": {
      const value = options(["--manifest", "--entry", "--out"]);
      const manifest = parseRoomPluginJson(await readRoomPluginFile(value["--manifest"]!, 32 * 1024, "manifest_too_large"), { maxBytes: 32 * 1024 });
      const entry = decodeRoomPluginFile(await readRoomPluginFile(value["--entry"]!, ROOM_PLUGIN_LIMITS.artifactBytes, "entry_too_large"));
      const artifact = createRoomPluginArtifact(manifest as unknown as Omit<RoomPluginManifest, "entrySha256">, entry);
      await writeRoomPluginFile(value["--out"]!, artifact.bytes);
      return summary(artifact);
    }
    case "validate":
      if (args.length !== 2 || args[1]!.startsWith("--")) throw new RoomPluginCliError("cli_usage", 2);
      return summary(validateRoomPluginArtifact(await readRoomPluginFile(args[1]!, ROOM_PLUGIN_LIMITS.artifactBytes, "artifact_too_large")));
    default: throw new RoomPluginCliError("cli_usage", 2);
  }
}

// Only stable codes/hashes/counts leave the CLI, never exception text, source, config, paths or props.
process.stdout.on("error", () => { process.exitCode = 4; });
try {
  const result = await run();
  process.stdout.write(JSON.stringify({ ok: true, command, ...result }) + "\n");
} catch (error) {
  const code = error instanceof RoomPluginCliError || error instanceof RoomPluginValidationError ? error.code : "internal_error";
  process.exitCode = error instanceof RoomPluginValidationError ? 3 : error instanceof RoomPluginCliError ? error.exitCode : 5;
  process.stdout.write(JSON.stringify({ ok: false, command: command ?? null, error: { code } }) + "\n");
}
