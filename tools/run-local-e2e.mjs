#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LOOPBACK = "127.0.0.1";
const MAX_PORT_ATTEMPTS = 3;

export function parsePlaywrightArgs(argv) {
  return argv.filter((arg) => arg !== "--");
}

export function withDefaultLocalWorkers(args, env = process.env) {
  const hasWorkerOverride = args.some((arg) => arg === "--workers" || arg.startsWith("--workers="));
  if (hasWorkerOverride) return args;
  return [...args, `--workers=${env.E2E_LOCAL_WORKERS ?? "2"}`];
}

export async function allocateFreePort(host = LOOPBACK) {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.once("error", rejectPort);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => rejectPort(new Error("e2e_port_allocation_failed")));
        return;
      }
      const port = address.port;
      server.close((error) => error ? rejectPort(error) : resolvePort(port));
    });
  });
}

export async function allocatePortSet() {
  const ports = new Set();
  while (ports.size < 3) {
    ports.add(await allocateFreePort());
  }
  const [apiPort, roomStatePort, remoteBrowserPort] = ports;
  return { apiPort, roomStatePort, remoteBrowserPort };
}

function readJson(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcess(entry, signal) {
  const pid = Number(entry?.pid);
  const pgid = Number(entry?.pgid);
  if (!isAlive(pid)) return;
  try {
    if (process.platform !== "win32" && Number.isInteger(pgid) && pgid > 0) {
      process.kill(-pgid, signal);
    } else {
      process.kill(pid, signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function cleanupManifest(manifestPath, runId, graceMs = 2000) {
  const manifest = readJson(manifestPath);
  if (!manifest || manifest.runId !== runId || !Array.isArray(manifest.services)) return;

  for (const service of manifest.services) signalProcess(service, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && manifest.services.some((service) => isAlive(Number(service.pid)))) {
    await sleep(50);
  }
  for (const service of manifest.services) signalProcess(service, "SIGKILL");
}

export function shouldRetryPortAllocation({ reuse, code, startup, attempt, maxAttempts = MAX_PORT_ATTEMPTS }) {
  return !reuse
    && code !== 0
    && startup?.stage === "error"
    && startup?.error?.code === "port_in_use"
    && attempt < maxAttempts;
}

export async function waitForHealth(baseUrl, timeoutMs = 10000) {
  const healthUrl = new URL("/health", baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(healthUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`e2e_reuse_health_failed:${response.status}`);
  } catch (error) {
    throw new Error(`e2e_reuse_health_unreachable:${healthUrl.origin}`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

export function createRunDirectory() {
  const runDir = mkdtempSync(join(tmpdir(), "vrata-e2e-"));
  chmodSync(runDir, 0o700);
  for (const child of ["logs", "artifacts", "scene-bundles", "documents"]) {
    mkdirSync(join(runDir, child), { recursive: true, mode: 0o700 });
  }
  return runDir;
}

function runPlaywright(args, env) {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawn(command, ["exec", "playwright", "test", ...args], {
    detached: process.platform !== "win32",
    env,
    stdio: "inherit"
  });
  let receivedSignal = null;

  const forwardSignal = (signal) => {
    receivedSignal = signal;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return new Promise((resolveChild) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      resolveChild(result);
    };
    child.once("error", () => finish({ code: 1, signal: receivedSignal }));
    child.once("exit", (code, signal) => finish({ code: code ?? 1, signal: receivedSignal ?? signal }));
  });
}

export function localRunEnvironment(runDir, runId, ports, env = process.env) {
  const baseURL = `http://${LOOPBACK}:${ports.apiPort}`;
  return {
    ...env,
    BASE_URL: baseURL,
    E2E_API_PORT: String(ports.apiPort),
    E2E_ROOM_STATE_PORT: String(ports.roomStatePort),
    E2E_REMOTE_BROWSER_PORT: String(ports.remoteBrowserPort),
    E2E_REUSE_EXISTING_SERVER: "0",
    E2E_RUN_ID: runId,
    E2E_RUN_DIR: runDir,
    E2E_LOG_DIR: join(runDir, "logs"),
    E2E_ARTIFACT_ROOT: join(runDir, "artifacts"),
    E2E_STARTUP_STATUS_PATH: join(runDir, "startup-status.json"),
    E2E_PID_MANIFEST_PATH: join(runDir, "pids.json"),
    SCENE_BUNDLE_LOCAL_UPLOAD_ROOT: join(runDir, "scene-bundles"),
    DOCUMENT_LOCAL_UPLOAD_ROOT: join(runDir, "documents")
  };
}

export function reuseEnvironment(runDir, env = process.env) {
  return {
    ...env,
    PLAYWRIGHT_NO_WEB_SERVER: "1",
    E2E_ARTIFACT_ROOT: join(runDir, "artifacts")
  };
}

export async function runLocalE2E(argv, options = {}) {
  const env = options.env ?? process.env;
  const args = withDefaultLocalWorkers(parsePlaywrightArgs(argv), env);
  const reuse = env.E2E_REUSE_EXISTING_SERVER === "1";
  let lastCode = 1;

  for (let attempt = 1; attempt <= MAX_PORT_ATTEMPTS; attempt += 1) {
    const runDir = createRunDirectory();
    const runId = `${Date.now()}-${process.pid}-${attempt}`;
    let childEnv;

    if (reuse) {
      if (!env.BASE_URL) {
        console.error("E2E_REUSE_EXISTING_SERVER=1 requires an explicit BASE_URL.");
        rmSync(runDir, { recursive: true, force: true });
        return 1;
      }
      try {
        await waitForHealth(env.BASE_URL);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        rmSync(runDir, { recursive: true, force: true });
        return 1;
      }
      console.log(`Local e2e reuse mode: ${env.BASE_URL}; server lifecycle remains external.`);
      childEnv = reuseEnvironment(runDir, env);
    } else {
      const ports = await allocatePortSet();
      childEnv = localRunEnvironment(runDir, runId, ports, env);
      console.log(`Local e2e run ${runId}: api=${ports.apiPort} room-state=${ports.roomStatePort} remote-browser=${ports.remoteBrowserPort}`);
    }

    const result = await runPlaywright(args, childEnv);
    lastCode = result.code;
    if (!reuse) {
      await cleanupManifest(childEnv.E2E_PID_MANIFEST_PATH, runId);
    }

    const startup = readJson(childEnv.E2E_STARTUP_STATUS_PATH);
    const retryPortAllocation = shouldRetryPortAllocation({
      reuse,
      code: result.code,
      startup,
      attempt
    });

    if (retryPortAllocation) {
      console.warn(`Local e2e port collision; retrying with a new port set (${attempt + 1}/${MAX_PORT_ATTEMPTS}).`);
      rmSync(runDir, { recursive: true, force: true });
      continue;
    }

    if (result.code === 0 && !result.signal) {
      try {
        rmSync(runDir, { recursive: true, force: true });
      } catch (error) {
        console.warn(`Local e2e passed but temporary cleanup failed: ${runDir}`);
        console.warn(error instanceof Error ? error.message : String(error));
      }
      return 0;
    }

    console.error(`Local e2e diagnostics preserved at: ${runDir}`);
    if (result.signal === "SIGINT") return 130;
    if (result.signal === "SIGTERM") return 143;
    return result.code || 1;
  }

  return lastCode;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runLocalE2E(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
}
