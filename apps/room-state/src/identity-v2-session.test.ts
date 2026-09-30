import assert from "node:assert/strict";
import test from "node:test";
import { getRoomPermissions } from "@vrata/shared-types";
import { createRoomSessionV2Verifier, latestVerifiedRoomSession } from "./identity-v2-session.js";
import { SocketAuthorityError } from "./identity-boundary.js";

const session = {
  tenantId: "tenant", roomId: "room", participantId: "server-id", identityId: "server-identity",
  displayName: "Participant", authEpoch: 1, sessionId: "session", expiresAtSeconds: Math.floor(Date.now() / 1000) + 600,
  authorityRevision: 1, role: "member", permissions: getRoomPermissions("member")
};

test("v2 verification uses current internal authority, not a cached role", async () => {
  let current: unknown = session;
  const requests: Array<{ roomId: string; participantId: string; sessionToken: string; includeSceneContext: boolean }> = [];
  const verify = createRoomSessionV2Verifier({ baseUrl: "http://api.test", internalToken: "private-service-proof",
    readPolicy: async () => ({ minimumProtocolVersion: 2, roomRequiresV2: true }), fetch: async (url, init) => {
      assert.equal(new URL(String(url)).pathname, "/api/internal/identity-session/verify");
      assert.equal((init?.headers as Record<string, string>)["x-vrata-internal-token"], "private-service-proof");
      requests.push(JSON.parse(String(init?.body)));
      return Response.json(current);
    }
  });
  assert.equal((await verify("room", "server-id", "rs2.opaque-proof", true)).role, "member");
  current = { ...session, role: "host", permissions: getRoomPermissions("host"), authorityRevision: 2 };
  assert.equal((await verify("room", "server-id", "rs2.opaque-proof")).role, "host");
  assert.deepEqual(requests, [{ roomId: "room", participantId: "server-id", sessionToken: "rs2.opaque-proof", includeSceneContext: true },
    { roomId: "room", participantId: "server-id", sessionToken: "rs2.opaque-proof", includeSceneContext: false }]);
});

test("v2 authority is unavailable before activation, on outages or malformed role grants", async () => {
  let floor = 1, result: unknown = session;
  const verifier = createRoomSessionV2Verifier({ baseUrl: "http://api.test", internalToken: "private-service-proof",
    readPolicy: async () => ({ minimumProtocolVersion: floor, roomRequiresV2: false }), fetch: async () => Response.json(result) });
  const denied = async (run: () => Promise<unknown>, code: number) => assert.rejects(run,
    error => error instanceof SocketAuthorityError && error.closeCode === code);
  await denied(() => verifier("room", "server-id", "rs2.opaque-proof"), 4406);
  floor = 2;
  await denied(() => verifier("room", "server-id", "legacy-jwt"), 1008);
  for (result of [{ ...session, roomId: "other" }, { ...session, participantId: "other" },
    { ...session, role: "host" }, { ...session, permissions: [...getRoomPermissions("member"), "room.admin"] },
    { ...session, expiresAtSeconds: 0 }]) {
    await denied(() => verifier("room", "server-id", "rs2.opaque-proof"), 1013);
  }
  const offline = createRoomSessionV2Verifier({ baseUrl: "http://api.test", internalToken: "private-service-proof",
    readPolicy: async () => ({ minimumProtocolVersion: 2, roomRequiresV2: true }), fetch: async () => new Response("offline", { status: 503 }) });
  await denied(() => offline("room", "server-id", "rs2.opaque-proof"), 1013);
  const missing = createRoomSessionV2Verifier({ baseUrl: "http://api.test", internalToken: null,
    readPolicy: async () => ({ minimumProtocolVersion: 2, roomRequiresV2: true }) });
  await denied(() => missing("room", "server-id", "rs2.opaque-proof"), 1013);
});

test("a delayed old role cannot overwrite a newer authority revision or another identity epoch", () => {
  const member = { ...session, role: "member" as const, permissions: getRoomPermissions("member"), authorityRevision: 1 };
  const host = { ...session, role: "host" as const, permissions: getRoomPermissions("host"), authorityRevision: 2 };
  assert.deepEqual(latestVerifiedRoomSession(null, member), member);
  assert.deepEqual(latestVerifiedRoomSession(member, host), host);
  assert.deepEqual(latestVerifiedRoomSession(host, member), host, "a slow poll cannot reinstate old membership");
  assert.throws(() => latestVerifiedRoomSession(host, { ...host, authEpoch: 2 }),
    error => error instanceof SocketAuthorityError && error.closeCode === 1008);
  assert.throws(() => latestVerifiedRoomSession(host, { ...host, role: "member", permissions: getRoomPermissions("member") }),
    error => error instanceof SocketAuthorityError && error.closeCode === 1013);
});
