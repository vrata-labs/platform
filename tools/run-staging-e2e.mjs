#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const defaultBaseUrl = "https://158.160.10.234.sslip.io";

function parseDotenv(content) {
  const values = new Map();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) continue;

    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = normalized.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    values.set(key, value);
  }

  return values;
}

function parseArgs(argv) {
  const envFiles = [];
  const playwrightArgs = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--env-file") {
      const value = argv[index + 1];
      if (!value) throw new Error("--env-file requires a path");
      envFiles.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--env-file=")) {
      envFiles.push(arg.slice("--env-file=".length));
      continue;
    }
    playwrightArgs.push(arg);
  }

  return { envFiles, playwrightArgs };
}

function envFileCandidates(extraEnvFiles) {
  const fromEnv = process.env.STAGING_E2E_ENV_FILE
    ? process.env.STAGING_E2E_ENV_FILE.split(process.platform === "win32" ? ";" : ":").filter(Boolean)
    : [];

  return [
    ".env.staging.local",
    "infra/docker/.env.staging.local",
    ...fromEnv,
    ...extraEnvFiles
  ];
}

function loadEnvFiles(paths) {
  const initialEnv = new Set(Object.keys(process.env));
  const loaded = [];

  for (const path of paths) {
    const absolutePath = resolve(path);
    if (!existsSync(absolutePath)) continue;

    const values = parseDotenv(readFileSync(absolutePath, "utf8"));
    for (const [key, value] of values) {
      if (!initialEnv.has(key)) {
        process.env[key] = value;
      }
    }
    loaded.push(relative(process.cwd(), absolutePath) || absolutePath);
  }

  return loaded;
}

function ensureStagingEnv() {
  process.env.BASE_URL ||= defaultBaseUrl;
  process.env.PLAYWRIGHT_NO_WEB_SERVER ||= "1";
  process.env.PLAYWRIGHT_REPORT_NAME ||= "staging-local";

  if (!process.env.STAGING_ADMIN_TOKEN && process.env.VRATA_ADMIN_TOKEN) {
    process.env.STAGING_ADMIN_TOKEN = process.env.VRATA_ADMIN_TOKEN;
  }

  if (!process.env.STAGING_ADMIN_TOKEN) {
    throw new Error([
      "Missing STAGING_ADMIN_TOKEN for the full staging e2e suite.",
      "Create .env.staging.local with STAGING_ADMIN_TOKEN=... or run:",
      "  pnpm staging:e2e:pull-env -- --ssh <user>@158.160.10.234",
      "The file is gitignored and must not be committed."
    ].join("\n"));
  }
}

function runPlaywright(playwrightArgs) {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const args = ["exec", "playwright", "test", "--grep", "@staging", ...playwrightArgs];
  const hasWorkerOverride = playwrightArgs.some((arg) => arg === "--workers" || arg.startsWith("--workers="));
  if (process.env.GITHUB_ACTIONS !== "true" && !hasWorkerOverride) {
    args.push("--workers=1");
  }
  const child = spawn(command, args, {
    env: process.env,
    stdio: "inherit"
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

try {
  const { envFiles, playwrightArgs } = parseArgs(process.argv.slice(2));
  const loaded = loadEnvFiles(envFileCandidates(envFiles));
  ensureStagingEnv();

  if (loaded.length > 0) {
    console.log(`Loaded staging e2e env from: ${loaded.join(", ")}`);
  }
  console.log(`Running full staging e2e against ${process.env.BASE_URL}`);

  runPlaywright(playwrightArgs);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
