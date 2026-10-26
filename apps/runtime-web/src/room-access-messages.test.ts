import assert from "node:assert/strict";
import test from "node:test";
import { setLocale } from "./i18n/i18n.js";
import { describeRoomAccessEnded } from "./room-access-ended.js";
import { describeRoomAccessError, describeSessionControlReason } from "./room-access-messages.js";

test("room access messages preserve every existing reason and unknown fallback", () => {
  const messages = {
    invite_expired: "Access denied: invite link expired",
    invite_revoked: "Access denied: invite link revoked",
    room_disabled: "Access denied: room disabled",
    waiting_room_pending: "Waiting for host approval",
    waiting_room_rejected: "Access denied: host rejected the request",
    invite_required: "Access denied: private invite required",
    room_locked: "Access denied: room is locked",
    participant_removed: "Access denied: removed by host",
    session_ended: "Session ended by host",
    unknown: "Access denied", "": "Access denied"
  };
  for (const [reason, expected] of Object.entries(messages)) {
    assert.equal(describeRoomAccessError({ reason }), expected, reason);
  }
});

test("session blocking messages preserve their deliberately narrower mapping", () => {
  const messages = {
    room_locked: "Access denied: room is locked",
    participant_removed: "Access denied: removed by host",
    session_ended: "Session ended by host",
    invite_expired: "Access denied", waiting_room_pending: "Access denied",
    unknown: "Access denied", "": "Access denied"
  };
  for (const [reason, expected] of Object.entries(messages)) {
    assert.equal(describeSessionControlReason(reason), expected, reason);
  }
});

test("access outcomes and the ended screen speak the UI language", () => {
  setLocale("ru");
  try {
    assert.equal(describeRoomAccessError({ reason: "grant_revoked" }), "Вход закрыт: приглашение отозвано");
    assert.equal(describeSessionControlReason("room_paused"), "Комната на паузе");
    assert.equal(describeRoomAccessError({ reason: "something_new" }), "Вход закрыт");
    assert.deepEqual(describeRoomAccessEnded("capacity_full"), { title: "Комната заполнена", message: "Все места заняты. Попробуйте позже." });
  } finally {
    setLocale("en");
  }
  assert.equal(describeRoomAccessEnded("room_closed")?.title, "This room has ended");
  assert.equal(describeRoomAccessEnded("room_locked"), null);
});
