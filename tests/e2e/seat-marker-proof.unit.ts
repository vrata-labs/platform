import { test } from "node:test";
import assert from "node:assert/strict";
import { ownSeatProof, isOwnSeatProof } from "./seat-marker-proof.ts";

const seat = { id: "seat-01", position: { x: 2, y: 0, z: 3 }, seatHeight: 0.5, yaw: 0, radius: 0.4 };
const client = { participantId: "own", currentSeatId: seat.id, occupantId: "own", roomStateConnected: true,
  root: { x: 2, y: -0.38, z: 3 } };
const server = { socketScope: "socket-1", generation: 1, sequence: 7, participants: ["own", "other"],
  occupancy: { [seat.id]: "own", unrelated: "other" }, mediaHash: "not-for-attachment" };
const before = { generation: 1, sequence: 6 };

test("own evidence correlates current seat, own identity, new server message and seated root", () => {
  const proof = ownSeatProof(client, server, seat, before);
  assert.equal(isOwnSeatProof(proof), true);
  assert.doesNotMatch(JSON.stringify(proof), /unrelated|other|mediaHash|not-for-attachment/);
  assert.equal(isOwnSeatProof(ownSeatProof(client, { ...server, generation: 2, sequence: 1 }, seat, before)), true);
});

test("occupied is not current, and client state or HTTP success cannot replace room authority", () => {
  for (const changed of [{ currentSeatId: null }, { currentSeatId: "different-seat" }, { participantId: "other" },
    { occupantId: "other" }, { roomStateConnected: false }, { root: { x: 2, y: 0, z: 3 } },
    { root: { x: NaN, y: -0.38, z: 3 } }]) {
    assert.equal(isOwnSeatProof(ownSeatProof({ ...client, ...changed }, server, seat, before)), false);
  }
  for (const changed of [null, { ...server, occupancy: {} }, { ...server, occupancy: { [seat.id]: "other" } },
    { ...server, participants: ["other"] }, { ...server, sequence: 6 }, { ...server, generation: 0 }]) {
    assert.equal(isOwnSeatProof(ownSeatProof(client, changed, seat, before)), false);
  }
});
