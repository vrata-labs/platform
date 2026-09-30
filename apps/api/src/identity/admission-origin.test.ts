import assert from "node:assert/strict";
import test from "node:test";
import { identityAdmissionOriginHash } from "./admission-origin.js";

const basic = { peerAddress: "172.18.0.3", signingSecret: "private-testing-key", internalToken: "trusted-proxy-key" };

test("a direct-port caller cannot forge its network origin with forwarded headers", () => {
  const direct = identityAdmissionOriginHash({ ...basic, proxyAddress: undefined, proxyToken: undefined });
  assert.equal(identityAdmissionOriginHash({ ...basic, proxyAddress: "198.51.100.8", proxyToken: "wrong" }), direct);
  assert.equal(identityAdmissionOriginHash({ ...basic, proxyAddress: "198.51.100.8", proxyToken: undefined }), direct);
  assert.equal(identityAdmissionOriginHash({ ...basic, proxyAddress: "not-an-ip", proxyToken: basic.internalToken }), direct);
  assert.notEqual(direct, basic.peerAddress);
  assert.match(direct, /^[a-f0-9]{64}$/);
});

test("authenticated proxy gives separate clients independent privacy-preserving quotas", () => {
  const first = identityAdmissionOriginHash({ ...basic, proxyAddress: "198.51.100.8", proxyToken: basic.internalToken });
  const second = identityAdmissionOriginHash({ ...basic, proxyAddress: "198.51.100.9", proxyToken: basic.internalToken });
  assert.notEqual(first, second);
  assert.equal(first, identityAdmissionOriginHash({ ...basic, peerAddress: "172.18.0.7", proxyAddress: "198.51.100.8",
    proxyToken: basic.internalToken }));
});
