import assert from "node:assert/strict";
import test from "node:test";
import type { RoomInviteRecord } from "./index.js";
import { mergeConfirmedInviteCreate, mergeKnownInviteLinks, withoutUnusableInviteLinks } from "./invite-list.js";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const invite = (overrides: Partial<RoomInviteRecord> = {}): RoomInviteRecord => ({
  inviteId: "inv-a", roomId: "room-1", role: "member", waitingRoomEnabled: false,
  createdAt: "2026-10-08T11:00:00.000Z", expiresAt: "2026-10-08T13:00:00.000Z", revokedAt: null, ...overrides
});
const links = (records: RoomInviteRecord[]) => records.map(record => [record.inviteId, record.inviteLink ?? null]);

test("known links survive sanitized refresh for the same live invite without mutating either input", () => {
  const previous = [invite({ inviteLink: "marker:known-link" })], before = structuredClone(previous);
  const fetched = [invite({ waitingRoomEnabled: true })];
  const merged = mergeKnownInviteLinks(previous, fetched, "room-1", NOW);
  assert.deepEqual(merged, [{ ...fetched[0], inviteLink: "marker:known-link" }]);
  assert.notEqual(merged[0], previous[0]); assert.notEqual(merged[0], fetched[0]); assert.deepEqual(previous, before);
  assert.equal("inviteLink" in fetched[0], false);
});
test("a fresh valid link takes precedence over the page's older link", () => {
  assert.deepEqual(links(mergeKnownInviteLinks([invite({ inviteLink: "marker:old" })], [invite({ inviteLink: "marker:new" })], "room-1", NOW)), [["inv-a", "marker:new"]]);
});
test("revocation, expiry, deleted or foreign invites never regain a link", () => {
  const previous = [invite({ inviteId: "revoked", inviteLink: "marker:r" }), invite({ inviteId: "expired", inviteLink: "marker:e" }),
    invite({ inviteId: "deleted", inviteLink: "marker:d" }), invite({ inviteId: "moved", roomId: "room-2", inviteLink: "marker:m" }), invite({ inviteId: "live", inviteLink: "marker:l" })];
  const fetched = [invite({ inviteId: "revoked", revokedAt: "2026-10-08T11:30:00.000Z" }), invite({ inviteId: "expired", expiresAt: new Date(NOW).toISOString() }),
    invite({ inviteId: "bad-expiry", expiresAt: "not-a-date", inviteLink: "marker:b" }), invite({ inviteId: "moved" }),
    invite({ inviteId: "foreign", roomId: "room-2", inviteLink: "marker:f" }), invite({ inviteId: "live" }), invite({ inviteId: "unknown" })];
  assert.deepEqual(links(mergeKnownInviteLinks(previous, fetched, "room-1", NOW)), [["revoked", null], ["expired", null], ["bad-expiry", null], ["moved", null], ["foreign", null], ["live", "marker:l"], ["unknown", null]]);
});
test("a room switch cannot carry a secret into a different room even with an equal invite ID", () => {
  assert.deepEqual(links(mergeKnownInviteLinks([invite({ inviteLink: "marker:room-1" })], [invite({ roomId: "room-2" })], "room-2", NOW)), [["inv-a", null]]);
});
test("rendering drops a known link once its stored expiry passes and keeps the invite metadata", () => {
  const previous = [invite({ inviteLink: "marker:live" }), invite({ inviteId: "inv-b", expiresAt: new Date(NOW).toISOString(), inviteLink: "marker:expired" })];
  const before = structuredClone(previous), rendered = withoutUnusableInviteLinks(previous, "room-1", NOW);
  assert.deepEqual(links(rendered), [["inv-a", "marker:live"], ["inv-b", null]]);
  assert.equal(rendered[0], previous[0]); assert.equal("inviteLink" in rendered[1], false);
  assert.deepEqual({ ...rendered[1], inviteLink: previous[1].inviteLink }, previous[1]); assert.deepEqual(previous, before);
});

test("a late create acknowledgement preserves a confirmed revoke and cannot restore its link", () => {
  const previous = [invite({ revokedAt: "2026-10-08T11:30:00.000Z", revokedBy: "operator" })], before = structuredClone(previous);
  const created = invite({ inviteLink: "marker:late-create" });
  const merged = mergeConfirmedInviteCreate(previous, created);
  assert.equal(merged[0].revokedAt, previous[0].revokedAt); assert.equal(merged[0].inviteLink, undefined);
  assert.deepEqual(previous, before); assert.equal(created.inviteLink, "marker:late-create");
  assert.deepEqual(mergeConfirmedInviteCreate([], created), [created]);
});
