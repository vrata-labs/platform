#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LOOPBACK = "127.0.0.1";
const STARTUP_TIMEOUT_MS = 60000;
const SHUTDOWN_GRACE_MS = 5000;

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function writeJson(path, value) {
  if (!path) return;
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
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

function servicePorts(env) {
  return {
    api: Number(env.E2E_API_PORT ?? env.API_PORT ?? 4000),
    roomState: Number(env.E2E_ROOM_STATE_PORT ?? env.ROOM_STATE_PORT ?? 2567),
    remoteBrowser: Number(env.E2E_REMOTE_BROWSER_PORT ?? env.REMOTE_BROWSER_PORT ?? 4010)
  };
}

async function assertPortFree(port) {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => rejectPort(error));
    server.listen(port, LOOPBACK, () => server.close((error) => error ? rejectPort(error) : resolvePort()));
  });
}

async function isPortListening(port) {
  return new Promise((resolvePort) => {
    const socket = connect({ host: LOOPBACK, port });
    socket.unref();
    socket.setTimeout(300);
    socket.once("connect", () => {
      socket.destroy();
      resolvePort(true);
    });
    const onClosed = () => {
      socket.destroy();
      resolvePort(false);
    };
    socket.once("error", onClosed);
    socket.once("timeout", onClosed);
  });
}

async function waitForHealth(url, child, timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(`service_exited_before_ready:${url}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      // Retry until the service startup deadline.
    }
    await sleep(200);
  }
  throw new Error(`service_health_timeout:${url}`);
}

function defaultServiceDefinitions() {
  return {
    roomState: { name: "room-state", script: "apps/room-state/dist/index.js" },
    remoteBrowser: { name: "remote-browser", script: "apps/remote-browser/dist/index.js" },
    api: { name: "api", script: "apps/api/dist/index.js" }
  };
}

function signalService(service, signal) {
  if (!service?.child || !isAlive(service.child.pid)) return;
  try {
    if (process.platform !== "win32" && service.pgid) process.kill(-service.pgid, signal);
    else service.child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function shutdownServices(services, graceMs = SHUTDOWN_GRACE_MS) {
  for (const service of services) signalService(service, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && services.some((service) => isAlive(service.child.pid))) {
    await sleep(50);
  }
  for (const service of services) signalService(service, "SIGKILL");
  await Promise.all(services.map((service) => new Promise((resolveExit) => {
    if (service.child.exitCode !== null || service.child.signalCode) {
      resolveExit();
      return;
    }
    service.child.once("exit", resolveExit);
    setTimeout(resolveExit, 1000).unref();
  })));
  for (const service of services) {
    try {
      closeSync(service.logFd);
    } catch {
      // The descriptor may already be closed after a spawn failure.
    }
  }
}

export async function superviseServices(options = {}) {
  const env = options.env ?? process.env;
  const runId = env.E2E_RUN_ID ?? `standalone-${process.pid}`;
  const runDir = resolve(env.E2E_RUN_DIR ?? join(tmpdir(), `vrata-e2e-services-${process.pid}`));
  const logDir = resolve(env.E2E_LOG_DIR ?? join(runDir, "logs"));
  const statusPath = resolve(env.E2E_STARTUP_STATUS_PATH ?? join(runDir, "startup-status.json"));
  const manifestPath = resolve(env.E2E_PID_MANIFEST_PATH ?? join(runDir, "pids.json"));
  const ports = servicePorts(env);
  const definitions = options.definitions ?? defaultServiceDefinitions();
  const services = [];
  let shuttingDown = false;
  let resolveTermination;
  const termination = new Promise((resolveTerm) => {
    resolveTermination = resolveTerm;
  });
  if (options.terminationPromise) {
    options.terminationPromise.then(resolveTermination);
  }

  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  writeJson(statusPath, { runId, stage: "starting", ports });

  try {
    await Promise.all(Object.values(ports).map(assertPortFree));
  } catch (error) {
    writeJson(statusPath, { runId, stage: "error", error: { code: "port_in_use", message: String(error?.message ?? error) }, ports });
    return 75;
  }

  const updateManifest = () => writeJson(manifestPath, {
    runId,
    services: services.map((service) => ({ name: service.name, pid: service.child.pid, pgid: service.pgid }))
  });

  const spawnService = (definition) => {
    const logFd = openSync(join(logDir, `${definition.name}.log`), "a", 0o600);
    const child = spawn(process.execPath, [definition.script, ...(definition.args ?? [])], {
      cwd: options.cwd ?? process.cwd(),
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", logFd, logFd]
    });
    const service = { ...definition, child, pgid: process.platform === "win32" ? null : child.pid, logFd };
    services.push(service);
    updateManifest();
    child.once("error", (error) => resolveTermination({ type: "service-error", service, error }));
    child.once("exit", (code, signal) => {
      if (!shuttingDown) resolveTermination({ type: "service-exit", service, code, signal });
    });
    return service;
  };

  const onSignal = (signal) => resolveTermination({ type: "signal", signal });
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    const roomState = spawnService(definitions.roomState);
    const remoteBrowser = spawnService(definitions.remoteBrowser);
    await Promise.race([
      Promise.all([
        waitForHealth(`http://${LOOPBACK}:${ports.roomState}/health/ready`, roomState.child),
        waitForHealth(`http://${LOOPBACK}:${ports.remoteBrowser}/health/ready`, remoteBrowser.child)
      ]),
      termination.then((event) => Promise.reject(new Error(`service_start_failed:${event.type}`)))
    ]);

    const api = spawnService(definitions.api);
    await Promise.race([
      waitForHealth(`http://${LOOPBACK}:${ports.api}/health`, api.child),
      termination.then((event) => Promise.reject(new Error(`service_start_failed:${event.type}`)))
    ]);
    writeJson(statusPath, { runId, stage: "ready", ports });
    if (options.onReady) await options.onReady({ ports, services });

    const event = await termination;
    shuttingDown = true;
    await shutdownServices(services, options.graceMs);
    rmSync(manifestPath, { force: true });
    return event.type === "signal" ? 0 : 1;
  } catch (error) {
    shuttingDown = true;
    const currentStatus = readJson(statusPath);
    if (currentStatus?.stage !== "error") {
      writeJson(statusPath, { runId, stage: "error", error: { code: "service_start_failed", message: String(error?.message ?? error) }, ports });
    }
    await shutdownServices(services, options.graceMs);
    rmSync(manifestPath, { force: true });
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

export async function assertCleanEnvironment(env = process.env) {
  const manifestPath = env.E2E_PID_MANIFEST_PATH;
  const manifest = readJson(manifestPath);
  if (manifest?.services?.some((service) => isAlive(Number(service.pid)))) {
    throw new Error(`e2e_orphan_processes:${manifest.services.filter((service) => isAlive(Number(service.pid))).map((service) => service.name).join(",")}`);
  }
  const ports = servicePorts(env);
  const listening = [];
  for (const [name, port] of Object.entries(ports)) {
    if (await isPortListening(port)) listening.push(`${name}:${port}`);
  }
  if (listening.length > 0) throw new Error(`e2e_orphan_listeners:${listening.join(",")}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const assertOnly = process.argv.includes("--assert-clean");
  const action = assertOnly ? assertCleanEnvironment() : superviseServices();
  action
    .then((code) => {
      process.exitCode = typeof code === "number" ? code : 0;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
}
