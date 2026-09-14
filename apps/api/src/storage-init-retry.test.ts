import assert from "node:assert/strict";
import test from "node:test";

import { initPostgresStorageWithRetry } from "./storage-init-retry.js";

const retryableCodes = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"];

async function expectRejection(promise: Promise<void>, expected: unknown): Promise<void> {
  await promise.then(
    () => assert.fail("expected initialization to reject"),
    (error: unknown) => assert.equal(error, expected)
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("successful initialization keeps its receiver and does not retry or wait", async () => {
  const storage = { attempts: 0, async init() { this.attempts += 1; } };
  assert.equal(await initPostgresStorageWithRetry(storage, {
    onRetry: () => assert.fail("unexpected retry"),
    wait: async () => assert.fail("unexpected wait")
  }), undefined);
  assert.equal(storage.attempts, 1);
});

test("default options initialize once when no connection error occurs", async () => {
  let attempts = 0;
  await initPostgresStorageWithRetry({ async init() { attempts += 1; } });
  assert.equal(attempts, 1);
});

test("every recognized direct connection code allows another attempt", async () => {
  for (const code of retryableCodes) {
    const failure = { code };
    let attempts = 0;
    const retries: unknown[] = [];
    const waits: number[] = [];
    await initPostgresStorageWithRetry({ async init() {
      if (++attempts === 1) throw failure;
    } }, {
      maxAttempts: 2, retryDelayMs: 7,
      onRetry: (error, attempt, maxAttempts, delay) => retries.push([error, attempt, maxAttempts, delay]),
      wait: async (ms) => { waits.push(ms); }
    });
    assert.equal(attempts, 2);
    assert.deepEqual(retries, [[failure, 1, 2, 7]]);
    assert.equal((retries[0] as unknown[])[0], failure);
    assert.deepEqual(waits, [7]);
  }
});

test("connection codes on an immediate object cause are recognized", async () => {
  for (const code of retryableCodes) {
    let attempts = 0;
    await initPostgresStorageWithRetry({ async init() {
      if (++attempts === 1) throw { code: 123, cause: { code } };
    } }, { maxAttempts: 2, wait: async () => undefined });
    assert.equal(attempts, 2);
  }
});

test("direct string codes take precedence over a retryable cause", async () => {
  for (const code of ["42601", "", "UNKNOWN"]) {
    const failure = { code, cause: { code: "ECONNRESET" } };
    let attempts = 0;
    await expectRejection(initPostgresStorageWithRetry({ async init() {
      attempts += 1;
      throw failure;
    } }, { maxAttempts: 2, wait: async () => assert.fail("unexpected wait") }), failure);
    assert.equal(attempts, 1);
  }
});

test("Error connection messages provide the existing fallback for all codes", async () => {
  for (const code of retryableCodes) {
    const failure = Object.assign(new Error(`prefix: connect ${code} 127.0.0.1:5432`), { code: "42601" });
    let attempts = 0;
    await initPostgresStorageWithRetry({ async init() {
      if (++attempts === 1) throw failure;
    } }, { maxAttempts: 2, wait: async () => undefined });
    assert.equal(attempts, 2);
  }
});

test("non-connection errors and primitive rejection values are returned unchanged", async () => {
  const failures: unknown[] = [null, undefined, false, 0, "connect ECONNREFUSED", Symbol("failure"),
    new Error("read ECONNRESET"), new Error("Connect ECONNRESET"), new Error("connect econnreset"),
    { message: "connect ECONNRESET" }, { cause: { cause: { code: "ECONNRESET" } } },
    { cause: "ECONNRESET" }, { cause: { code: 123 } }, Object.assign(() => undefined, { code: "ECONNRESET" })];
  for (const failure of failures) {
    let attempts = 0;
    await expectRejection(initPostgresStorageWithRetry({ async init() {
      attempts += 1;
      throw failure;
    } }, {
      onRetry: () => assert.fail("unexpected retry"), wait: async () => assert.fail("unexpected wait")
    }), failure);
    assert.equal(attempts, 1);
  }
});

test("default retry budget is twelve attempts with eleven one-second waits", async () => {
  const failure = { code: "ECONNREFUSED" };
  let attempts = 0;
  const retries: number[][] = [];
  const waits: number[] = [];
  await expectRejection(initPostgresStorageWithRetry({ async init() {
    attempts += 1;
    throw failure;
  } }, {
    onRetry: (error, attempt, maxAttempts, delay) => {
      assert.equal(error, failure);
      retries.push([attempt, maxAttempts, delay]);
    },
    wait: async (ms) => { waits.push(ms); }
  }), failure);
  assert.equal(attempts, 12);
  assert.deepEqual(retries, Array.from({ length: 11 }, (_, index) => [index + 1, 12, 1000]));
  assert.deepEqual(waits, Array(11).fill(1000));
});

test("retry exhaustion preserves the last failure without an extra callback or wait", async () => {
  const failures = [{ code: "ECONNRESET" }, { code: "ETIMEDOUT" }, { code: "ENOTFOUND" }];
  let attempts = 0;
  const events: unknown[] = [];
  await expectRejection(initPostgresStorageWithRetry({ async init() {
    events.push("init");
    throw failures[attempts++];
  } }, {
    maxAttempts: 3, retryDelayMs: 4,
    onRetry: (error) => { events.push(error); }, wait: async (ms) => { events.push(ms); }
  }), failures[2]);
  assert.deepEqual(events, ["init", failures[0], 4, "init", failures[1], 4, "init"]);
});

test("a permanent failure after a transient one stops immediately", async () => {
  const permanent = new Error("invalid schema");
  let attempts = 0;
  let waits = 0;
  await expectRejection(initPostgresStorageWithRetry({ async init() {
    if (++attempts === 1) throw { code: "ECONNRESET" };
    throw permanent;
  } }, { maxAttempts: 5, wait: async () => { waits += 1; } }), permanent);
  assert.equal(attempts, 2);
  assert.equal(waits, 1);
});

test("retry options retain floor and lower-bound normalization", async () => {
  for (const [maxAttempts, delay, expectedAttempts, expectedDelay] of [
    [2.9, 7.9, 2, 7], [0, -3, 1, 0], [-5, 2, 1, 2], [2, -3.7, 2, 0]
  ]) {
    const failure = { code: "ECONNRESET" };
    let attempts = 0;
    const waits: number[] = [];
    await expectRejection(initPostgresStorageWithRetry({ async init() {
      attempts += 1;
      throw failure;
    } }, { maxAttempts, retryDelayMs: delay, wait: async (ms) => { waits.push(ms); } }), failure);
    assert.equal(attempts, expectedAttempts);
    assert.deepEqual(waits, Array(expectedAttempts - 1).fill(expectedDelay));
  }
});

test("NaN attempt budget keeps the existing no-attempt behavior", async () => {
  await initPostgresStorageWithRetry({ async init() { assert.fail("unexpected init"); } }, { maxAttempts: NaN });
});

test("NaN delay reaches a supplied wait function unchanged", async () => {
  let attempts = 0;
  const waits: number[] = [];
  await initPostgresStorageWithRetry({ async init() {
    if (++attempts === 1) throw { code: "ECONNRESET" };
  } }, { maxAttempts: 2, retryDelayMs: NaN, wait: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [NaN]);
});

test("a throwing retry callback rejects without waiting or another initialization", async () => {
  const callbackFailure = new Error("callback failure");
  let attempts = 0;
  await expectRejection(initPostgresStorageWithRetry({ async init() {
    attempts += 1;
    throw { code: "ECONNRESET" };
  } }, {
    onRetry: () => { throw callbackFailure; }, wait: async () => assert.fail("unexpected wait")
  }), callbackFailure);
  assert.equal(attempts, 1);
});

test("a rejected wait aborts rather than being treated as an initialization error", async () => {
  const waitFailure = { code: "ECONNRESET" };
  let attempts = 0;
  await expectRejection(initPostgresStorageWithRetry({ async init() {
    attempts += 1;
    throw { code: "ECONNRESET" };
  } }, { wait: async () => { throw waitFailure; } }), waitFailure);
  assert.equal(attempts, 1);
});

test("the next initialization starts only after the pending wait resolves", async () => {
  const waiting = deferred();
  const release = deferred();
  const events: string[] = [];
  let attempts = 0;
  const result = initPostgresStorageWithRetry({ async init() {
    events.push("init");
    if (++attempts === 1) throw { code: "ECONNRESET" };
  } }, {
    maxAttempts: 2, onRetry: () => { events.push("retry"); },
    wait: async () => { events.push("wait"); waiting.resolve(); await release.promise; events.push("ready"); }
  });
  await waiting.promise;
  assert.deepEqual(events, ["init", "retry", "wait"]);
  release.resolve();
  await result;
  assert.deepEqual(events, ["init", "retry", "wait", "ready", "init"]);
});

test("the default wait path handles a zero-delay retry", async () => {
  let attempts = 0;
  await initPostgresStorageWithRetry({ async init() {
    if (++attempts === 1) throw { code: "ECONNRESET" };
  } }, { maxAttempts: 2, retryDelayMs: 0 });
  assert.equal(attempts, 2);
});

test("the final attempt does not inspect the thrown value's error code", async () => {
  const failure = { get code(): string { return assert.fail("unexpected error classification"); } };
  await expectRejection(initPostgresStorageWithRetry({ async init() { throw failure; } }, { maxAttempts: 1 }), failure);
});
