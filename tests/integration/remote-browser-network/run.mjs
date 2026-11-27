import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { runMedia } from "./media.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));
const certificates = mkdtempSync(join(tmpdir(), "vrata-network-fixture-"));
const project = `vrata-network-${process.pid}`;
const environment = {
  ...process.env,
  NETWORK_FIXTURE_DIR: directory,
  NETWORK_FIXTURE_CERTS: certificates,
  REMOTE_BROWSER_IMAGE_REPO: process.env.NETWORK_FIXTURE_IMAGE ?? project,
  IMAGE_TAG: "integration",
  COMPOSE_PARALLEL_LIMIT: process.env.COMPOSE_PARALLEL_LIMIT ?? "4",
  REMOTE_BROWSER_PUBLIC_HTTPS_DENY_CIDRS: "11.53.49.11/32"
};
const composeDirectory = fileURLToPath(new URL("../../../infra/docker/", import.meta.url));
const args = ["compose", "-p", project, "--project-directory", composeDirectory, "-f", join(directory, "compose.yml"),
  "--profile", "public-https-network"];
const compose = (...command) => execFileSync("docker", [...args, ...command], {
  env: environment, encoding: "utf8", timeout: command[0] === "up" || command[0] === "down" ? 300_000 : 60_000
}).trim();
const children = new Set();

function processPeer(...command) {
  const child = spawn("docker", [...args, ...command], { env: environment, stdio: ["pipe", "pipe", "inherit"] });
  children.add(child);
  child.stdin.on("error", () => {});
  const closed = new Promise(resolve => child.once("close", resolve));
  const reader = createInterface({ input: child.stdout });
  const messages = reader[Symbol.asyncIterator]();
  return {
    async next() {
      let timer;
      try {
        const message = await Promise.race([
          messages.next(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("fixture peer did not respond")), 20_000); })
        ]);
        assert.equal(message.done, false, `${command[0]} finished before reporting`);
        return JSON.parse(message.value);
      } finally {
        clearTimeout(timer);
      }
    },
    send: line => child.stdin.write(`${line}\n`),
    async close() {
      child.stdin.end();
      assert.equal(await closed, 0);
      children.delete(child);
    }
  };
}
function openssl(...command) {
  execFileSync("openssl", command, { cwd: certificates, stdio: "ignore", timeout: 10_000 });
}
function observations(service) {
  const log = compose("exec", "-T", `origin-${service}`, "cat", "/tmp/observations.jsonl");
  return log ? log.split("\n").map(line => JSON.parse(line)) : [];
}
async function startBrowser(path) {
  const worker = processPeer("run", "--rm", "--no-deps", "-T", "public-https-chromium", "node", "/fixture/browser.mjs", path);
  const { version } = await worker.next();
  assert.match(version, /^\d+\./);
  return {
    version,
    async run(command) {
      worker.send(command);
      assert.deepEqual(await worker.next(), { ok: command });
    },
    close: worker.close
  };
}
async function startLease() {
  const control = processPeer("exec", "-T", "public-https-gateway", "node", "/fixture/lease.mjs");
  const { path } = await control.next();
  assert.match(path, /\/[a-f0-9]{32}\.sock$/);
  return {
    ...control, path,
    async renew(duration) {
      control.send(String(duration));
      assert.deepEqual(await control.next(), { renewed: true });
    }
  };
}

async function startLeasedBrowser(lease) {
  // Container creation and browser startup are outside the behavior under
  // observation. Keep their real short grant live on a slow CI worker.
  let renewal = Promise.resolve();
  const timer = setInterval(() => {
    renewal = renewal.then(() => lease.renew(9500));
    void renewal.catch(() => {});
  }, 2000);
  try {
    return await startBrowser(lease.path);
  } finally {
    clearInterval(timer);
    await renewal;
    await lease.renew(9500);
  }
}
async function untilClose(expected, startedAt, budgetMs) {
  let closed = [];
  while (Date.now() - startedAt <= budgetMs + 750) {
    closed = observations("allowed").filter(item => item.event === "stream-closed");
    if (closed.length >= expected) break;
    await delay(100);
  }
  assert.equal(closed.length, expected);
  const elapsed = closed.at(-1).time - startedAt;
  assert.ok(elapsed <= budgetMs, `observer saw the stream close after ${elapsed} ms`);
  return elapsed;
}

async function runNetwork() {
  const gatewayAddress = compose("exec", "-T", "public-https-gateway", "node", "-p",
    "Object.values(require('node:os').networkInterfaces()).flat().find(address => address.family === 'IPv4' && !address.internal).address");
  // The observers are independent of the proxy. Exercise the real listeners first
  // from a trusted fixture process on their network and record the baseline.
  compose("exec", "-T", "public-https-gateway", "node", "-e", `
    const https = require("node:https"), http = require("node:http"), dgram = require("node:dgram");
    for (const [ip, name] of [["11", "denied"], ["13", "channel"], ["14", "mixed4"]]) {
      https.get({ hostname: "11.53.49." + ip, servername: name + ".test", path: "/control" }, res => {
        if (res.statusCode !== 200) process.exitCode = 1;
        res.resume();
      }).on("error", () => { process.exitCode = 1 });
    }
    http.get("http://11.53.49.13/control", res => {
      if (res.statusCode !== 200) process.exitCode = 1;
      res.resume();
    }).on("error", () => { process.exitCode = 1; });
    const udp = dgram.createSocket("udp4");
    udp.send(Buffer.from("controlled datagram"), 3478, "11.53.49.13", error => {
      if (error) process.exitCode = 1;
      udp.close();
    });
  `);
  const deniedBaseline = observations("denied");
  const channelBaseline = observations("channel");
  const dnsBaseline = observations("dns-candidate");
  assert.deepEqual(deniedBaseline.map(item => item.event), ["tcp", "http"]);
  assert.deepEqual(channelBaseline.map(item => item.event).sort(), ["http", "http", "plaintext", "tcp", "udp"]);
  assert.deepEqual(dnsBaseline.map(item => item.event), ["tcp", "http"]);

  const unopened = await startBrowser("/var/lib/vrata-public-https/data/00000000000000000000000000000000.sock");
  await unopened.run("closed");
  await unopened.close();
  assert.deepEqual(observations("allowed"), []);

  let lease = await startLease();
  let worker = await startLeasedBrowser(lease);
  const version = worker.version;
  await worker.run("content");
  await lease.renew(9500);
  await worker.run("channels");
  await worker.run("before");
  compose("exec", "-T", "fixture-dns", "touch", "/tmp/dns-changed");
  await worker.run("after");
  const allowed = observations("allowed");
  for (const path of ["/redirect", "/document", "/resource.svg", "/redirect-denied", "/redirect-http", "/before"]) {
    assert.ok(allowed.some(item => item.path === path), path);
  }
  assert.ok(!allowed.some(item => ["/hidden", "/after"].includes(item.path)));
  const acceptedConnections = allowed.filter(item => item.event === "tcp");
  assert.ok(acceptedConnections.length > 0);
  assert.ok(acceptedConnections.every(item => item.from === gatewayAddress));
  assert.deepEqual(observations("denied"), deniedBaseline);
  assert.deepEqual(observations("channel"), channelBaseline);
  assert.deepEqual(observations("dns-candidate"), dnsBaseline);
  const invalid = observations("certificate");
  assert.ok(invalid.some(item => item.event === "tcp"));
  assert.ok(invalid.every(item => item.event === "tcp"));

  await worker.run("hold");
  let stoppedAt = Date.now();
  lease.send("revoke");
  assert.deepEqual(await lease.next(), { revoked: true });
  const revokeMs = await untilClose(1, stoppedAt, 1500);
  await worker.run("alive");
  await worker.run("closed");
  await worker.close();
  await lease.close();

  lease = await startLease();
  worker = await startLeasedBrowser(lease);
  await worker.run("hold");
  stoppedAt = Date.now();
  await lease.renew(1800);
  const expiryMs = await untilClose(2, stoppedAt, 2300);
  lease.send("9500");
  assert.deepEqual(await lease.next(), { renewed: false });
  await worker.run("alive");
  await worker.run("closed");
  await worker.close();
  await lease.close();

  lease = await startLease();
  worker = await startLeasedBrowser(lease);
  await worker.run("hold");
  stoppedAt = Date.now();
  compose("stop", "-t", "1", "public-https-gateway");
  const outageMs = await untilClose(3, stoppedAt, 2300);
  await worker.run("alive");
  await worker.run("closed");
  await worker.close();
  assert.ok(!observations("allowed").some(item => item.path === "/should-not-arrive"));
  console.log(JSON.stringify({
    chromium: version, deniedNewConnections: 0, unsupportedNewConnections: 0, invalidTlsHttpRequests: 0,
    connectionRevokedMs: revokeMs, connectionExpiredMs: expiryMs, connectionLostGatewayMs: outageMs
  }));
}

let failed = false;
try {
  chmodSync(certificates, 0o755);
  const domains = ["allowed", "changing", "denied", "channel", "mixed4", "mixed6", "uncertain"];
  const alternativeNames = domains.map(name => `DNS:${name}.test`).join(",");
  openssl("req", "-new", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "2",
    "-subj", "/CN=Isolated fixture root", "-addext", "basicConstraints=critical,CA:true,pathlen:0",
    "-keyout", "ca.key", "-out", "ca.pem");
  openssl("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-subj", "/CN=Isolated fixture",
    "-addext", `subjectAltName=${alternativeNames}`, "-keyout", "site.key", "-out", "site.csr");
  openssl("x509", "-req", "-in", "site.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
    "-copy_extensions", "copy", "-days", "2", "-out", "site.pem");
  // Test leaf only, on a local internal network; the CA signing key stays private.
  rmSync(join(certificates, "ca.key"));
  chmodSync(join(certificates, "site.key"), 0o644);
  if (!process.env.NETWORK_FIXTURE_IMAGE) {
    execFileSync("docker", [...args, "build", "public-https-gateway"], { env: environment, stdio: "inherit", timeout: 600_000 });
  }
  const origins = ["origin-allowed", "origin-denied", "origin-certificate"];
  if (!process.argv.includes("--media-only")) origins.push("origin-channel", "origin-dns-candidate");
  compose("up", "-d", "--wait", "--wait-timeout", "30", "fixture-dns", ...origins, "public-https-gateway");
  if (!process.argv.includes("--media-only")) {
    await runNetwork();
    if (!process.argv.includes("--network-only")) compose("up", "-d", "--wait", "public-https-gateway");
  }
  if (!process.argv.includes("--network-only")) await runMedia({ compose, processPeer, observations });
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : "fixture failed");
  throw error;
} finally {
  for (const child of children) {
    child.stdin.end();
    child.kill();
  }
  try {
    compose("down", "--volumes", "--remove-orphans", "--timeout", "1");
  } catch (error) {
    if (!failed) throw error;
    console.error("fixture cleanup failed");
  } finally {
    rmSync(certificates, { recursive: true, force: true });
  }
}
