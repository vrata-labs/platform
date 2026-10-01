import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { TestContext } from "node:test";
import { createApiMetrics } from "../api-metrics.js";
import type { ControlPlaneActor } from "../control-plane-actor.js";
import { createRoomNotesAccess, type RoomNotesAccessContext } from "../room-notes-access.js";
import { createRoomNotesRoutes } from "../room-notes-routes.js";
import { MemoryStorage } from "../storage.js";

export function makeNotesExchange(method: string, path: string, body?: unknown, rawBody?: string) {
  const raw = rawBody ?? (body === undefined ? "" : JSON.stringify(body));
  const request = Object.assign(Readable.from(raw ? [Buffer.from(raw)] : []), {
    method, url: path, headers: { "x-request-id": "notes-request" }
  }) as unknown as IncomingMessage;
  const output = {
    status: 0, headers: {} as Record<string, string>, body: Buffer.alloc(0) as Buffer, writes: 0,
    json(): unknown { return JSON.parse(output.body.toString("utf8")); }
  };
  // Only the two response methods used by the real HTTP response helpers are implemented.
  const response = {
    writeHead(status: number, headers: Record<string, string>) {
      output.status = status; output.headers = headers; return this;
    },
    end(data: string | Buffer) {
      output.body = Buffer.isBuffer(data) ? data : Buffer.from(data);
      output.writes += 1; return this;
    }
  } as unknown as ServerResponse;
  return { request, response, method, url: new URL(path, "http://notes.test"), output };
}

export function createRoomNotesHarness(t: TestContext) {
  const previousFlag = process.env.FEATURE_NOTES;
  process.env.FEATURE_NOTES = "true";
  t.after(() => {
    if (previousFlag === undefined) delete process.env.FEATURE_NOTES;
    else process.env.FEATURE_NOTES = previousFlag;
  });
  const storage = new MemoryStorage();
  const { metrics } = createApiMetrics(new Map(), () => {}, () => 0);
  const logs: Record<string, unknown>[] = [];
  const authRequests: IncomingMessage[] = [];
  const actor: ControlPlaneActor = {
    actorType: "room-session", actorId: "member-1", participantId: "member-1", roomId: "demo-room",
    tenantId: "demo-tenant", sessionId: "session-1", role: "member", roleSource: "trusted",
    permissions: ["notes.view", "notes.edit"]
  };
  const state: { actorResult: ReturnType<RoomNotesAccessContext["resolveControlPlaneActor"]> } = {
    actorResult: { ok: true, actor }
  };
  const context: RoomNotesAccessContext = {
    metrics,
    resolveControlPlaneActor: function (this: unknown, request) {
      assert.equal(this, undefined); authRequests.push(request); return state.actorResult;
    },
    getRequestId: function (this: unknown, request) {
      assert.equal(this, undefined); return String(request.headers["x-request-id"]);
    },
    logEvent: function (this: unknown, event) { assert.equal(this, undefined); logs.push(event); }
  };
  const route = createRoomNotesRoutes(context);
  function dispatch(method: string, path: string, body?: unknown, rawBody?: string) {
    const exchange = makeNotesExchange(method, path, body, rawBody);
    const pending = route(exchange.request, exchange.response, method, exchange.url, storage);
    return { ...exchange, pending };
  }
  async function send(method: string, path: string, body?: unknown) {
    const exchange = dispatch(method, path, body);
    assert.ok(exchange.pending, `Unmatched notes request: ${method} ${path}`);
    await exchange.pending;
    assert.equal(exchange.output.writes, 1);
    return exchange.output;
  }
  return { context, storage, metrics, actor, state, logs, authRequests, route, dispatch, send,
    access: createRoomNotesAccess(context) };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
