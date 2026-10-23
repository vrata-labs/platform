import assert from "node:assert/strict";
import test from "node:test";
import { listReferenceTemplateVersionContracts } from "@vrata/templates";
import { signRoomSessionToken, type RoomSessionTokenPayload } from "@vrata/shared-types/session-token";
import type { RoomInviteRecord, RoomRecord, WaitingRoomRequestRecord } from "../storage-contracts.js";
import { templateVersionContentHash } from "../storage-room-records.js";
import {
  classifyLegacyBearer, confirmLegacyAdmission, evaluateLegacyAdmission, normalizeLegacyParticipant,
  type LegacyAdmissionConfirmation, type LegacyAdmissionContext, type LegacyAdmissionDecision, type LegacyAdmissionOutcome,
  type LegacyAdmissionRequest, type LegacyAdmissionSnapshot, type LegacyBearerClass
} from "./legacy-state-admission.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const SECRET = "legacy-admission-fixture-key";
const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const nowS = NOW / 1000;
const SCENE = "https://cdn.example.test/scene.glb";
const reference = listReferenceTemplateVersionContracts()[0];
const HASH = templateVersionContentHash(reference);
const CHANGED = "changed:409:room_state_changed";
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
const personal = (overrides: Partial<RoomRecord> = {}) => room({ roomType: "personal", ownerParticipantId: "owner-1", visibility: "private", ...overrides });
function invite(overrides: Partial<RoomInviteRecord> = {}): RoomInviteRecord {
  return { inviteId: "invite-1", roomId: "room-1", tokenHash: "hash-1", role: "member", protocolVersion: 1, waitingRoomEnabled: false,
    createdAt: iso(NOW - 60_000), expiresAt: iso(NOW + 3_600_000), ...overrides };
}
const waitingInvite = (overrides: Partial<RoomInviteRecord> = {}) => invite({ waitingRoomEnabled: true, ...overrides });
function waiting(status: WaitingRoomRequestRecord["status"], overrides: Partial<WaitingRoomRequestRecord> = {}): WaitingRoomRequestRecord {
  return { requestId: "wait-1", roomId: "room-1", inviteId: "invite-1", participantId: "p-1", displayName: "Pat", status, createdAt: iso(NOW - 30_000), ...overrides };
}
const snap = (r: RoomRecord, i: RoomInviteRecord | null = null, w: WaitingRoomRequestRecord | null = null): LegacyAdmissionSnapshot => ({ room: r, invite: i, waiting: w });
function req(overrides: Partial<LegacyAdmissionRequest> = {}): Mutable<LegacyAdmissionRequest> {
  return { mode: "admit", requestId: "req-1", explicitParticipantId: "p-1", participantId: "p-1", displayName: "Pat",
    requested: { role: "member", roleSource: "default" }, inviteTokenHash: null, ...overrides };
}
function ctx(overrides: Partial<LegacyAdmissionContext> = {}): Mutable<LegacyAdmissionContext> {
  return { rawBearer: null, secret: SECRET, nowMs: NOW, accessPolicyEnabled: true, hostControlsEnabled: true, ...overrides };
}
function bearer(overrides: Partial<RoomSessionTokenPayload> = {}, secret = SECRET): string {
  return signRoomSessionToken({ tenantId: "tenant-1", roomId: "room-1", participantId: "p-1", displayName: "Pat", role: "member", roleSource: "trusted",
    permissions: [], sessionId: "sess-1", iat: nowS - 60, exp: nowS + 600, jti: "jti-1", ...overrides }, secret);
}

// Scalar summaries keep credentials and whole records out of assertion diffs.
function summary(outcome: LegacyAdmissionOutcome): string {
  switch (outcome.kind) {
    case "admit": return `admit:${outcome.decision.role}:${outcome.decision.roleSource}:${outcome.decision.source.kind}`;
    case "deny": return `deny:${outcome.reason}:${outcome.inviteId ?? "-"}:${outcome.accessRequestId ?? "-"}`;
    case "session": return `session:${outcome.result.code}`;
    case "upgrade_required": return "upgrade_required";
    case "waiting": return `waiting:${outcome.inviteId}:${outcome.requestId ?? "-"}`;
  }
}
function confirmed(result: LegacyAdmissionConfirmation): string {
  if (result.ok) return `ok:${result.role}:${result.roleSource}:${result.templateContext?.contentHash === HASH ? "bound" : "unbound"}`;
  if (result.kind === "deny") return `deny:${result.status}:${result.reason}:${result.inviteId ?? "-"}:${result.accessRequestId ?? "-"}`;
  return result.kind === "session" ? `session:${result.result.code}` : `changed:${result.status}:${result.reason}`;
}
function admitted(outcome: LegacyAdmissionOutcome): LegacyAdmissionDecision {
  if (outcome.kind !== "admit") assert.fail(`expected admit, got ${summary(outcome)}`);
  return outcome.decision;
}

const TRUSTED = bearer();
const TRUSTED_GUEST = bearer({ role: "guest" });
const HOST_MAC = bearer({ role: "host" });
const DEFAULT_SOURCE = bearer({ roleSource: "default" });
const DEV_QUERY = bearer({ roleSource: "dev-query" });
const NO_ROLE_SOURCE = bearer({ roleSource: undefined, role: "host" });
const WRONG_KEY = bearer({}, "unrelated-fixture-key");
// The rotated-key probe reads the wall clock, so this proof stays unexpired on any run date.
const DEV_KEY = bearer({ exp: 4_102_444_800 }, "dev-state-secret");
const FOREIGN_ROOM = bearer({ roomId: "room-9" });
const EXPIRED_FOREIGN = bearer({ exp: nowS - 1, roomId: "room-9", tenantId: "tenant-9" });
const SHORT = bearer({ exp: nowS + 60 });

const invited: Partial<LegacyAdmissionRequest> = { inviteTokenHash: "hash-1" };
const owner: Partial<LegacyAdmissionRequest> = { explicitParticipantId: "owner-1", participantId: "owner-1" };
const renew: Partial<LegacyAdmissionRequest> = { mode: "renew" };
const otherGuest: Partial<LegacyAdmissionRequest> = { explicitParticipantId: "p-2", participantId: "p-2", requested: { role: "guest", roleSource: "default" } };
const hostOff: Partial<LegacyAdmissionContext> = { hostControlsEnabled: false };
const locked = { lockedAt: iso(NOW) };
const removed = { removedParticipants: { "p-1": { removedAt: iso(NOW) } } };

const admissions: Array<[string, Partial<LegacyAdmissionRequest>, LegacyAdmissionSnapshot, Partial<LegacyAdmissionContext>, string]> = [
  ["public room admits the requested default member", {}, snap(room()), {}, "admit:member:default:public"],
  ["unlisted room stays open under the access policy", {}, snap(room({ visibility: "unlisted" })), {}, "admit:member:default:public"],
  ["private room without an invite is denied", {}, snap(priv()), {}, "deny:invite_required:-:-"],
  ["captured access-policy-off keeps a private room open", {}, snap(priv()), { accessPolicyEnabled: false }, "admit:member:default:public"],
  ["private room denies a default-source MAC", {}, snap(priv()), { rawBearer: DEFAULT_SOURCE }, "deny:invite_required:-:-"],
  ["private room denies a dev-query MAC", {}, snap(priv()), { rawBearer: DEV_QUERY }, "deny:invite_required:-:-"],
  ["private default MAC is admitted only through a fresh invite", invited, snap(priv(), invite()), { rawBearer: DEFAULT_SOURCE }, "admit:member:trusted:invite"],
  ["private room admits a trusted guest MAC", {}, snap(priv()), { rawBearer: TRUSTED_GUEST }, "admit:guest:trusted:bearer"],
  ["personal owner is admitted as host", owner, snap(personal()), {}, "admit:host:trusted:personal_owner"],
  ["personal owner is independent of the access policy flag", owner, snap(personal()), { accessPolicyEnabled: false }, "admit:host:trusted:personal_owner"],
  ["personal owner is a member when another host is assigned", owner, snap(personal({ sessionControl: { hostParticipantId: "host-9" } })), {}, "admit:member:trusted:personal_owner"],
  ["personal non-owner needs an invite even with access policy off", {}, snap(personal()), { accessPolicyEnabled: false }, "deny:invite_required:-:-"],
  ["personal room keeps a trusted MAC for its own subject", {}, snap(personal()), { rawBearer: TRUSTED }, "admit:member:trusted:bearer"],
  ["missing invite record is invite_required", invited, snap(priv()), {}, "deny:invite_required:-:-"],
  ["mismatched invite hash is invite_required", { inviteTokenHash: "hash-x" }, snap(priv(), invite()), {}, "deny:invite_required:-:-"],
  ["invite for another room is invite_required", invited, snap(priv(), invite({ roomId: "room-2" })), {}, "deny:invite_required:-:-"],
  ["revoked invite is denied and named", invited, snap(priv(), invite({ revokedAt: iso(NOW - 1) })), {}, "deny:invite_revoked:invite-1:-"],
  ["unparseable invite expiry is expired", invited, snap(priv(), invite({ expiresAt: "never" })), {}, "deny:invite_expired:invite-1:-"],
  ["invite expiring exactly now is expired", invited, snap(priv(), invite({ expiresAt: iso(NOW) })), {}, "deny:invite_expired:invite-1:-"],
  ["protocol 2 invite requires upgrade", invited, snap(priv(), invite({ protocolVersion: 2 })), {}, "upgrade_required"],
  ["unversioned nonexpired invite is a trusted grant", invited, snap(priv(), invite({ protocolVersion: undefined })), {}, "admit:member:trusted:invite"],
  ["approved waiting request admits", invited, snap(priv(), waitingInvite(), waiting("approved")), {}, "admit:member:trusted:waiting_approved"],
  ["pending waiting request waits on its id", invited, snap(priv(), waitingInvite(), waiting("pending")), {}, "waiting:invite-1:wait-1"],
  ["rejected waiting request is denied with its id", invited, snap(priv(), waitingInvite(), waiting("rejected")), {}, "deny:waiting_room_rejected:invite-1:wait-1"],
  ["deleted waiting request waits without an id", invited, snap(priv(), waitingInvite()), {}, "waiting:invite-1:-"],
  ["approval for a foreign subject is ignored", invited, snap(priv(), waitingInvite(), waiting("approved", { participantId: "p-2" })), {}, "waiting:invite-1:-"],
  ["approval for another invite is ignored", invited, snap(priv(), waitingInvite(), waiting("approved", { inviteId: "invite-2" })), {}, "waiting:invite-1:-"],
  ["wrong-key MAC falls back to default public admission", {}, snap(room()), { rawBearer: WRONG_KEY }, "admit:member:default:public"],
  ["malformed bearer falls back to default public admission", {}, snap(room()), { rawBearer: "not-a-token" }, "admit:member:default:public"],
  ["unexpired foreign-room proof falls back to default public admission", {}, snap(room()), { rawBearer: FOREIGN_ROOM }, "admit:member:default:public"],
  ["rotated development-key proof requires upgrade", {}, snap(room()), { rawBearer: DEV_KEY }, "upgrade_required"],
  ["authentic expired foreign proof is a session failure", {}, snap(room()), { rawBearer: EXPIRED_FOREIGN }, "session:expired_token"],
  ["authentic expired proof is not rescued by a valid invite", invited, snap(priv(), invite()), { rawBearer: EXPIRED_FOREIGN }, "session:expired_token"],
  ["token without roleSource is normalized to default", {}, snap(room()), { rawBearer: NO_ROLE_SOURCE }, "admit:host:default:bearer"],
  ["token without roleSource is not trusted in a private room", {}, snap(priv()), { rawBearer: NO_ROLE_SOURCE }, "deny:invite_required:-:-"],
  ["explicit other subject never copies the MAC host role", otherGuest, snap(room()), { rawBearer: HOST_MAC }, "admit:guest:default:public"],
  ["renew keeps a trusted public proof", renew, snap(room()), { rawBearer: TRUSTED }, "admit:member:trusted:bearer"],
  ["renew of a default proof in a private room needs an invite", renew, snap(priv()), { rawBearer: DEFAULT_SOURCE }, "deny:invite_required:-:-"],
  ["renew without a bearer ignores a valid invite", { ...renew, ...invited }, snap(priv(), invite()), {}, "session:missing_token"],
  ["renew with a wrong-key MAC reports the codec failure", renew, snap(room()), { rawBearer: WRONG_KEY }, "session:invalid_signature"],
  ["renew for another explicit subject is a mismatch", { ...renew, ...otherGuest }, snap(room()), { rawBearer: TRUSTED }, "session:participant_mismatch"],
  ["ended session blocks even an existing proof", {}, snap(room({ sessionControl: { endedAt: iso(NOW) } })), { rawBearer: TRUSTED }, "deny:session_ended:-:-"],
  ["removed participant is blocked despite a proof", {}, snap(room({ sessionControl: removed })), { rawBearer: TRUSTED }, "deny:participant_removed:-:-"],
  ["locked room blocks a new member", {}, snap(room({ sessionControl: locked })), {}, "deny:room_locked:-:-"],
  ["locked room keeps an existing valid session", {}, snap(room({ sessionControl: locked })), { rawBearer: TRUSTED }, "admit:member:trusted:bearer"],
  ["locked room blocks a new invitee and names the invite", invited, snap(priv({ sessionControl: locked }), invite()), {}, "deny:room_locked:invite-1:-"],
  ["locked room admits the personal owner host", owner, snap(personal({ sessionControl: locked })), {}, "admit:host:trusted:personal_owner"],
  ["captured host-controls-off ignores end, removal and lock", {}, snap(room({ sessionControl: { endedAt: iso(NOW), ...locked, ...removed } })), hostOff, "admit:member:default:public"],
  ["disabled room denies despite host controls off", {}, snap(room({ status: "disabled" })), hostOff, "deny:room_disabled:-:-"],
  ["disabled room is denied before an expired proof is classified", {}, snap(room({ disabledAt: iso(NOW) })), { rawBearer: EXPIRED_FOREIGN }, "deny:room_disabled:-:-"]
];
for (const [name, request, snapshot, context, expected] of admissions) {
  test(`admission: ${name}`, () => assert.equal(summary(evaluateLegacyAdmission(req(request), snapshot, ctx(context))), expected));
}

const confirmations: Array<[string, Partial<LegacyAdmissionRequest>, LegacyAdmissionSnapshot, LegacyAdmissionSnapshot, Partial<LegacyAdmissionContext>, Partial<LegacyAdmissionContext>, string]> = [
  ["unchanged state confirms", {}, snap(room()), snap(room()), {}, {}, "ok:member:default:bound"],
  ["rename and theme are harmless metadata", {}, snap(room()), snap(room({ name: "Renamed", theme: { primaryColor: "#123456", accentColor: "#654321" } })), {}, {}, "ok:member:default:bound"],
  ["template id rebind", {}, snap(room()), snap(room({ templateId: "other-template" })), {}, {}, CHANGED],
  ["template version rebind", {}, snap(room()), snap(room({ templateVersion: "9.9.9" })), {}, {}, CHANGED],
  ["content hash rebind", {}, snap(room()), snap(room({ templateSnapshot: { ...room().templateSnapshot, description: "Rewritten scene contract" } })), {}, {}, CHANGED],
  ["scene url rebind", {}, snap(room()), snap(room({ sceneBundleUrl: "https://cdn.example.test/other.glb" })), {}, {}, CHANGED],
  ["scene url removal", {}, snap(room()), snap(room({ sceneBundleUrl: undefined })), {}, {}, CHANGED],
  ["public to private transition", {}, snap(room()), snap(priv()), {}, {}, "deny:403:invite_required:-:-"],
  ["session ended after the decision", {}, snap(room()), snap(room({ sessionControl: { endedAt: iso(NOW) } })), {}, {}, "deny:403:session_ended:-:-"],
  ["lock blocks a still-new admission", {}, snap(room()), snap(room({ sessionControl: locked })), {}, {}, "deny:403:room_locked:-:-"],
  ["lock preserves the existing session", {}, snap(room()), snap(room({ sessionControl: locked })), { rawBearer: TRUSTED }, { rawBearer: TRUSTED }, "ok:member:trusted:bound"],
  ["disable denies with host controls off", {}, snap(room()), snap(room({ status: "disabled" })), hostOff, hostOff, "deny:403:room_disabled:-:-"],
  ["host controls off ignores a later end", {}, snap(room()), snap(room({ sessionControl: { endedAt: iso(NOW) } })), hostOff, hostOff, "ok:member:default:bound"],
  ["presenter grant is not a silent upgrade", {}, snap(room()), snap(room({ sessionControl: { presenterParticipantId: "p-1" } })), {}, {}, CHANGED],
  ["host reassignment is not a silent downgrade", {}, snap(room({ sessionControl: { hostParticipantId: "p-1" } })), snap(room({ sessionControl: { hostParticipantId: "host-9" } })), {}, {}, CHANGED],
  ["unrelated host assignment keeps the member", {}, snap(room()), snap(room({ sessionControl: { hostParticipantId: "host-9" } })), {}, {}, "ok:member:default:bound"],
  ["proof expiring before the final context", {}, snap(room()), snap(room()), { rawBearer: SHORT }, { rawBearer: SHORT, nowMs: NOW + 60_000 }, "session:expired_token"],
  ["same captured proof confirms", {}, snap(room()), snap(room()), { rawBearer: TRUSTED }, { rawBearer: TRUSTED }, "ok:member:trusted:bound"],
  ["re-signed jti", {}, snap(room()), snap(room()), { rawBearer: TRUSTED }, { rawBearer: bearer({ jti: "jti-2" }) }, CHANGED],
  ["re-signed expiry", {}, snap(room()), snap(room()), { rawBearer: TRUSTED }, { rawBearer: bearer({ exp: nowS + 601 }) }, CHANGED],
  ["re-signed session id", {}, snap(room()), snap(room()), { rawBearer: TRUSTED }, { rawBearer: bearer({ sessionId: "sess-2" }) }, CHANGED],
  ["re-signed host role", {}, snap(room()), snap(room()), { rawBearer: TRUSTED }, { rawBearer: HOST_MAC }, CHANGED],
  ["approval reverted to pending is 202", invited, snap(priv(), waitingInvite(), waiting("approved")), snap(priv(), waitingInvite(), waiting("pending")), {}, {}, "deny:202:waiting_room_pending:invite-1:wait-1"],
  ["approved request deleted", invited, snap(priv(), waitingInvite(), waiting("approved")), snap(priv(), waitingInvite()), {}, {}, CHANGED],
  ["approval moved to a new request id", invited, snap(priv(), waitingInvite(), waiting("approved")), snap(priv(), waitingInvite(), waiting("approved", { requestId: "wait-2" })), {}, {}, CHANGED],
  ["approval rejected", invited, snap(priv(), waitingInvite(), waiting("approved")), snap(priv(), waitingInvite(), waiting("rejected")), {}, {}, "deny:403:waiting_room_rejected:invite-1:wait-1"],
  ["invite revoked after approval", invited, snap(priv(), waitingInvite(), waiting("approved")), snap(priv(), waitingInvite({ revokedAt: iso(NOW) }), waiting("approved")), {}, {}, "deny:403:invite_revoked:invite-1:-"],
  ["invite upgraded to protocol 2", invited, snap(priv(), invite()), snap(priv(), invite({ protocolVersion: 2 })), {}, {}, CHANGED]
];
for (const [name, request, first, fresh, before, after, expected] of confirmations) {
  test(`confirmation: ${name}`, () => {
    const decision = admitted(evaluateLegacyAdmission(req(request), first, ctx(before)));
    assert.equal(confirmed(confirmLegacyAdmission(decision, req(request), fresh, ctx(after))), expected);
  });
}

test("authentic expired proof classifies before scope while unexpired foreign scope is unusable", () => {
  const code = (c: LegacyBearerClass) => c.kind === "expired" || c.kind === "unusable" ? `${c.kind}:${c.result.code}` : c.kind;
  const classify = (rawBearer: string | null, nowMs = NOW, explicit: string | null = null) => code(classifyLegacyBearer(ctx({ rawBearer, nowMs }), room(), explicit));
  assert.equal(classify(EXPIRED_FOREIGN), "expired:expired_token");
  assert.equal(classify(FOREIGN_ROOM), "unusable:room_mismatch");
  assert.equal(classify(bearer({ tenantId: "tenant-9" })), "unusable:tenant_mismatch");
  assert.equal(classify(TRUSTED, (nowS + 600) * 1000 - 1), "valid");
  assert.equal(classify(TRUSTED, (nowS + 600) * 1000), "expired:expired_token");
  assert.equal(classify(TRUSTED, NOW, "p-2"), "unusable:participant_mismatch");
  assert.equal(classify(DEV_KEY), "rotated_dev");
  assert.equal(classify(null), "absent");
});

test("a genuinely signed proof whose subject no selector can hold is invalid_payload and never copies its role", () => {
  const fresh: Partial<LegacyAdmissionRequest> = { explicitParticipantId: null, participantId: "minted-1" };
  for (const participantId of ["p".repeat(201), "p\u0000id", "p\nid"]) {
    const rawBearer = bearer({ participantId, role: "host" });
    const classified = classifyLegacyBearer(ctx({ rawBearer }), room(), null);
    assert.equal(classified.kind === "unusable" && classified.result.code, "invalid_payload");
    assert.equal(normalizeLegacyParticipant(null, classified, () => "minted-1"), "minted-1");
    assert.equal(summary(evaluateLegacyAdmission(req(fresh), snap(room()), ctx({ rawBearer }))), "admit:member:default:public");
    assert.equal(summary(evaluateLegacyAdmission(req(fresh), snap(priv()), ctx({ rawBearer }))), "deny:invite_required:-:-");
    assert.equal(summary(evaluateLegacyAdmission(req({ ...fresh, ...renew }), snap(priv()), ctx({ rawBearer }))), "session:invalid_payload");
  }
  assert.equal(classifyLegacyBearer(ctx({ rawBearer: bearer({ participantId: "p".repeat(200) }) }), room(), null).kind, "valid");
});

test("omitted body ID reuses the valid proof subject and mints exactly once otherwise", () => {
  let minted = 0;
  const mint = () => `minted-${++minted}`;
  const valid = classifyLegacyBearer(ctx({ rawBearer: TRUSTED }), room(), null);
  assert.equal(normalizeLegacyParticipant(null, valid, mint), "p-1");
  assert.equal(normalizeLegacyParticipant("p-2", valid, mint), "p-2");
  assert.equal(minted, 0);
  for (const [index, rawBearer] of [null, WRONG_KEY, FOREIGN_ROOM].entries()) {
    assert.equal(normalizeLegacyParticipant(null, classifyLegacyBearer(ctx({ rawBearer }), room(), null), mint), `minted-${index + 1}`);
  }
  assert.equal(minted, 3);
  const decision = admitted(evaluateLegacyAdmission(req({ explicitParticipantId: null }), snap(room()), ctx({ rawBearer: TRUSTED })));
  assert.deepEqual([decision.participantId, decision.source.kind], ["p-1", "bearer"]);
});

test("admitted decision is deeply frozen with exact non-secret facts", () => {
  const decision = admitted(evaluateLegacyAdmission(req(), snap(room()), ctx({ rawBearer: TRUSTED })));
  assert.deepEqual(decision, {
    requestId: "req-1", tenantId: "tenant-1", roomId: "room-1", participantId: "p-1", displayName: "Pat", role: "member", roleSource: "trusted",
    source: { kind: "bearer", jti: "jti-1", sessionId: "sess-1", originalExp: nowS + 600 },
    binding: { templateId: reference.templateId, templateVersion: reference.version, contentHash: HASH, sceneBundleUrl: SCENE }
  });
  for (const part of [decision, decision.source, decision.binding]) assert.equal(Object.isFrozen(part), true);
  assert.throws(() => { (decision as { role: string }).role = "host"; }, TypeError);
  assert.throws(() => { (decision.binding as { templateId: string }).templateId = "other"; }, TypeError);
});

test("mutating the captured request or bearer afterwards cannot widen the decision", () => {
  const request = req();
  const captured = ctx();
  const decision = admitted(evaluateLegacyAdmission(request, snap(room()), captured));
  request.requested = { role: "host", roleSource: "trusted" };
  captured.rawBearer = HOST_MAC;
  assert.deepEqual([decision.role, decision.roleSource, decision.source.kind], ["member", "default", "public"]);
  assert.equal(confirmed(confirmLegacyAdmission(decision, request, snap(room()), captured)), CHANGED);
});

test("confirmation refuses a decision replayed for another request, name, subject or room", () => {
  const decision = admitted(evaluateLegacyAdmission(req(), snap(room()), ctx()));
  const cases: Array<[string, LegacyAdmissionRequest, RoomRecord]> = [
    ["request id", req({ requestId: "req-2" }), room()], ["display name", req({ displayName: "Mallory" }), room()],
    ["participant", req({ explicitParticipantId: "p-2", participantId: "p-2" }), room()],
    ["tenant", req(), room({ tenantId: "tenant-2" })], ["room", req(), room({ roomId: "room-2" })]
  ];
  for (const [label, request, fresh] of cases) assert.equal(confirmed(confirmLegacyAdmission(decision, request, snap(fresh), ctx())), CHANGED, label);
});
