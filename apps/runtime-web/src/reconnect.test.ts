import test from "node:test";
import assert from "node:assert/strict";

import { canRetry, createReconnectPolicy, getReconnectDelayMs } from "./reconnect.js";

test("getReconnectDelayMs grows exponentially and caps", () => {
  const policy = createReconnectPolicy({ baseDelayMs: 1000, maxDelayMs: 2500 });
  assert.equal(getReconnectDelayMs(1, policy), 1000);
  assert.equal(getReconnectDelayMs(2, policy), 2000);
  assert.equal(getReconnectDelayMs(3, policy), 2500);
});

test("canRetry stops at max retries", () => {
  const policy = createReconnectPolicy({ maxRetries: 3 });
  assert.equal(canRetry(0, policy), true);
  assert.equal(canRetry(2, policy), true);
  assert.equal(canRetry(3, policy), false);
});
