import assert from "node:assert/strict";
import test from "node:test";
import { listReferenceTemplateVersionContracts } from "@vrata/templates";
import { signRoomSessionToken, type RoomSessionTokenPayload } from "@vrata/shared-types/session-token";
import type { RoomInviteRecord, RoomRecord, WaitingRoomRequestRecord } from "../storage-contracts.js";
import { evaluateLegacyAdmission, type LegacyAdmissionContext, type LegacyAdmissionRequest, type LegacyAdmissionSnapshot } from "./legacy-state-admission.js";
import {
  assertLegacyAdmissionPlanDeadlines, assertLegacyDeadline, decideLegacyAdmissionWrite, LegacyAdmissionDeadlineExpired, LegacyAdmissionWriteInvariant,
  narrowLegacyDeadline, planLegacyAdmissionWrite, type LegacyAdmissionDeadline, type LegacyAdmissionWritePlan
} from "./legacy-admission-write.js";

const SECRET = "legacy-write-fixture-key";
const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const nowS = NOW / 1000;
const HOUR = 3_600_000;
const SCENE = "https://cdn.example.test/scene.glb";
const reference = listReferenceTemplateVersionContracts()[0];
const iso = (ms: number) => new Date(ms).toISOString();

function room(overrides: Partial<RoomRecord> = {}): RoomRecord {
  const features = { voice: true, spatialAudio: true, screenShare: true };
  const theme = { primaryColor: "#000000", accentColor: "#ffffff" };
  return {
    roomId: "room-1", tenantId: "tenant-1", templateId: reference.templateId, templateVersion: reference.version,
    templateSnapshot: { ...structuredClone(reference), roomConfig: {
      roomType: "standard", visibility: "public", guestAllowed: true, sceneBundleUrl: SCENE, features, theme,
      avatarConfig: { avatarsEnabled: true, avatarQualityProfile: "desktop-standard", avatarFallbackCapsulesEnabled: true }
    } },
    name: "Room", visibility: "public", sceneBundleUrl: SCENE, features, theme, assetIds: [], ...overrides
  };
}
const priv = (overrides: Partial<RoomRecord> = {}) => room({ visibility: "private", ...overrides });
const personal = () => room({ roomType: "personal", ownerParticipantId: "owner-1", visibility: "private" });
const invite = (overrides: Partial<RoomInviteRecord> = {}): RoomInviteRecord => ({ inviteId: "invite-1", roomId: "room-1", tokenHash: "hash-1",
  role: "member", protocolVersion: 1, waitingRoomEnabled: true, createdAt: iso(NOW - 60_000), expiresAt: iso(NOW + HOUR), ...overrides });
const directHost = (overrides: Partial<RoomInviteRecord> = {}) => invite({ role: "host", waitingRoomEnabled: false, ...overrides });
const waiting = (status: WaitingRoomRequestRecord["status"], overrides: Partial<WaitingRoomRequestRecord> = {}): WaitingRoomRequestRecord => ({
  requestId: "wait-1", roomId: "room-1", inviteId: "invite-1", participantId: "p-1", displayName: "Pat", status, createdAt: iso(NOW - 30_000), ...overrides });
const snap = (r: RoomRecord, i: RoomInviteRecord | null = null, w: WaitingRoomRequestRecord | null = null): LegacyAdmissionSnapshot => ({ room: r, invite: i, waiting: w });
const req = (overrides: Partial<LegacyAdmissionRequest> = {}): LegacyAdmissionRequest => ({ mode: "admit", requestId: "req-1", explicitParticipantId: "p-1",
  participantId: "p-1", displayName: "Pat", requested: { role: "member", roleSource: "default" }, inviteTokenHash: null, ...overrides });
const ctx = (overrides: Partial<LegacyAdmissionContext> = {}): LegacyAdmissionContext => ({ rawBearer: null, secret: SECRET, nowMs: NOW,
  accessPolicyEnabled: true, hostControlsEnabled: true, ...overrides });
const bearer = (overrides: Partial<RoomSessionTokenPayload> = {}) => signRoomSessionToken({ tenantId: "tenant-1", roomId: "room-1", participantId: "p-1",
  displayName: "Pat", role: "host", roleSource: "trusted", permissions: [], sessionId: "sess-1", iat: nowS - 60, exp: nowS + 600, jti: "jti-1", ...overrides }, SECRET);

const MAC = { rawBearer: bearer() };
const invited: Partial<LegacyAdmissionRequest> = { inviteTokenHash: "hash-1" };
const owner: Partial<LegacyAdmissionRequest> = { explicitParticipantId: "owner-1", participantId: "owner-1" };
const seat = (hostParticipantId: string) => ({ sessionControl: { hostParticipantId } });
const locked = { sessionControl: { lockedAt: iso(NOW) } };
const ended = { sessionControl: { endedAt: iso(NOW) } };
const removed = { sessionControl: { removedParticipants: { "p-1": { removedAt: iso(NOW) } } } };

function plan(request: LegacyAdmissionRequest, initial: LegacyAdmissionSnapshot, c: LegacyAdmissionContext): LegacyAdmissionWritePlan | null {
  return planLegacyAdmissionWrite(evaluateLegacyAdmission(request, initial, c), request, initial, c);
}
// Scalar summaries keep credentials and whole records out of assertion diffs.
function decide(p: LegacyAdmissionWritePlan | null, request: LegacyAdmissionRequest, fresh: LegacyAdmissionSnapshot, c: LegacyAdmissionContext): string {
  if (!p) return "no_plan";
  try {
    const d = decideLegacyAdmissionWrite(p, request, fresh, c);
    if (d.write === "refuse") return `refuse:${d.reason}:${d.accessRequestId ?? "-"}`;
    return d.write === "none_pending" ? `none_pending:${d.accessRequestId}` : d.write;
  } catch (error) {
    if (error instanceof LegacyAdmissionDeadlineExpired) return `expired:${error.kind}`;
    throw error;
  }
}
function lapse(p: LegacyAdmissionWritePlan | null, nowMs: number): string {
  if (!p) return "no_plan";
  try {
    assertLegacyAdmissionPlanDeadlines(p, nowMs);
    return "live";
  } catch (error) {
    if (error instanceof LegacyAdmissionDeadlineExpired) return `expired:${error.kind}`;
    throw error;
  }
}

const cases: Array<[string, Partial<LegacyAdmissionRequest>, LegacyAdmissionSnapshot, Partial<LegacyAdmissionContext>, LegacyAdmissionSnapshot, Partial<LegacyAdmissionContext>, string]> = [
  ["trusted MAC host claims a vacant seat", {}, snap(room()), MAC, snap(room()), {}, "set_host"],
  ["empty-string host is vacant", {}, snap(room(seat(""))), MAC, snap(room(seat(""))), {}, "set_host"],
  ["subject already seated is a no-op", {}, snap(room()), MAC, snap(room(seat("p-1"))), {}, "none_host_current"],
  ["another host seated first", {}, snap(room()), MAC, snap(room(seat("host-9"))), {}, "changed"],
  ["ended session refuses the claim", {}, snap(room()), MAC, snap(room(ended)), {}, "refuse:session_ended:-"],
  ["removed subject refuses the claim", {}, snap(room()), MAC, snap(room(removed)), {}, "refuse:participant_removed:-"],
  ["disabled room refuses with host controls off", {}, snap(room()), { ...MAC, hostControlsEnabled: false }, snap(room({ status: "disabled" })), {}, "refuse:room_disabled:-"],
  ["bearer lease lapses at the signed expiry", {}, snap(room()), MAC, snap(room()), { nowMs: (nowS + 600) * 1000 }, "expired:bearer"],
  ["re-signed proof is drift", {}, snap(room()), MAC, snap(room()), { rawBearer: bearer({ jti: "jti-2" }) }, "changed"],
  ["template rebind is drift for a claim", {}, snap(room()), MAC, snap(room({ templateVersion: "9.9.9" })), {}, "changed"],
  ["default-source host never plans a claim", { requested: { role: "host", roleSource: "default" } }, snap(room()), {}, snap(room()), {}, "no_plan"],
  ["seated initial host plans nothing", {}, snap(room(seat("p-1"))), MAC, snap(room()), {}, "no_plan"],
  ["claim invite lease ignores an extension", invited, snap(priv(), directHost()), {}, snap(priv(), directHost({ expiresAt: iso(NOW + 2 * HOUR) })), { nowMs: NOW + HOUR }, "refuse:invite_expired:-"],
  ["claim invite revoked", invited, snap(priv(), directHost()), {}, snap(priv(), directHost({ revokedAt: iso(NOW) })), {}, "refuse:invite_revoked:-"],
  ["personal owner claim carries no lease", owner, snap(personal()), {}, snap(personal()), { nowMs: NOW + 10 * HOUR }, "set_host"],
  ["first pending request is inserted", invited, snap(priv(), invite()), {}, snap(priv(), invite()), {}, "insert_pending"],
  ["concurrent pending row is reused", invited, snap(priv(), invite()), {}, snap(priv(), invite(), waiting("pending")), {}, "none_pending:wait-1"],
  ["existing pending row stays", invited, snap(priv(), invite(), waiting("pending")), {}, snap(priv(), invite(), waiting("pending")), {}, "none_pending:wait-1"],
  ["deleted pending row is never revived", invited, snap(priv(), invite(), waiting("pending")), {}, snap(priv(), invite()), {}, "changed"],
  ["replaced pending row", invited, snap(priv(), invite(), waiting("pending")), {}, snap(priv(), invite(), waiting("pending", { requestId: "wait-2" })), {}, "changed"],
  ["approval is never a hidden grant", invited, snap(priv(), invite(), waiting("pending")), {}, snap(priv(), invite(), waiting("approved")), {}, "changed"],
  ["rejection names its row", invited, snap(priv(), invite(), waiting("pending")), {}, snap(priv(), invite(), waiting("rejected")), {}, "refuse:waiting_room_rejected:wait-1"],
  ["pending invite revoked", invited, snap(priv(), invite()), {}, snap(priv(), invite({ revokedAt: iso(NOW) })), {}, "refuse:invite_revoked:-"],
  ["pending invite lease ignores an extension", invited, snap(priv(), invite()), {}, snap(priv(), invite({ expiresAt: iso(NOW + 2 * HOUR) })), { nowMs: NOW + HOUR }, "refuse:invite_expired:-"],
  ["locked room gets no pending row", invited, snap(priv(), invite()), {}, snap(priv(locked), invite()), {}, "refuse:room_locked:-"],
  ["ended session gets no pending row", invited, snap(priv(), invite()), {}, snap(priv(ended), invite()), {}, "refuse:session_ended:-"],
  ["removed subject gets no pending row", invited, snap(priv(), invite()), {}, snap(priv(removed), invite()), {}, "refuse:participant_removed:-"],
  ["captured host-controls-off ignores the lock", invited, snap(priv(), invite()), { hostControlsEnabled: false }, snap(priv(locked), invite()), {}, "insert_pending"],
  ["waiting flag cleared is drift", invited, snap(priv(), invite()), {}, snap(priv(), invite({ waitingRoomEnabled: false })), {}, "changed"],
  ["invite upgraded to protocol 2", invited, snap(priv(), invite()), {}, snap(priv(), invite({ protocolVersion: 2 })), {}, "changed"],
  ["template rebind is drift for a pending row", invited, snap(priv(), invite()), {}, snap(priv({ templateVersion: "9.9.9" }), invite()), {}, "changed"]
];
for (const [name, request, initial, before, fresh, after, expected] of cases) {
  test(`write: ${name}`, () => {
    const r = req(request);
    assert.equal(decide(plan(r, initial, ctx(before)), r, fresh, ctx({ ...before, ...after })), expected);
  });
}

test("deadlines narrow only downward and are checked against the caller's instant", () => {
  const inv = (expiresAtMs: number): LegacyAdmissionDeadline => ({ kind: "invite", expiresAtMs });
  const lease: LegacyAdmissionDeadline = { kind: "bearer", expiresAtMs: NOW + 1000 };
  assert.deepEqual(narrowLegacyDeadline(inv(NOW + HOUR), inv(NOW + 2 * HOUR)), inv(NOW + HOUR));
  assert.deepEqual(narrowLegacyDeadline(inv(NOW + HOUR), inv(NOW + 60_000)), inv(NOW + 60_000));
  assert.equal(narrowLegacyDeadline(null, null), null);
  const bad: Array<[LegacyAdmissionDeadline | null, LegacyAdmissionDeadline | null]> = [[inv(NOW), null], [null, inv(NOW)], [inv(NOW), lease], [inv(NOW), inv(Number.MAX_SAFE_INTEGER + 2)]];
  for (const [a, b] of bad) assert.throws(() => narrowLegacyDeadline(a, b), LegacyAdmissionWriteInvariant);
  assertLegacyDeadline(lease, NOW + 999);
  assertLegacyDeadline(null, NOW);
  assert.throws(() => assertLegacyDeadline(lease, NOW + 1000),
    (error: unknown) => error instanceof LegacyAdmissionDeadlineExpired && error.kind === "bearer" && error.message === "legacy_admission_deadline_expired");
  for (const nowMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => assertLegacyDeadline(null, nowMs), LegacyAdmissionWriteInvariant);
  for (const expiresAtMs of [0, -5, 1.5, Number.NaN]) assert.throws(() => assertLegacyDeadline(inv(expiresAtMs), NOW), LegacyAdmissionWriteInvariant);
});

test("plans are deep-frozen copies detached from the pool snapshot", () => {
  const selected = invite();
  const initial = snap(priv(), selected, waiting("pending"));
  const pending = plan(req(invited), initial, ctx());
  if (pending?.mode !== "pending") return assert.fail("expected a pending plan");
  selected.expiresAt = iso(NOW + 9 * HOUR);
  initial.room.templateVersion = "9.9.9";
  const { binding, ...rest } = pending.pending;
  assert.deepEqual(rest, { requestId: "req-1", participantId: "p-1", inviteId: "invite-1", inviteTokenHash: "hash-1", protocolVersion: 1,
    waitingRoomEnabled: true, existingRequestId: "wait-1" });
  assert.deepEqual([pending.displayName, pending.deadline, pending.presentedBearerDeadline, binding.templateVersion],
    ["Pat", { expiresAtMs: NOW + HOUR, kind: "invite" }, null, reference.version]);
  for (const part of [pending, pending.pending, binding, pending.deadline]) assert.equal(Object.isFrozen(part), true);
  const outcome = evaluateLegacyAdmission(req(), snap(room()), ctx(MAC));
  const host = planLegacyAdmissionWrite(outcome, req(), snap(room()), ctx(MAC));
  if (outcome.kind !== "admit" || host?.mode !== "claim_host") return assert.fail("expected a host claim");
  assert.notEqual(host.decision, outcome.decision);
  const signed = { expiresAtMs: (nowS + 600) * 1000, kind: "bearer" };
  assert.deepEqual([host.decision, host.deadline, host.presentedBearerDeadline], [outcome.decision, signed, signed]);
  for (const part of [host, host.decision, host.decision.source, host.decision.binding, host.presentedBearerDeadline]) assert.equal(Object.isFrozen(part), true);
});

test("a waiting outcome over anything but this room's legacy waiting invite is a wiring fault", () => {
  const waitingOutcome = { kind: "waiting", inviteId: "invite-1", requestId: null } as const;
  for (const tampered of [invite({ protocolVersion: 2 }), invite({ waitingRoomEnabled: false }), invite({ roomId: "room-2" }), invite({ tokenHash: "hash-x" })]) {
    assert.throws(() => planLegacyAdmissionWrite(waitingOutcome, req(invited), snap(priv(), tampered), ctx()), LegacyAdmissionWriteInvariant);
  }
  assert.throws(() => planLegacyAdmissionWrite({ ...waitingOutcome, requestId: "wait-1" }, req(invited), snap(priv(), invite()), ctx()), LegacyAdmissionWriteInvariant);
  assert.throws(() => planLegacyAdmissionWrite(waitingOutcome, req({ ...invited, mode: "renew" }), snap(priv(), invite()), ctx()), LegacyAdmissionWriteInvariant);
});

test("a pending plan never writes or answers for another API request or subject on its invite", () => {
  const replays = [req(invited), req({ ...invited, requestId: "req-2" }), req({ ...invited, explicitParticipantId: "p-2", participantId: "p-2" })];
  const fresh = plan(req(invited), snap(priv(), invite()), ctx());
  const states = [snap(priv(), invite()), snap(priv(), invite(), waiting("pending", { requestId: "wait-2", participantId: "p-2" }))];
  assert.deepEqual(states.map((s) => replays.map((r) => decide(fresh, r, s, ctx()))),
    [["insert_pending", "changed", "changed"], ["insert_pending", "changed", "changed"]]);
  const held = plan(req(invited), snap(priv(), invite(), waiting("pending")), ctx());
  assert.deepEqual(replays.map((r) => decide(held, r, snap(priv(), invite(), waiting("pending")), ctx())), ["none_pending:wait-1", "changed", "changed"]);
});

test("a presented MAC's signed expiry bounds a fresh-invite plan without lending its role or subject", () => {
  const soon: LegacyAdmissionDeadline = { kind: "bearer", expiresAtMs: NOW + 1000 };
  const guest = bearer({ role: "member", roleSource: "default", exp: nowS + 1 });
  const foreign = bearer({ roomId: "room-2", participantId: "p-9", exp: nowS + 1 });
  const presented: Array<[string, LegacyAdmissionSnapshot, string, string]> = [
    ["default guest MAC beside a waiting invite", snap(priv(), invite()), guest, "insert_pending"],
    ["default guest MAC beside a direct host invite", snap(priv(), directHost()), guest, "set_host"],
    ["foreign trusted host MAC beside a waiting invite", snap(priv(), invite()), foreign, "insert_pending"]
  ];
  for (const [name, initial, rawBearer, live] of presented) {
    const p = plan(req(invited), initial, ctx({ rawBearer }));
    if (!p) return assert.fail(name);
    assert.deepEqual([p.deadline, p.presentedBearerDeadline, Object.isFrozen(p.presentedBearerDeadline)],
      [{ kind: "invite", expiresAtMs: NOW + HOUR }, soon, true], name);
    if (p.mode === "claim_host") assert.equal(p.decision.source.kind, "invite", name);
    assert.deepEqual([lapse(p, NOW + 999), lapse(p, NOW + 1000)], ["live", "expired:bearer"], name);
    assert.deepEqual([decide(p, req(invited), initial, ctx({ rawBearer, nowMs: NOW + 999 })),
      decide(p, req(invited), initial, ctx({ rawBearer, nowMs: NOW + 1000 }))], [live, "expired:bearer"], name);
  }
});

test("only a MAC-verified bearer lends a lease, and an authentic expired one is never planned", () => {
  const forged = (exp: number) => `${bearer({ exp }).split(".")[0]}.forged`;
  for (const rawBearer of [forged(nowS + 1), forged(nowS - 60), "not-a-token"]) {
    const p = plan(req(invited), snap(priv(), invite()), ctx({ rawBearer }));
    assert.deepEqual([p?.mode, p?.presentedBearerDeadline, lapse(p, NOW + HOUR - 1)], ["pending", null, "live"]);
  }
  const stale = ctx({ rawBearer: bearer({ exp: nowS }) });
  assert.equal(plan(req(invited), snap(priv(), invite()), stale), null);
  assert.throws(() => planLegacyAdmissionWrite({ kind: "waiting", inviteId: "invite-1", requestId: null }, req(invited), snap(priv(), invite()), stale),
    (error: unknown) => error instanceof LegacyAdmissionDeadlineExpired && error.kind === "bearer");
});

test("the earliest lapsed lease answers, and a tie is the bearer's", () => {
  const initial = snap(priv(), invite({ expiresAt: iso(NOW + 1000) }));
  const rows: Array<[number, string, string]> = [[nowS + 2, "expired:invite", "refuse:invite_expired:-"], [nowS + 1, "expired:bearer", "expired:bearer"]];
  for (const [exp, lapsed, answer] of rows) {
    const c = ctx({ rawBearer: bearer({ role: "member", roleSource: "default", exp }) });
    const p = plan(req(invited), initial, c);
    assert.deepEqual([lapse(p, NOW + 2000), decide(p, req(invited), initial, { ...c, nowMs: NOW + 2000 })], [lapsed, answer]);
  }
});

test("refusals and lapsed leases never echo the bearer or secret", () => {
  const p = plan(req(), snap(room()), ctx(MAC));
  if (!p) return assert.fail("expected a host claim");
  const thrown = (() => { try { decideLegacyAdmissionWrite(p, req(), snap(room()), ctx({ ...MAC, nowMs: (nowS + 600) * 1000 })); } catch (error) { return error; } })();
  assert.ok(thrown instanceof LegacyAdmissionDeadlineExpired);
  const refusal = decideLegacyAdmissionWrite(p, req(), snap(room({ status: "disabled" })), ctx(MAC));
  for (const text of [JSON.stringify(refusal), JSON.stringify(thrown), String(thrown), thrown.stack ?? ""]) {
    for (const secret of [MAC.rawBearer, SECRET]) assert.equal(text.includes(secret), false);
  }
});
