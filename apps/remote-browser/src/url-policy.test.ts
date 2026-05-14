import assert from "node:assert/strict";
import test from "node:test";

import { isPrivateAddress, parseAllowedOrigins, validateRemoteBrowserUrl } from "./url-policy.js";

test("remote browser URL policy allows only configured origins", async () => {
  const policy = { allowedOrigins: ["http://localhost:4000"], allowPrivateAllowedOrigins: true };
  assert.equal((await validateRemoteBrowserUrl("http://localhost:4000/page", policy)).allowed, true);
  assert.equal((await validateRemoteBrowserUrl("https://not-example.com/page", policy)).errorCode, "origin_not_allowed");
  assert.equal((await validateRemoteBrowserUrl("file:///etc/passwd", policy)).errorCode, "scheme_not_allowed");
});

test("remote browser URL policy blocks private addresses", async () => {
  const policy = { allowedOrigins: ["http://127.0.0.1:4000", "http://169.254.169.254"], allowPrivateAllowedOrigins: false };
  assert.equal((await validateRemoteBrowserUrl("http://127.0.0.1:4000/remote-browser-demo.html", policy)).errorCode, "private_address");
  assert.equal((await validateRemoteBrowserUrl("http://169.254.169.254/latest/meta-data", policy)).errorCode, "private_address");
});

test("remote browser URL policy permits local explicit dev origins", async () => {
  const policy = { allowedOrigins: ["http://localhost:4000", "http://127.0.0.1:4000"], allowPrivateAllowedOrigins: true };
  assert.equal((await validateRemoteBrowserUrl("http://localhost:4000/remote-browser-demo.html", policy)).allowed, true);
  assert.equal((await validateRemoteBrowserUrl("http://127.0.0.1:4000/remote-browser-demo.html", policy)).allowed, true);
});

test("private address helper covers baseline blocked ranges", () => {
  assert.equal(isPrivateAddress("10.1.2.3"), true);
  assert.equal(isPrivateAddress("172.16.0.10"), true);
  assert.equal(isPrivateAddress("192.168.1.3"), true);
  assert.equal(isPrivateAddress("169.254.169.254"), true);
  assert.equal(isPrivateAddress("100.64.0.1"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
});

test("allowed origin parser normalizes URL origins", () => {
  assert.deepEqual(parseAllowedOrigins("https://example.com/a,http://localhost:4000/test"), ["https://example.com", "http://localhost:4000"]);
});
