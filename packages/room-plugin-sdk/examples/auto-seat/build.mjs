import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sdkRoot = dirname(require.resolve("@vrata/room-plugin-sdk/package.json"));
const cli = join(sdkRoot, require("@vrata/room-plugin-sdk/package.json").bin["vrata-room-plugin"]);
const cwd = fileURLToPath(new URL("./", import.meta.url));
for (const args of [
  ["bundle", "--entry", "entry.ts", "--out", "entry.bundle.mjs"],
  ["pack", "--manifest", "manifest.json", "--entry", "entry.bundle.mjs", "--out", "auto-seat.vrata-plugin.json"],
  ["validate", "auto-seat.vrata-plugin.json"]
]) execFileSync(process.execPath, [cli, ...args], { cwd, stdio: "inherit" });
