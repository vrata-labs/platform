import assert from "node:assert/strict";
import test from "node:test";

import { decodeRemoteBrowserFrameToken, encodeRemoteBrowserFrameToken } from "./frame-token.js";

test("remote browser frame token round-trips scoped payload", () => {
  const payload = {
    roomId: "room-1",
    objectId: "object-1",
    executorSessionId: "remote-browser:object-1",
    frameStreamId: "remote-browser:object-1:frames",
    exp: Math.floor(Date.now() / 1000) + 60
  };
  const token = encodeRemoteBrowserFrameToken(payload, "secret-1");

  assert.deepEqual(decodeRemoteBrowserFrameToken(token, "secret-1"), payload);
  assert.equal(decodeRemoteBrowserFrameToken(token, "wrong-secret"), null);
});

test("remote browser frame token rejects expired payload", () => {
  const token = encodeRemoteBrowserFrameToken({
    roomId: "room-1",
    objectId: "object-1",
    executorSessionId: "remote-browser:object-1",
    frameStreamId: "remote-browser:object-1:frames",
    exp: Math.floor(Date.now() / 1000) - 1
  }, "secret-1");

  assert.equal(decodeRemoteBrowserFrameToken(token, "secret-1"), null);
});
