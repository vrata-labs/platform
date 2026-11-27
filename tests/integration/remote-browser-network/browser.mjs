import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { createInterface } from "node:readline";
import { openIsolatedChromium } from "/app/apps/remote-browser/dist/public-https-chromium.js";

assert.deepEqual(Object.keys(networkInterfaces()), ["lo"]);
assert.equal(existsSync("/var/lib/vrata-public-https/control/gateway.sock"), false);
const browser = await openIsolatedChromium({ socketPath: process.argv[2], signal: new AbortController().signal });
browser.context.setDefaultTimeout(3500);
const page = await browser.context.newPage();

async function attempt(url, target = page) {
  try {
    return (await target.goto(url, { waitUntil: "domcontentloaded" }))?.status() ?? 0;
  } catch (error) {
    if (/net::ERR_/.test(error.message)) return 0;
    throw error;
  }
}

async function content() {
  assert.equal(await attempt("https://allowed.test/redirect"), 200);
  assert.equal(await page.title(), "Controlled document");
  assert.equal(await page.locator("#resource").evaluate(image => image.decode().then(() => image.naturalWidth)), 2);
  const popup = page.waitForEvent("popup");
  await page.locator("#popup").click();
  const child = await popup;
  await child.close();
  assert.equal(await attempt("https://allowed.test/redirect-denied"), 403);
  assert.equal(await attempt("https://denied.test/hidden"), 403);
  assert.equal(await attempt("https://11.53.49.11/hidden"), 403);
  assert.equal(await attempt("https://mixed4.test/hidden"), 403);
  assert.equal(await attempt("https://mixed6.test/hidden"), 403);
  assert.equal(await attempt("https://uncertain.test/hidden"), 502);
  assert.equal(await attempt("https://unknown.test/hidden"), 502);
  assert.equal(await attempt("https://badcert.test/no-application-request"), 502);
}

async function channels() {
  for (const url of ["http://channel.test/plaintext", "https://allowed.test/redirect-http"]) {
    const rejected = await browser.context.newPage();
    try {
      assert.ok([0, 403].includes(await attempt(url, rejected)));
    } finally {
      await rejected.close();
    }
  }
  assert.equal(await attempt("https://allowed.test/document"), 200);
  assert.equal(await page.evaluate(() => new Promise(resolve => {
    const socket = new WebSocket("wss://channel.test/ordinary-websocket");
    socket.onopen = () => { socket.close(); resolve("connected"); };
    socket.onerror = () => resolve("rejected");
  })), "rejected");
  await page.evaluate(async () => {
    const connection = new RTCPeerConnection({ iceServers: [{ urls: "stun:11.53.49.13:3478" }] });
    connection.createDataChannel("network-fixture");
    await connection.setLocalDescription(await connection.createOffer());
    await new Promise(resolve => setTimeout(resolve, 750));
    connection.close();
  });
  await new Promise((resolve, reject) => {
    const socket = connect({ host: "11.53.49.13", port: 443, timeout: 1000 });
    socket.once("error", resolve);
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("worker has a direct route"));
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("expected the network-none route to fail immediately"));
    });
  });
}

const commands = {
  content, channels,
  before: async () => assert.equal(await attempt("https://changing.test/before"), 200),
  after: async () => assert.equal(await attempt("https://changing.test/after"), 403),
  hold: async () => {
    assert.equal(await attempt("https://allowed.test/document"), 200);
    assert.equal(await page.evaluate(async () => (await fetch("/hold")).status), 200);
  },
  alive: async () => assert.equal(await page.evaluate(() => 1), 1),
  closed: async () => {
    assert.notEqual(await attempt("https://allowed.test/should-not-arrive"), 200);
  }
};

try {
  console.log(JSON.stringify({ version: browser.context.browser().version() }));
  for await (const command of createInterface({ input: process.stdin })) {
    await commands[command]();
    console.log(JSON.stringify({ ok: command }));
  }
} finally {
  await browser.close();
}
