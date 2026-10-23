import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
import test from "node:test";
import type { WebSocket } from "ws";
import { createIdentityProtocolReader, guardLegacySocket, type IdentityProtocolPolicy } from "./identity-boundary.js";
import { startRoomStateService } from "./index.js";

const legacy = { minimumProtocolVersion: 1, roomRequiresV2: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
class Socket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  code?: number;
  reason?: string;
  close(code = 1000, reason = "") { this.code = code; this.reason = reason; this.readyState = 3; this.emit("close", code, reason); }
  incoming(type: string) { this.emit("message", Buffer.from(JSON.stringify({ type }))); }
}
const asSocket = (value: Socket) => value as unknown as WebSocket;

test("reader authenticates each protocol-one check and caches only a raised floor", async () => {
  let minimumProtocolVersion = 1, calls = 0;
  const reader = createIdentityProtocolReader({ baseUrl: "http://api.test", internalToken: "test-internal",
    fetch: async (url, init) => {
      calls++;
      assert.equal(new URL(String(url)).searchParams.get("roomId"), "room-one");
      assert.equal((init?.headers as Record<string, string>)["x-vrata-internal-token"], "test-internal");
      return Response.json({ minimumProtocolVersion, roomRequiresV2: false });
    }
  });
  await reader("room-one"); await reader("room-one");
  assert.equal(calls, 2);
  minimumProtocolVersion = 2;
  assert.equal((await reader("room-one")).minimumProtocolVersion, 2);
  minimumProtocolVersion = 1;
  assert.equal((await reader("another-room")).minimumProtocolVersion, 2);
  assert.equal(calls, 3);
});

test("out-of-order policy responses cannot reauthorize a legacy connection", async () => {
  const late = deferred<Response>(); let calls = 0;
  const reader = createIdentityProtocolReader({ baseUrl: "http://api.test", fetch: async () => ++calls === 1 ? late.promise : Response.json({ ...legacy, minimumProtocolVersion: 2 }) });
  const old = reader("room");
  assert.equal((await reader("room")).minimumProtocolVersion, 2);
  late.resolve(Response.json(legacy));
  assert.equal((await old).minimumProtocolVersion, 2);
});

test("missing, invalid and failed policy responses never become protocol one", async () => {
  for (const response of [new Response("offline", { status: 503 }), Response.json({}), Response.json({ ...legacy, minimumProtocolVersion: 0 }), Response.json({ ...legacy, roomRequiresV2: "false" })]) {
    const reader = createIdentityProtocolReader({ baseUrl: "http://api.test", fetch: async () => response });
    await assert.rejects(reader("room"), /identity_authority_unavailable/);
  }
});

test("socket closes after activation before executing a privileged command", async () => {
  const socket = new Socket(); let minimumProtocolVersion = 1, admitted = 0;
  const executed: string[] = [];
  guardLegacySocket({ socket: asSocket(socket), roomId: "room", readPolicy: async () => ({ ...legacy, minimumProtocolVersion }),
    admit: () => { admitted++; }, dispatch: raw => executed.push(JSON.parse(String(raw)).type) });
  socket.incoming("participant_update");
  await tick();
  assert.equal(admitted, 1);
  assert.deepEqual(executed, ["participant_update"]);
  minimumProtocolVersion = 2;
  socket.incoming("surface_create_object");
  await tick();
  assert.equal(socket.code, 4406);
  assert.equal(socket.reason, "identity_upgrade_required");
  assert.deepEqual(executed, ["participant_update"]);
});

test("idle legacy sockets are closed on a bounded policy poll", { timeout: 2000 }, async () => {
  const socket = new Socket(); let upgraded = false;
  guardLegacySocket({ socket: asSocket(socket), roomId: "room", readPolicy: async () => ({ ...legacy, roomRequiresV2: upgraded }),
    admit() {}, dispatch() {}, pollIntervalMs: 10 });
  await tick();
  const closed = once(socket, "close");
  const deadline = setTimeout(() => socket.close(4999, "test_deadline"), 1000);
  upgraded = true;
  try { await closed; } finally { clearTimeout(deadline); }
  assert.equal(socket.code, 4406);
});

test("closed sockets cannot be admitted by a late policy response", async () => {
  const socket = new Socket(); const policy = deferred<IdentityProtocolPolicy>();
  let admitted = 0, dispatched = 0;
  guardLegacySocket({ socket: asSocket(socket), roomId: "room", readPolicy: () => policy.promise,
    admit() { admitted++; }, dispatch() { dispatched++; } });
  socket.incoming("avatar_reliable_state"); socket.close();
  policy.resolve(legacy);
  await tick();
  assert.equal(admitted, 0); assert.equal(dispatched, 0);
});

test("commands preserve order across revalidation and do not run after disconnect", async () => {
  const socket = new Socket(); const pending = deferred<IdentityProtocolPolicy>(); let calls = 0;
  const executed: string[] = [];
  guardLegacySocket({ socket: asSocket(socket), roomId: "room", readPolicy: async () => ++calls === 2 ? pending.promise : legacy,
    admit() {}, dispatch: raw => executed.push(JSON.parse(String(raw)).type) });
  await tick();
  socket.incoming("surface_create_object"); socket.incoming("surface_stop_object");
  await tick(); assert.deepEqual(executed, []);
  pending.resolve(legacy); await tick();
  assert.deepEqual(executed, ["surface_create_object", "surface_stop_object"]);
  assert.equal(calls, 3);
  socket.close(); socket.incoming("seat_claim");
  await tick(); assert.equal(executed.length, 2);
});

test("pending admission has a bounded queue and authority failures fail closed", async () => {
  const socket = new Socket(); const policy = deferred<IdentityProtocolPolicy>(); let admitted = 0;
  guardLegacySocket({ socket: asSocket(socket), roomId: "room", readPolicy: () => policy.promise, admit() { admitted++; }, dispatch() {} });
  for (let i = 0; i < 129; i++) socket.incoming("participant_update");
  assert.equal(socket.code, 1009);
  policy.resolve(legacy); await tick(); assert.equal(admitted, 0);
  const unavailable = new Socket();
  guardLegacySocket({ socket: asSocket(unavailable), roomId: "room", readPolicy: async () => { throw new Error("offline"); }, admit() { admitted++; }, dispatch() {} });
  await tick(); assert.equal(unavailable.code, 1013); assert.equal(admitted, 0);
});

test("production cannot start room-state with the fallback signing secret", () => {
  const previous = { mode: process.env.NODE_ENV, secret: process.env.STATE_TOKEN_SECRET };
  try {
    process.env.NODE_ENV = "production";
    for (const secret of [undefined, "", "dev-state-secret"]) {
      if (secret === undefined) delete process.env.STATE_TOKEN_SECRET; else process.env.STATE_TOKEN_SECRET = secret;
      assert.throws(() => startRoomStateService(0, { readIdentityPolicy: async () => legacy }), /state_token_secret_required/);
    }
  } finally {
    if (previous.mode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.mode;
    if (previous.secret === undefined) delete process.env.STATE_TOKEN_SECRET; else process.env.STATE_TOKEN_SECRET = previous.secret;
  }
});

test("a failing diagnostic sink cannot keep a denied socket open", async () => {
  const socket = new Socket(); let admitted = false;
  guardLegacySocket({ socket: asSocket(socket), roomId: "room", readPolicy: async () => ({ ...legacy, minimumProtocolVersion: 2 }),
    admit() { admitted = true; }, dispatch() {}, onDenied() { throw new Error("log sink closed"); } });
  await tick();
  assert.equal(socket.code, 4406);
  assert.equal(admitted, false);
});
