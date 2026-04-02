import test from "node:test";
import assert from "node:assert/strict";

import { sendAvatarPoseFrame, sendAvatarReliableState, sendParticipantUpdate, type RoomStateClient } from "./room-state-client.js";

function createClient(sent: string[] = [], readyState = 1): RoomStateClient {
  return {
    socket: {
      OPEN: 1,
      readyState,
      send(payload: string) {
        sent.push(payload);
      }
    } as unknown as WebSocket,
    close() {}
  };
}

test("sendParticipantUpdate sends json payload when socket is open", () => {
  const sent: string[] = [];
  sendParticipantUpdate(createClient(sent), {
    participantId: "p-1",
    displayName: "Guest",
    mode: "desktop",
    rootTransform: { x: 0, y: 0, z: 0 },
    muted: false,
    activeMedia: { audio: false, screenShare: false },
    updatedAt: new Date(0).toISOString()
  });

  assert.equal(JSON.parse(sent[0]!).type, "participant_update");
});

test("sendAvatarReliableState sends reliable state envelope", () => {
  const sent: string[] = [];
  sendAvatarReliableState(createClient(sent), {
    participantId: "p-1",
    avatarId: "preset-01",
    recipeVersion: 1,
    inputMode: "desktop",
    seated: false,
    muted: false,
    audioActive: true,
    updatedAt: new Date(0).toISOString()
  });

  const payload = JSON.parse(sent[0]!);
  assert.equal(payload.type, "avatar_reliable_state");
  assert.equal(payload.reliableState.avatarId, "preset-01");
});

test("sendAvatarPoseFrame sends pose frame envelope", () => {
  const sent: string[] = [];
  sendAvatarPoseFrame(createClient(sent), {
    seq: 1,
    sentAtMs: 1,
    flags: 0,
    root: { x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0 },
    head: { x: 0, y: 1.6, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
    leftHand: { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 0 },
    rightHand: { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, gesture: 0 },
    locomotion: { mode: 1, speed: 1, angularVelocity: 0 }
  });

  const payload = JSON.parse(sent[0]!);
  assert.equal(payload.type, "avatar_pose_preview");
  assert.equal(payload.poseFrame.locomotion.mode, 1);
});

test("avatar sends are skipped when socket is not open", () => {
  const sent: string[] = [];
  sendAvatarReliableState(createClient(sent, 0), {
    participantId: "p-1",
    avatarId: "preset-01",
    recipeVersion: 1,
    inputMode: "desktop",
    seated: false,
    muted: false,
    audioActive: true,
    updatedAt: new Date(0).toISOString()
  });

  assert.deepEqual(sent, []);
});
