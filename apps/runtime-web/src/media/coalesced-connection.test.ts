import assert from "node:assert/strict";
import test from "node:test";

import { createCoalescedConnection } from "./coalesced-connection.js";

test("concurrent callers share one connection promise and result", async () => {
  let created = 0;
  let releaseConnection!: () => void;
  const connectionGate = new Promise<void>((resolve) => { releaseConnection = resolve; });
  const connector = createCoalescedConnection({
    create: () => ({ id: ++created }),
    connect: async () => connectionGate,
    cleanupFailed: () => undefined
  });

  const first = connector.ensure();
  const second = connector.ensure();
  assert.equal(first, second);
  assert.equal(created, 1);
  assert.equal(connector.hasInFlight(), true);

  releaseConnection();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult, secondResult);
  assert.equal(firstResult.id, 1);
  assert.equal(connector.hasInFlight(), false);
});

test("failed connection cleans its resource and permits a fresh retry", async () => {
  let created = 0;
  const cleaned: number[] = [];
  let rejectConnection!: (error: Error) => void;
  const connectionGate = new Promise<void>((_resolve, reject) => { rejectConnection = reject; });
  const connector = createCoalescedConnection({
    create: () => ({ id: ++created }),
    connect: async (resource) => {
      if (resource.id === 1) {
        await connectionGate;
      }
    },
    cleanupFailed: (resource) => { cleaned.push(resource.id); }
  });

  const first = connector.ensure();
  const concurrent = connector.ensure();
  assert.equal(first, concurrent);
  assert.equal(created, 1);

  rejectConnection(new Error("connect_failed"));
  await assert.rejects(Promise.all([first, concurrent]), /connect_failed/);
  assert.deepEqual(cleaned, [1]);
  assert.equal(connector.hasInFlight(), false);

  const retry = await connector.ensure();
  assert.equal(retry.id, 2);
  assert.equal(created, 2);
  assert.deepEqual(cleaned, [1]);
});

test("invalidating an in-flight connection cleans it and prevents delivery", async () => {
  let created = 0;
  const cleaned: number[] = [];
  let releaseConnection!: () => void;
  const connectionGate = new Promise<void>((resolve) => { releaseConnection = resolve; });
  const connector = createCoalescedConnection({
    create: () => ({ id: ++created }),
    connect: async (resource) => {
      if (resource.id === 1) {
        await connectionGate;
      }
    },
    cleanupFailed: (resource) => { cleaned.push(resource.id); },
    createInvalidatedError: () => new Error("session_blocked")
  });

  const pending = connector.ensure();
  connector.invalidate();
  releaseConnection();

  await assert.rejects(pending, /session_blocked/);
  assert.deepEqual(cleaned, [1]);
  assert.equal(connector.hasInFlight(), false);

  const retry = await connector.ensure();
  assert.equal(retry.id, 2);
  assert.deepEqual(cleaned, [1]);
});
