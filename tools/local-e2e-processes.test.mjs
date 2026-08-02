import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  allocateFreePort,
  allocatePortSet,
  createRunDirectory,
  localRunEnvironment,
  parsePlaywrightArgs,
  reuseEnvironment,
  runLocalE2E,
  shouldRetryPortAllocation,
  withDefaultLocalWorkers
} from "./run-local-e2e.mjs";
import { assertCleanEnvironment, superviseServices } from "./start-e2e-services.mjs";

const fixturePath = resolve("tools/fixtures/e2e-child.mjs");

function testEnvironment(runDir, runId, ports) {
  return {
    ...localRunEnvironment(runDir, runId, ports, {}),
    API_PORT: String(ports.apiPort),
    ROOM_STATE_PORT: String(ports.roomStatePort),
    REMOTE_BROWSER_PORT: String(ports.remoteBrowserPort)
  };
}

function fixtureDefinitions(ports, apiExitAfterMs = 0) {
  return {
    roomState: { name: "room-state", script: fixturePath, args: [String(ports.roomStatePort)] },
    remoteBrowser: { name: "remote-browser", script: fixturePath, args: [String(ports.remoteBrowserPort)] },
    api: { name: "api", script: fixturePath, args: [String(ports.apiPort), String(apiExitAfterMs)] }
  };
}

test("local e2e argument parser preserves Playwright arguments", () => {
  assert.deepEqual(
    parsePlaywrightArgs(["--", "tests/e2e/runtime.spec.ts", "--grep", "seat", "--workers=1"]),
    ["tests/e2e/runtime.spec.ts", "--grep", "seat", "--workers=1"]
  );
});

test("local e2e defaults to two workers and preserves explicit overrides", () => {
  assert.deepEqual(withDefaultLocalWorkers(["tests/e2e/runtime.spec.ts"], {}), [
    "tests/e2e/runtime.spec.ts",
    "--workers=2"
  ]);
  assert.deepEqual(withDefaultLocalWorkers(["--workers=1"], {}), ["--workers=1"]);
  assert.deepEqual(withDefaultLocalWorkers([], { E2E_LOCAL_WORKERS: "3" }), ["--workers=3"]);
});

test("local e2e port allocator returns three distinct loopback ports", async () => {
  const ports = await allocatePortSet();
  assert.equal(new Set(Object.values(ports)).size, 3);
  for (const port of Object.values(ports)) {
    assert.equal(Number.isInteger(port), true);
    assert.equal(port > 0, true);
  }
});

test("local e2e run environment isolates ports, uploads, logs, and artifacts", async () => {
  const runDir = createRunDirectory();
  try {
    assert.equal(statSync(runDir).mode & 0o777, 0o700);
    const ports = await allocatePortSet();
    const env = localRunEnvironment(runDir, "test-run", ports, { SENTINEL: "kept" });
    assert.equal(env.BASE_URL, `http://127.0.0.1:${ports.apiPort}`);
    assert.equal(env.SENTINEL, "kept");
    assert.equal(env.SCENE_BUNDLE_LOCAL_UPLOAD_ROOT.startsWith(runDir), true);
    assert.equal(env.DOCUMENT_LOCAL_UPLOAD_ROOT.startsWith(runDir), true);
    assert.equal(env.E2E_LOG_DIR.startsWith(runDir), true);
    assert.equal(env.E2E_ARTIFACT_ROOT.startsWith(runDir), true);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("port allocation retry is limited to startup port conflicts", () => {
  assert.equal(shouldRetryPortAllocation({
    reuse: false,
    code: 1,
    startup: { stage: "error", error: { code: "port_in_use" } },
    attempt: 1
  }), true);
  assert.equal(shouldRetryPortAllocation({
    reuse: false,
    code: 1,
    startup: { stage: "ready" },
    attempt: 1
  }), false);
  assert.equal(shouldRetryPortAllocation({
    reuse: false,
    code: 1,
    startup: { stage: "error", error: { code: "service_start_failed" } },
    attempt: 1
  }), false);
});

test("reuse mode requires an explicit base URL before Playwright starts", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const code = await runLocalE2E([], { env: { E2E_REUSE_EXISTING_SERVER: "1" } });
    assert.equal(code, 1);
  } finally {
    console.error = originalError;
  }
});

test("reuse mode disables the local web server and keeps external ownership", () => {
  const runDir = createRunDirectory();
  try {
    const env = reuseEnvironment(runDir, {
      BASE_URL: "http://127.0.0.1:4999",
      E2E_REUSE_EXISTING_SERVER: "1"
    });
    assert.equal(env.PLAYWRIGHT_NO_WEB_SERVER, "1");
    assert.equal(env.BASE_URL, "http://127.0.0.1:4999");
    assert.equal(env.E2E_API_PORT, undefined);
    assert.equal(env.E2E_ARTIFACT_ROOT.startsWith(runDir), true);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("supervisor reaches ready state and cleans all fixture services", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "vrata-e2e-supervisor-test-"));
  const ports = await allocatePortSet();
  const runId = "supervisor-clean";
  const env = testEnvironment(runDir, runId, ports);
  let stop;
  const terminationPromise = new Promise((resolveStop) => {
    stop = resolveStop;
  });
  try {
    const code = await superviseServices({
      env,
      definitions: fixtureDefinitions(ports),
      graceMs: 500,
      terminationPromise,
      onReady: () => stop({ type: "signal", signal: "SIGTERM" })
    });
    assert.equal(code, 0);
    const status = JSON.parse(readFileSync(env.E2E_STARTUP_STATUS_PATH, "utf8"));
    assert.equal(status.stage, "ready");
    assert.equal(existsSync(env.E2E_PID_MANIFEST_PATH), false);
    await assertCleanEnvironment(env);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("supervisor fails fast and cleans siblings when API exits", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "vrata-e2e-supervisor-failure-"));
  const ports = await allocatePortSet();
  const runId = "supervisor-failure";
  const env = testEnvironment(runDir, runId, ports);
  try {
    const code = await superviseServices({
      env,
      definitions: fixtureDefinitions(ports, 100),
      graceMs: 500
    });
    assert.equal(code, 1);
    assert.equal(existsSync(env.E2E_PID_MANIFEST_PATH), false);
    await assertCleanEnvironment(env);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("supervisor reports an occupied startup port without spawning services", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "vrata-e2e-supervisor-port-"));
  const ports = await allocatePortSet();
  const env = testEnvironment(runDir, "supervisor-port", ports);
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(ports.apiPort, "127.0.0.1", resolveListen);
  });
  try {
    const code = await superviseServices({ env, definitions: fixtureDefinitions(ports), graceMs: 100 });
    assert.equal(code, 75);
    const status = JSON.parse(readFileSync(env.E2E_STARTUP_STATUS_PATH, "utf8"));
    assert.equal(status.stage, "error");
    assert.equal(status.error.code, "port_in_use");
    assert.equal(existsSync(env.E2E_PID_MANIFEST_PATH), false);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("allocateFreePort avoids a currently occupied listener", async () => {
  const occupied = await allocateFreePort();
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(occupied, "127.0.0.1", resolveListen);
  });
  try {
    const allocated = await allocateFreePort();
    assert.notEqual(allocated, occupied);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});
