import test from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage, type IncomingHttpHeaders } from "node:http";
import { Socket } from "node:net";

import {
  getRequestHost,
  getRequestProto,
  getDefaultRoomStateUrl,
  getDefaultLivekitUrl,
  getConfiguredPublicLivekitUrl,
  getDefaultRemoteBrowserFrameStreamUrl
} from "./public-endpoints.js";

const environmentKeys = [
  "ROOM_STATE_PUBLIC_URL", "LIVEKIT_URL", "LIVEKIT_PUBLIC_URL",
  "VRATA_LIVEKIT_DOMAIN", "NOAH_LIVEKIT_DOMAIN", "REMOTE_BROWSER_PUBLIC_URL"
] as const;

// All environment-dependent checks are synchronous and restore their inputs.
function withEnvironment(env: NodeJS.ProcessEnv, check: () => void): void {
  const saved = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of environmentKeys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    check();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function request(headers: IncomingHttpHeaders = {}): IncomingMessage {
  const message = new IncomingMessage(new Socket());
  message.headers = headers;
  return message;
}

const proxyRequest = () => request({ host: "internal:4000", "x-forwarded-host": "203.0.113.10.sslip.io", "x-forwarded-proto": "https" });

test("request host uses the first forwarded value before the ordinary Host header", () => {
  assert.equal(getRequestHost(request({ host: "internal:4000", "x-forwarded-host": " public.example:443, proxy.example " })), "public.example:443");
  assert.equal(getRequestHost(request({ host: " app.example:4000 " })), "app.example:4000");
  for (const forwarded of [undefined, "", " \t", ["public.example", "proxy.example"]]) {
    assert.equal(getRequestHost(request({ host: "fallback.example", "x-forwarded-host": forwarded })), "fallback.example");
  }
});

test("missing host and empty first forwarded value keep their existing distinct results", () => {
  assert.equal(getRequestHost(), undefined);
  assert.equal(getRequestHost(request()), undefined);
  assert.equal(getRequestHost(request({ host: "  " })), undefined);
  assert.equal(getRequestHost(request({ host: "fallback.example", "x-forwarded-host": ", proxy.example" })), "");
});

test("request protocol accepts only HTTPS in the first forwarded value", () => {
  for (const value of ["https", " HTTPS ", "https, http"]) {
    assert.equal(getRequestProto(request({ "x-forwarded-proto": value })), "https");
  }
  for (const value of [undefined, "", "http", "wss", "http, https", ["https"]]) {
    assert.equal(getRequestProto(request({ "x-forwarded-proto": value })), "http");
  }
  assert.equal(getRequestProto(), "http");
});

const services = [
  { resolve: getDefaultRoomStateUrl, key: "ROOM_STATE_PUBLIC_URL", fallback: "ws://127.0.0.1:2567", name: "state", port: 2567 },
  { resolve: getDefaultLivekitUrl, key: "LIVEKIT_URL", fallback: "ws://localhost:7880", name: "livekit", port: 7880 }
];

for (const { resolve, key, fallback, name, port } of services) {
  test(`${key}: absent request and host retain local defaults`, () => withEnvironment({}, () => {
    assert.equal(resolve(), fallback);
    assert.equal(resolve(request()), fallback);
  }));

  test(`${key}: derived endpoints preserve host families, ports and proxy protocol`, () => withEnvironment({}, () => {
    for (const [host, hostname] of [["localhost:4000", "localhost"], ["127.0.0.1:4000", "127.0.0.1"], ["203.0.113.10.sslip.io:443", "203.0.113.10.sslip.io"], ["app.example:4000", "app.example"]]) {
      for (const [proto, scheme] of [["http", "ws"], ["https", "wss"]]) {
        const expectedHost = hostname === "localhost" || hostname === "127.0.0.1"
          ? `${hostname}:${port}` : hostname.endsWith(".sslip.io") ? `${name}.${hostname}` : `${name}-${hostname}`;
        assert.equal(resolve(request({ host, "x-forwarded-proto": proto })), `${scheme}://${expectedHost}`);
      }
    }
    assert.equal(resolve(proxyRequest()), `wss://${name}.203.0.113.10.sslip.io`);
  }));

  test(`${key}: explicit secure and non-ws values are returned unchanged`, () => {
    for (const configured of ["wss://explicit.example/custom?mode=1", "https://explicit.example/path", "WS://explicit.example", " invalid "]) {
      withEnvironment({ [key]: configured }, () => {
        assert.equal(resolve(proxyRequest()), configured);
        assert.equal(resolve(), configured);
      });
    }
  });

  test(`${key}: insecure configured endpoints are replaced only behind HTTPS with a host`, () => withEnvironment({ [key]: "ws://explicit.example:9000/custom" }, () => {
    assert.equal(resolve(proxyRequest()), `wss://${name}.203.0.113.10.sslip.io`);
    assert.equal(resolve(request({ host: "app.example", "x-forwarded-proto": "http" })), "ws://explicit.example:9000/custom");
    assert.equal(resolve(request({ "x-forwarded-proto": "https" })), "ws://explicit.example:9000/custom");
    assert.equal(resolve(), "ws://explicit.example:9000/custom");
  }));

  test(`${key}: an empty setting retains the existing no-host fallback semantics`, () => withEnvironment({ [key]: "" }, () => {
    assert.equal(resolve(), "");
    assert.equal(resolve(request({ host: "localhost" })), `ws://localhost:${port}`);
  }));
}

test("public LiveKit URL keeps current and legacy setting precedence", () => {
  withEnvironment({}, () => assert.equal(getConfiguredPublicLivekitUrl(), null));
  withEnvironment({ LIVEKIT_PUBLIC_URL: "current.example", VRATA_LIVEKIT_DOMAIN: "vrata.example", NOAH_LIVEKIT_DOMAIN: "legacy.example" }, () => assert.equal(getConfiguredPublicLivekitUrl(), "wss://current.example"));
  withEnvironment({ LIVEKIT_PUBLIC_URL: "  ", VRATA_LIVEKIT_DOMAIN: "vrata.example", NOAH_LIVEKIT_DOMAIN: "legacy.example" }, () => assert.equal(getConfiguredPublicLivekitUrl(), "wss://vrata.example"));
  withEnvironment({ LIVEKIT_PUBLIC_URL: "", VRATA_LIVEKIT_DOMAIN: " \t", NOAH_LIVEKIT_DOMAIN: " legacy.example " }, () => assert.equal(getConfiguredPublicLivekitUrl(), "wss://legacy.example"));
});

test("public LiveKit URL normalization strips path, query and fragment", () => {
  for (const [input, expected] of [
    [" media.example:8443/path?mode=1#part ", "wss://media.example:8443"],
    ["https://media.example/path?mode=1#part", "wss://media.example"],
    ["ws://media.example:7880/path", "wss://media.example:7880"],
    ["wss://media.example/", "wss://media.example"]
  ]) {
    withEnvironment({ LIVEKIT_PUBLIC_URL: input }, () => assert.equal(getConfiguredPublicLivekitUrl(), expected));
  }
});

test("an invalid nonempty public LiveKit setting does not fall through to its aliases", () => {
  withEnvironment({ LIVEKIT_PUBLIC_URL: "https://[invalid", VRATA_LIVEKIT_DOMAIN: "fallback.example" }, () => assert.equal(getConfiguredPublicLivekitUrl(), null));
});

test("frame stream derives local, sslip and ordinary host endpoints", () => withEnvironment({}, () => {
  assert.equal(getDefaultRemoteBrowserFrameStreamUrl(), "ws://localhost:4010/frames");
  assert.equal(getDefaultRemoteBrowserFrameStreamUrl(request()), "ws://localhost:4010/frames");
  for (const [host, expectedHost] of [["localhost:4000", "localhost:4010"], ["127.0.0.1:4000", "127.0.0.1:4010"], ["203.0.113.10.sslip.io:443", "browser.203.0.113.10.sslip.io"], ["app.example:4000", "browser-app.example"]]) {
    for (const [proto, scheme] of [["http", "ws"], ["https", "wss"]]) {
      assert.equal(getDefaultRemoteBrowserFrameStreamUrl(request({ host, "x-forwarded-proto": proto })), `${scheme}://${expectedHost}/frames`);
    }
  }
  assert.equal(getDefaultRemoteBrowserFrameStreamUrl(proxyRequest()), "wss://browser.203.0.113.10.sslip.io/frames");
}));

test("explicit frame stream origins replace path and map HTTP schemes to WebSocket", () => {
  for (const [input, expected] of [
    ["https://browser.example/base?mode=1#part", "wss://browser.example/frames"],
    ["http://browser.example:4010/base", "ws://browser.example:4010/frames"],
    ["wss://browser.example/base", "wss://browser.example/frames"],
    ["ws://browser.example/base", "ws://browser.example/frames"]
  ]) {
    withEnvironment({ REMOTE_BROWSER_PUBLIC_URL: input }, () => {
      assert.equal(getDefaultRemoteBrowserFrameStreamUrl(proxyRequest()), expected);
      assert.equal(getDefaultRemoteBrowserFrameStreamUrl(), expected);
    });
  }
});

test("invalid explicit frame stream URLs still throw rather than using a fallback", () => {
  for (const input of ["not a URL", "https://[invalid", " "]) {
    withEnvironment({ REMOTE_BROWSER_PUBLIC_URL: input }, () => assert.throws(() => getDefaultRemoteBrowserFrameStreamUrl(proxyRequest()), { code: "ERR_INVALID_URL" }));
  }
  withEnvironment({ REMOTE_BROWSER_PUBLIC_URL: "" }, () => assert.equal(getDefaultRemoteBrowserFrameStreamUrl(), "ws://localhost:4010/frames"));
});

test("configuration is read at call time and remains independent between services", () => withEnvironment({}, () => {
  assert.equal(getDefaultRoomStateUrl(), "ws://127.0.0.1:2567");
  assert.equal(getDefaultLivekitUrl(), "ws://localhost:7880");
  assert.equal(getConfiguredPublicLivekitUrl(), null);
  assert.equal(getDefaultRemoteBrowserFrameStreamUrl(), "ws://localhost:4010/frames");
  process.env.ROOM_STATE_PUBLIC_URL = "wss://state.example";
  process.env.LIVEKIT_URL = "ws://media.internal:7880";
  process.env.LIVEKIT_PUBLIC_URL = "media.example";
  process.env.REMOTE_BROWSER_PUBLIC_URL = "https://browser.example";
  assert.equal(getDefaultRoomStateUrl(), "wss://state.example");
  assert.equal(getDefaultLivekitUrl(), "ws://media.internal:7880");
  assert.equal(getConfiguredPublicLivekitUrl(), "wss://media.example");
  assert.equal(getDefaultRemoteBrowserFrameStreamUrl(), "wss://browser.example/frames");
}));

test("resolving endpoints does not change request headers or environment", () => withEnvironment({}, () => {
  const message = proxyRequest();
  const before = { ...message.headers };
  Object.freeze(message.headers);
  for (const resolve of [getRequestHost, getRequestProto, getDefaultRoomStateUrl, getDefaultLivekitUrl, getDefaultRemoteBrowserFrameStreamUrl]) resolve(message);
  assert.deepEqual(message.headers, before);
  for (const key of environmentKeys) assert.equal(process.env[key], undefined);
}));
