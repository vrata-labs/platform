import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Explicit author-local build; only the public SDK bin/package.json contract is used.
const require = createRequire(import.meta.url);
const sdkRoot = dirname(require.resolve("@vrata/room-plugin-sdk/package.json"));
const cli = join(sdkRoot, require("@vrata/room-plugin-sdk/package.json").bin["vrata-room-plugin"]);
const cwd = fileURLToPath(new URL("./", import.meta.url));
for (const args of [
  ["bundle", "--entry", "entry.js", "--out", "entry.bundle.mjs"],
  ["pack", "--manifest", "manifest.json", "--entry", "entry.bundle.mjs", "--out", "welcome-status.vrata-plugin.json"],
  ["validate", "welcome-status.vrata-plugin.json"]
]) execFileSync(process.execPath, [cli, ...args], { cwd, stdio: "inherit" });
