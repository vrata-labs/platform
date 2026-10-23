import assert from "node:assert/strict";
import test from "node:test";
import type { LegacyAdmissionWriteInput, LegacyRoomCredentialSnapshot, RoomInviteRecord, RoomRecord, WaitingRoomRequestRecord } from "../storage-contracts.js";
import { IdentityStorageError } from "./contracts.js";
import { LegacyAdmissionDeadlineExpired, LegacyAdmissionWriteInvariant, type LegacyAdmissionDeadline } from "./legacy-admission-write.js";
import {
  assertLegacyWriteLeases, captureLegacyAdmissionWrite, decideLegacyWrite, effectiveLegacyLeases, legacyHostSeat, legacyWritePins,
  rawLegacyHostSeat, unwrittenLegacyReceipt, type LegacyWriteIntent, type LegacyWritePins
} from "./legacy-admission-mutation.js";

const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const HOUR = 3_600_000;
const PLAN = "invalid_legacy_admission_plan";
const DEADLINE = "invalid_legacy_admission_deadline";
const iso = (ms: number) => new Date(ms).toISOString();
const inviteLease = (expiresAtMs = NOW + HOUR): LegacyAdmissionDeadline => ({ kind: "invite", expiresAtMs });
const bearerLease = (expiresAtMs = NOW + 600_000): LegacyAdmissionDeadline => ({ kind: "bearer", expiresAtMs });
const invite = (expiresAt = iso(NOW + HOUR)) => ({ inviteId: "invite-1", roomId: "room-1", tokenHash: "hash-1", role: "member",
  protocolVersion: 1, waitingRoomEnabled: true, createdAt: iso(NOW - 60_000), expiresAt }) as RoomInviteRecord;
const waiting = (status: WaitingRoomRequestRecord["status"]) => ({ requestId: "wait-1", roomId: "room-1", inviteId: "invite-1",
  participantId: "p-1", displayName: "Pat", status, createdAt: iso(NOW) }) as WaitingRoomRequestRecord;
const FRESH = Object.freeze({ room: { roomId: "room-1" } as RoomRecord, invite: null, waiting: null }) as LegacyRoomCredentialSnapshot;
const input = (over: Record<string, unknown> = {}) => ({ selector: { tenantId: "tenant-1", roomId: "room-1", participantId: "p-1", inviteTokenHash: "hash-1" },
  mode: "pending", deadline: inviteLease(), presentedBearerDeadline: null, displayName: "Pat", decide: () => ({ write: "insert_pending" }), ...over }) as unknown as LegacyAdmissionWriteInput;
const host = (over: Record<string, unknown> = {}) => input({ mode: "claim_host", displayName: null, deadline: null, ...over });

// Only fixed codes reach assertion output; a message that differs from its code would be an echo.
function attempt(run: () => string): string {
  try { return run(); } catch (error) {
    if (error instanceof LegacyAdmissionDeadlineExpired) return `expired:${error.kind}`;
    if (error instanceof LegacyAdmissionWriteInvariant || error instanceof IdentityStorageError) return error.message === error.code ? error.code : "echoed";
    throw error;
  }
}
const code = (run: () => unknown) => attempt(() => { run(); return "ok"; });

test("capture copies scope, mode, name, both leases and the callback before any wait", () => {
  const decide = () => ({ write: "insert_pending" } as const);
  const raw = input({ decide, presentedBearerDeadline: bearerLease() }), options = { lockTimeoutMs: 50, idleTimeoutMs: 100 };
  const guard = captureLegacyAdmissionWrite(raw, options);
  Object.assign(raw.selector, { roomId: "room-2", participantId: "p-2", inviteTokenHash: null });
  Object.assign(raw, { mode: "claim_host", displayName: "Intruder", decide: () => ({ write: "set_host" }) });
  Object.assign(raw.deadline!, { kind: "bearer", expiresAtMs: NOW + 9 * HOUR });
  Object.assign(raw.presentedBearerDeadline!, { expiresAtMs: NOW + 9 * HOUR });
  Object.assign(options, { lockTimeoutMs: 1 });
  assert.deepEqual({ ...guard }, { tenantId: "tenant-1", roomId: "room-1", participantId: "p-1", inviteTokenHash: "hash-1", lockTimeoutMs: 50,
    idleTimeoutMs: 100, mode: "pending", displayName: "Pat", leases: { deadline: inviteLease(), presentedBearerDeadline: bearerLease() }, decide });
  for (const part of [guard, guard.leases, guard.leases.deadline, guard.leases.presentedBearerDeadline]) assert.equal(Object.isFrozen(part), true);
  // A host claim needs no name; a personal owner or public claim carries no lease.
  const claim = captureLegacyAdmissionWrite(host(), {});
  assert.deepEqual([claim.mode, claim.displayName, claim.leases], ["claim_host", null, { deadline: null, presentedBearerDeadline: null }]);
});

test("a malformed write is a fixed-code fault that echoes no field, table or value", () => {
  const cases: Array<[unknown, unknown, string]> = [
    [null, {}, PLAN], ["pending", {}, PLAN], [input({ mode: "renew" }), {}, PLAN], [input({ decide: "insert_pending" }), {}, PLAN],
    [input({ displayName: null }), {}, PLAN], [input({ displayName: 7 }), {}, PLAN], [host({ displayName: undefined }), {}, PLAN],
    [input(), { lockTimeoutMs: 1.5 }, PLAN], [input(), { idleTimeoutMs: "5000" }, PLAN],
    [input({ selector: { tenantId: "tenant-1", roomId: "", participantId: "p-1", inviteTokenHash: null } }), {}, "room_not_found"],
    [input({ selector: { tenantId: "tenant-1", roomId: "room-1", participantId: "", inviteTokenHash: null } }), {}, "invalid_identity_input"],
    // A waiting request is only ever planned under its invite's lease; a presented lease is only ever a bearer's.
    [input({ deadline: null }), {}, DEADLINE], [input({ deadline: bearerLease() }), {}, DEADLINE], [input({ deadline: "invite" }), {}, DEADLINE],
    [input({ deadline: { kind: "invite", expiresAtMs: 0 } }), {}, DEADLINE], [input({ deadline: { kind: "invite", expiresAtMs: 1.5 } }), {}, DEADLINE],
    [input({ deadline: { kind: "invite", expiresAtMs: Number.MAX_SAFE_INTEGER + 2 } }), {}, DEADLINE],
    [input({ deadline: { kind: "invite", expiresAtMs: String(NOW + HOUR) } }), {}, DEADLINE],
    [host({ deadline: { kind: "session", expiresAtMs: NOW } }), {}, DEADLINE], [host({ presentedBearerDeadline: inviteLease() }), {}, DEADLINE]
  ];
  for (const [raw, options, expected] of cases) assert.equal(code(() => captureLegacyAdmissionWrite(raw, options)), expected, expected);
});

test("every write moment answers with the earlier lapse, at the exact expiry instant, and a tie is the bearer's", () => {
  const at = (deadline: LegacyAdmissionDeadline | null, presented: LegacyAdmissionDeadline | null, nowMs: number) =>
    code(() => assertLegacyWriteLeases({ deadline, presentedBearerDeadline: presented }, nowMs));
  assert.deepEqual([at(inviteLease(NOW + 10), null, NOW + 9), at(inviteLease(NOW + 10), null, NOW + 10),
    at(inviteLease(NOW + 10), bearerLease(NOW + 20), NOW + 20), at(inviteLease(NOW + 20), bearerLease(NOW + 10), NOW + 20),
    at(inviteLease(NOW + 10), bearerLease(NOW + 10), NOW + 10), at(null, null, NOW + 99 * HOUR)],
  ["ok", "expired:invite", "expired:invite", "expired:bearer", "expired:bearer", "ok"]);
  for (const nowMs of [-1, 0.5, Number.NaN]) assert.equal(at(null, null, nowMs), DEADLINE);
  assert.equal(at(null, inviteLease(), NOW), DEADLINE);
});

test("only an absent, null or empty host is vacant, and a non-object control is never stomped", () => {
  assert.deepEqual([undefined, null, "", "p-1", "p-2", 0].map(seat => legacyHostSeat(true, seat, "p-1")),
    ["vacant", "vacant", "vacant", "subject", "occupied", "occupied"]);
  assert.equal(legacyHostSeat(false, undefined, "p-1"), "malformed");
  assert.deepEqual([undefined, null, {}, { hostParticipantId: "" }, { hostParticipantId: "p-1" }, [], "control", 7].map(control => rawLegacyHostSeat(control, "p-1")),
    ["vacant", "vacant", "vacant", "vacant", "subject", "malformed", "malformed", "malformed"]);
});

const pins = (over: Partial<LegacyWritePins> = {}): LegacyWritePins => ({ seat: "vacant", inviteId: "invite-1", inviteExpiresAtMs: NOW + HOUR,
  waitingRequestId: null, waitingPending: false, ...over });
const HELD = pins({ waitingRequestId: "wait-1", waitingPending: true });
const describe = (next: LegacyWriteIntent) => next.kind === "insert_pending" ? `insert:${next.inviteId}`
  : next.kind === "pending_current" ? `current:${next.accessRequestId}` : next.kind === "refused" ? `refused:${next.reason}:${next.accessRequestId ?? "-"}` : next.kind;
function intent(mode: "claim_host" | "pending", answer: unknown, pinned: LegacyWritePins, redecided: boolean): string {
  let calls = 0;
  const decide = (fresh: LegacyRoomCredentialSnapshot, atMs: number) => { calls += 1; assert.deepEqual([fresh, atMs], [FRESH, NOW + 7]); return answer; };
  const guard = captureLegacyAdmissionWrite(mode === "claim_host" ? host({ decide }) : input({ decide }), {});
  const result = attempt(() => describe(decideLegacyWrite(guard, FRESH, NOW + 7, pinned, redecided)));
  assert.equal(calls, 1, "the trusted callback runs exactly once on the store's clones and instant");
  return result;
}
const intents: Array<[string, "claim_host" | "pending", unknown, LegacyWritePins, boolean, string]> = [
  ["a vacant seat is set", "claim_host", { write: "set_host" }, pins(), false, "set_host"],
  ["another host is drift", "claim_host", { write: "set_host" }, pins({ seat: "occupied" }), false, "changed"],
  ["a malformed control is drift", "claim_host", { write: "set_host" }, pins({ seat: "malformed" }), false, "changed"],
  ["host current needs the subject seated", "claim_host", { write: "none_host_current" }, pins(), false, "changed"],
  ["host current", "claim_host", { write: "none_host_current" }, pins({ seat: "subject" }), false, "host_current"],
  ["an insert names only the pinned invite", "pending", { write: "insert_pending" }, pins({ inviteId: "pinned" }), false, "insert:pinned"],
  ["a lost natural-key race never inserts again", "pending", { write: "insert_pending" }, pins(), true, "changed"],
  ["pending current names the pinned row", "pending", { write: "none_pending", accessRequestId: "wait-1" }, HELD, false, "current:wait-1"],
  ["a refusal names only the pinned row", "pending", { write: "refuse", status: 403, reason: "waiting_room_rejected", accessRequestId: "wait-1" },
    pins({ waitingRequestId: "wait-1" }), false, "refused:waiting_room_rejected:wait-1"],
  ["a host refusal", "claim_host", { write: "refuse", status: 403, reason: "session_ended" }, pins(), false, "refused:session_ended:-"],
  ["drift", "pending", { write: "changed", status: 409, reason: "room_state_changed" }, pins(), false, "changed"],
  // Every shape outside the mode's closed family is a wiring fault, never a write.
  ["an async answer", "pending", Promise.resolve({ write: "insert_pending" }), pins(), false, PLAN],
  ["a thenable", "claim_host", { write: "set_host", then: () => undefined }, pins(), false, PLAN],
  ["no answer", "claim_host", null, pins(), false, PLAN],
  ["an unknown write", "claim_host", { write: "grant_host" }, pins(), false, PLAN],
  ["an inherited key", "claim_host", { write: "toString" }, pins(), false, PLAN],
  ["a spare identifier", "claim_host", { write: "set_host", participantId: "p-9" }, pins(), false, PLAN],
  ["a host write while pending", "pending", { write: "set_host" }, pins(), false, PLAN],
  ["a pending write while claiming", "claim_host", { write: "insert_pending" }, pins(), false, PLAN],
  ["an insert beside a pinned row", "pending", { write: "insert_pending" }, HELD, false, PLAN],
  ["an insert without an invite", "pending", { write: "insert_pending" }, pins({ inviteId: null }), false, PLAN],
  ["a foreign access request", "pending", { write: "none_pending", accessRequestId: "wait-9" }, HELD, false, PLAN],
  ["a decided row is never current", "pending", { write: "none_pending", accessRequestId: "wait-1" }, pins({ waitingRequestId: "wait-1" }), false, PLAN],
  ["a refusal naming an unpinned row", "pending", { write: "refuse", status: 403, reason: "invite_revoked", accessRequestId: "wait-1" }, pins(), false, PLAN],
  ["a refusal status", "claim_host", { write: "refuse", status: 401, reason: "session_ended" }, pins(), false, PLAN],
  ["a refusal reason shape", "claim_host", { write: "refuse", status: 403, reason: "Session Ended" }, pins(), false, PLAN],
  ["a drift reason", "claim_host", { write: "changed", status: 409, reason: "room_locked" }, pins(), false, PLAN]
];
for (const [name, mode, answer, pinned, redecided, expected] of intents) {
  test(`intent: ${name}`, () => assert.equal(intent(mode, answer, pinned, redecided), expected));
}

test("an invite lease narrows to the pinned invite's expiry and never widens; a bearer lease never moves", () => {
  const pending = captureLegacyAdmissionWrite(input({ presentedBearerDeadline: bearerLease() }), {});
  const insert: LegacyWriteIntent = { kind: "insert_pending", inviteId: "invite-1" };
  const at = (expiresAt: string, next: LegacyWriteIntent = insert) => attempt(() => {
    const leases = effectiveLegacyLeases(pending, next, legacyWritePins("vacant", invite(expiresAt), null));
    assert.deepEqual(leases.presentedBearerDeadline, bearerLease());
    return String(leases.deadline?.expiresAtMs);
  });
  // A refusal or drift beside an unparsable invite keeps the original lease; an allowed write without one is a fault.
  assert.deepEqual([at(iso(NOW + 60_000)), at(iso(NOW + 2 * HOUR)), at(""), at("", { kind: "refused", reason: "invite_revoked", accessRequestId: null }),
    at("", { kind: "changed" })], [String(NOW + 60_000), String(NOW + HOUR), DEADLINE, String(NOW + HOUR), String(NOW + HOUR)]);
  const claim = captureLegacyAdmissionWrite(host({ deadline: bearerLease() }), {});
  assert.equal(effectiveLegacyLeases(claim, { kind: "set_host" }, legacyWritePins("vacant", invite(iso(NOW + 1)), null)), claim.leases);
  assert.deepEqual({ ...legacyWritePins("subject", invite(), waiting("approved")) }, { seat: "subject", inviteId: "invite-1",
    inviteExpiresAtMs: NOW + HOUR, waitingRequestId: "wait-1", waitingPending: false });
  assert.deepEqual([legacyWritePins("vacant", invite(iso(0)), null).inviteExpiresAtMs, legacyWritePins("vacant", null, waiting("pending")).waitingPending], [null, true]);
});

test("an unwritten receipt is frozen, carries the store's own fresh clones and never stands for a write", () => {
  let cloned = 0;
  const clone = () => { cloned += 1; return structuredClone(FRESH) as LegacyRoomCredentialSnapshot; };
  const plain = unwrittenLegacyReceipt({ kind: "refused", reason: "invite_revoked", accessRequestId: null }, clone);
  const named = unwrittenLegacyReceipt({ kind: "refused", reason: "waiting_room_rejected", accessRequestId: "wait-1" }, clone);
  assert.deepEqual([plain, Object.hasOwn(plain, "accessRequestId"), named], [{ kind: "refused", status: 403, reason: "invite_revoked", fresh: FRESH }, false,
    { kind: "refused", status: 403, reason: "waiting_room_rejected", fresh: FRESH, accessRequestId: "wait-1" }]);
  const quiet: LegacyWriteIntent[] = [{ kind: "host_current" }, { kind: "pending_current", accessRequestId: "wait-1" }, { kind: "changed" }];
  const receipts = quiet.map(next => unwrittenLegacyReceipt(next, clone));
  assert.deepEqual(receipts, [{ kind: "host_ready" }, { kind: "pending", accessRequestId: "wait-1", created: false }, { kind: "changed" }]);
  assert.equal(cloned, 2, "only a refusal reads fresh clones");
  for (const receipt of [plain, named, ...receipts]) assert.equal(Object.isFrozen(receipt), true);
  const writes: LegacyWriteIntent[] = [{ kind: "set_host" }, { kind: "insert_pending", inviteId: "invite-1" }];
  for (const next of writes) assert.equal(code(() => unwrittenLegacyReceipt(next, clone)), PLAN);
});
