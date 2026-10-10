import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { DatabaseError, type Pool } from "pg";
import { IdentityBoundaryError } from "./legacy-boundary.js";
import { RoomFenceCommitUncertain, RoomFenceUnavailable, identityFenceUnavailable, roomFenceTransaction, uncertainRoomCommit } from "./fence-transaction.js";

function fakePool(failure: Error, failCommit: boolean) {
  const commands: string[] = [];
  let discarded: Error | undefined;
  const client = Object.assign(new EventEmitter(), {
    async query(command: string) {
      commands.push(command);
      if (command === "commit" && failCommit) throw failure;
      return { rows: [], rowCount: 0 };
    },
    release(error?: Error) { discarded = error; }
  });
  return { pool: { connect: async () => client } as unknown as Pool, commands, client,
    discarded: () => discarded };
}

test("a lost COMMIT acknowledgement survives HTTP error mapping and forbids destructive compensation", async () => {
  const network = Object.assign(new Error("acknowledgement lost"), { code: "ECONNRESET" });
  const f = fakePool(network, true);
  let published = false;
  let caught: unknown;
  try { await roomFenceTransaction(f.pool, {}, async () => { published = true; return "document"; }); }
  catch (error) { caught = error; }
  assert.equal(published, true);
  assert.ok(caught instanceof RoomFenceCommitUncertain);
  assert.equal(uncertainRoomCommit(caught), true);
  assert.equal(uncertainRoomCommit(new IdentityBoundaryError(503, "identity_authority_unavailable", caught)), true);
  assert.equal(f.discarded(), network);
  assert.ok(f.commands.includes("rollback"), "best-effort rollback does not prove that a possibly committed publication was undone");
  assert.equal(f.client.listenerCount("error"), 0);
});

test("a confirmed SQL commit rejection and a pre-COMMIT business denial are not ambiguous commits", async () => {
  const sql = Object.assign(new DatabaseError("serialization failure", 0, "error"), { code: "40001", severity: "ERROR" });
  const f = fakePool(sql, true);
  await assert.rejects(roomFenceTransaction(f.pool, {}, async () => "value"), error => {
    assert.equal(error, sql);
    assert.equal(uncertainRoomCommit(error), false);
    return true;
  });
  assert.equal(f.discarded(), undefined);
  const before = fakePool(sql, false);
  const denied = new IdentityBoundaryError(409, "identity_upgrade_required");
  await assert.rejects(roomFenceTransaction(before.pool, {}, async () => { throw denied; }), error => error === denied);
  assert.equal(before.commands.includes("commit"), false);
  assert.equal(uncertainRoomCommit(denied), false);
});

test("unknown timeout, proxy, network and TLS failures after COMMIT remain uncertain by default", async () => {
  for (const failure of [new Error("Query read timeout"), Object.assign(new Error("host unreachable"), { code: "EHOSTUNREACH" }),
    Object.assign(new Error("TLS failure"), { code: "ERR_SSL_PROTOCOL_ERROR" }),
    Object.assign(new DatabaseError("proxy connection gone", 0, "error"), { code: "08P01", severity: "ERROR" }),
    Object.assign(new DatabaseError("server internal failure", 0, "error"), { code: "XX000", severity: "ERROR" }),
    Object.assign(new DatabaseError("server cancellation", 0, "error"), { code: "57014", severity: "ERROR" }),
    Object.assign(new DatabaseError("server fatal I/O", 0, "error"), { code: "58030", severity: "FATAL" }),
    Object.assign(new DatabaseError("server panic I/O", 0, "error"), { code: "58030", severity: "PANIC" })]) {
    const f = fakePool(failure, true);
    await assert.rejects(roomFenceTransaction(f.pool, {}, async () => "published"), error => uncertainRoomCommit(error));
  }
});

test("all pool acquisition failures are typed unavailable before any mutation starts", async () => {
  const unreachable = Object.assign(new Error("host unreachable"), { code: "EHOSTUNREACH" });
  let mutated = false;
  const pool = { connect: async () => { throw unreachable; } } as unknown as Pool;
  await assert.rejects(roomFenceTransaction(pool, {}, async () => { mutated = true; }), error => {
    assert.ok(error instanceof RoomFenceUnavailable);
    assert.equal(error.cause, unreachable);
    assert.equal(identityFenceUnavailable(error), true);
    assert.equal(uncertainRoomCommit(error), false);
    return true;
  });
  assert.equal(mutated, false);
  assert.equal(identityFenceUnavailable(new Error("room_template_binding_changed")), false);
});

test("a beforeCommit throw runs after the effect and is a definite rollback, never an uncertain COMMIT", async () => {
  const f = fakePool(new Error("unused"), false);
  const order: string[] = [];
  const lapsed = new Error("lapsed");
  await assert.rejects(roomFenceTransaction(f.pool, {}, async () => { order.push("effect"); }, () => { order.push("hook"); throw lapsed; }),
    error => error === lapsed && !uncertainRoomCommit(error));
  assert.deepEqual(order, ["effect", "hook"]);
  assert.equal(f.commands.includes("commit"), false);
  assert.ok(f.commands.includes("rollback"));
  const ok = fakePool(new Error("unused"), false);
  assert.equal(await roomFenceTransaction(ok.pool, {}, async () => "value", () => undefined), "value");
  assert.equal(ok.commands.at(-1), "commit");
});
