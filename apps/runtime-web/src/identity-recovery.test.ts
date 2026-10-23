import assert from "node:assert/strict";
import test from "node:test";
import { redeemRoomRecovery } from "./identity-recovery.js";

const recovery = `rr2.12345678-1234-4234-8234-1234567890ab.${"a".repeat(43)}`;
const identity = `ri2.${"b".repeat(40)}.${"c".repeat(43)}`;

test("recovery exchanges only the administrator proof for a new room-bound identity", async () => {
  let called = false;
  const renewed = await redeemRoomRecovery({ apiBaseUrl: "https://example.test", roomId: "legacy-room", displayName: "Member",
    credential: ` ${recovery} `, request: async (url, init) => {
      called = true;
      assert.equal(String(url), "https://example.test/api/tokens/state");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        identityProtocolVersion: 2, roomId: "legacy-room", displayName: "Member", recoveryCredential: recovery
      });
      assert.deepEqual(init?.headers, { "content-type": "application/json" });
      return Response.json({ identityProtocolVersion: 2, participantId: "server-owner", identityCredential: identity });
    } });
  assert.equal(called, true);
  assert.deepEqual(renewed, { participantId: "server-owner", identityCredential: identity });
});

test("malformed proof is not sent; denial and malformed server identity cannot be stored", async () => {
  let requests = 0;
  const input = { apiBaseUrl: "https://example.test", roomId: "legacy-room", displayName: "Member",
    request: async () => { requests++; return Response.json({ identityProtocolVersion: 2,
      participantId: "public-owner-id", identityCredential: "not-a-proof" }); } };
  await assert.rejects(redeemRoomRecovery({ ...input, credential: "public-owner-id" }), /invalid_recovery_code/);
  assert.equal(requests, 0);
  await assert.rejects(redeemRoomRecovery({ ...input, credential: recovery }), /invalid_recovery_response/);
  assert.equal(requests, 1);
  await assert.rejects(redeemRoomRecovery({ ...input, credential: recovery,
    request: async () => new Response(null, { status: 409 }) }), /recovery_denied/);
});
