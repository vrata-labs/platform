import assert from "node:assert/strict";
import test from "node:test";

import {
  createPublicHttpsAddressPolicy, isPrivateAddress, isRemoteBrowserOriginAllowed, parseAllowedOrigins,
  parsePublicHttpsTarget, validateRemoteBrowserUrl
} from "./url-policy.js";

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

test("remote browser URL policy supports wildcard subdomain origins", () => {
  const allowedOrigins = parseAllowedOrigins("https://rutube.ru,https://*.rutube.ru,https://*.rtbcdn.ru");

  assert.equal(isRemoteBrowserOriginAllowed("https://rutube.ru", allowedOrigins), true);
  assert.equal(isRemoteBrowserOriginAllowed("https://goya.rutube.ru", allowedOrigins), true);
  assert.equal(isRemoteBrowserOriginAllowed("https://static.rtbcdn.ru", allowedOrigins), true);
  assert.equal(isRemoteBrowserOriginAllowed("https://rtbcdn.ru", allowedOrigins), false);
  assert.equal(isRemoteBrowserOriginAllowed("http://static.rtbcdn.ru", allowedOrigins), false);
  assert.equal(isRemoteBrowserOriginAllowed("https://evilrutube.ru", allowedOrigins), false);
});

test("public HTTPS requires the HTTPS default port without credentials or a local host", () => {
  assert.deepEqual(parsePublicHttpsTarget("https://public.test:443/web?q=test"), {
    hostname: "public.test", authority: "public.test"
  });
  assert.deepEqual(parsePublicHttpsTarget("https://[2606:4700::1]/"), {
    hostname: "2606:4700::1", authority: "[2606:4700::1]"
  });
  for (const url of ["http://public.test", "wss://public.test", "https://public.test:444",
    "https://user:pass@public.test", "https://service", "https://service.local", "https://x.home.arpa"]) {
    assert.equal(parsePublicHttpsTarget(url), undefined, url);
  }
});

test("public HTTPS rejects special and deployment-local IPv4 and IPv6 addresses", () => {
  const isPublic = createPublicHttpsAddressPolicy(["11.53.49.11/32", "2606:4700:ffff::/48"]);
  for (const address of ["127.0.0.1", "169.254.1.1", "192.0.2.44", "192.88.99.1", "240.0.0.1",
    "::ffff:7f00:1", "::ffff:0b35:310a", "::", "fc00::1", "fec0::1", "ff02::1", "fe80::1",
    "64:ff9b::1", "2001:db8::1", "2002::1", "3fff::1", "11.53.49.11", "2606:4700:ffff::1", "invalid"]) {
    assert.equal(isPublic(address), false, address);
  }
  assert.equal(isPublic("11.53.49.10"), true);
  assert.equal(isPublic("2606:4700::1"), true);
  assert.throws(() => createPublicHttpsAddressPolicy(["not-an-address"]));
});
