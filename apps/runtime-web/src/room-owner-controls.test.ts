import assert from "node:assert/strict";
import test from "node:test";
import { canManageRoomControls, canTransferRoomOwnership, staleAuthorityResponse } from "./room-owner-controls.js";

test("personal owner admitted as Member can manage room controls without granting access to a normal Member", () => {
  const owner = { enabled: true, canManageSession: false, identityProtocolVersion: 2 as const,
    roomType: "personal" as const, isOwner: true };
  assert.equal(canManageRoomControls(owner), true);
  assert.equal(canManageRoomControls({ ...owner, isOwner: false }), false);
  assert.equal(canManageRoomControls({ ...owner, roomType: "standard" }), false);
  assert.equal(canManageRoomControls({ ...owner, identityProtocolVersion: null }), false);
  assert.equal(canManageRoomControls({ ...owner, enabled: false }), false);
  assert.equal(canManageRoomControls({ ...owner, canManageSession: true, isOwner: false }), true);
});

test("ownership transfer requires a live, distinct recipient and current authority revision", () => {
  const transfer = { controlsVisible: true, identityProtocolVersion: 2 as const,
    roomType: "personal" as const, isOwner: true, selectedParticipantId: "recipient", localParticipantId: "owner",
    selectedIsPresent: true, authorityRevision: 4, actionInFlight: false };
  assert.equal(canTransferRoomOwnership(transfer), true);
  for (const change of [{ isOwner: false }, { selectedParticipantId: "owner" }, { selectedIsPresent: false },
    { authorityRevision: null }, { actionInFlight: true }, { identityProtocolVersion: null }, { roomType: "standard" as const }]) {
    assert.equal(canTransferRoomOwnership({ ...transfer, ...change }), false);
  }
  assert.equal(staleAuthorityResponse(5, 4), true);
  assert.equal(staleAuthorityResponse(5, 5), false);
  assert.equal(staleAuthorityResponse(null, 4), false);
});
