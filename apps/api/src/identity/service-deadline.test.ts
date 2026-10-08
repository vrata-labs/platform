import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createRoomIdentityCodec } from "@vrata/shared-types/identity-credential";
import { createRoomSessionV2Codec } from "@vrata/shared-types/room-session-v2";
import { MemoryStorage } from "../storage.js";
import { createRoomIdentityService } from "./service.js";
import { IdentityStorageError, type RoomIdentityMutationProof, type RoomIdentityScope, type RoomIdentityStorage } from "./contracts.js";

const secret = "test-only-identity-root-secret-32-bytes-minimum";
const S0 = 1_800_000_000;
const deadlineSeconds = S0 + 30;
const deadlineMs = deadlineSeconds * 1000;
type Tokens = { ri2: string; rs2: string };
type Outcome = { participantId: string; issuedAtSeconds?: number; sessionId?: string; expiresAtSeconds?: number } | null;
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  let ms = S0 * 1000, samples = Infinity;
  const now = () => {
    if (samples-- <= 0) throw new Error("clock resampled after the final live sample");
    return ms;
  };
  const memory = new MemoryStorage(() => ms);
  const roomId = randomUUID();
  const room = await memory.createRoom({ roomId, tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Deadline",
    roomType: "standard", ownerParticipantId: null, sessionControl: { hostParticipantId: null } });
  const scope: RoomIdentityScope = { tenantId: room.tenantId, roomId };
  const ids = memory.roomIdentities;
  const identity = await ids.create({ ...scope, displayName: "Deadline fixture", baseRole: "member",
    provenance: { kind: "invite", inviteId: "server-validated-invite", role: "member" } });
  const state = { resolveCalls: 0, widen: false };
  let gate: { reached: () => void; resume: Promise<void> } | null = null;
  const storage: RoomIdentityStorage = { ...ids, async resolve(proof) {
    state.resolveCalls++;
    if (state.widen) Object.assign(proof, { expiresAtSeconds: S0 + 86_400 });
    if (gate) { gate.reached(); await gate.resume; }
    return ids.resolve(proof);
  } };
  const ri2Codec = createRoomIdentityCodec(secret), rs2Codec = createRoomSessionV2Codec(secret);
  const sessionId = randomUUID();
  const lifetime = (short: boolean) => short ? 30 : 60;
  return {
    scope, identity, sessionId, state, service: createRoomIdentityService(storage, secret, now),
    at(nextMs: number) { ms = nextMs; },
    revoke: () => ids.revoke(scope, identity.identityId, identity.authEpoch),
    tokens(short: "ri2" | "rs2", proof = identity): Tokens {
      return { ri2: ri2Codec.sign(proof, { nowSeconds: S0, lifetimeSeconds: lifetime(short === "ri2") }),
        rs2: rs2Codec.sign(proof, { nowSeconds: S0, lifetimeSeconds: lifetime(short === "rs2"), sessionId }) };
    },
    decode(token: string) {
      const seconds = Math.floor(ms / 1000);
      const claims = ri2Codec.verify(token, scope, seconds) ?? rs2Codec.verify(token, scope, seconds);
      assert.ok(claims, "issued token verifies at the final sample");
      return { issuedAtSeconds: claims.issuedAtSeconds, sessionId: "sessionId" in claims ? claims.sessionId : undefined };
    },
    async resolveAt(call: () => Promise<Outcome>, postReadMs: number): Promise<Outcome> {
      ms = S0 * 1000;
      let reached!: () => void, resume!: () => void;
      const entered = new Promise<void>(resolve => { reached = resolve; });
      gate = { reached, resume: new Promise<void>(resolve => { resume = resolve; }) };
      const pending = call();
      await Promise.race([entered, pending.then(() => undefined, () => undefined)]);
      ms = postReadMs; samples = 1; resume();
      try { return await pending; } finally { gate = null; samples = Infinity; }
    }
  };
}

type Entry = { name: string; nullable?: boolean; governs: ("ri2" | "rs2")[];
  run(f: Fixture, t: Tokens, scope?: RoomIdentityScope): Promise<Outcome> };
const refused = (entry: Entry, pending: Promise<Outcome>) => pending.then(outcome => entry.nullable === true && outcome === null, (error: unknown) => {
  if (!entry.nullable && error instanceof IdentityStorageError && error.code === "identity_not_active") return true;
  throw error;
});
const entries: Entry[] = [
  { name: "renewCredential", governs: ["ri2"], run: async (f, t, scope = f.scope) => {
    const { identity, credential } = await f.service.renewCredential(t.ri2, scope);
    return { participantId: identity.participantId, issuedAtSeconds: f.decode(credential).issuedAtSeconds };
  } },
  { name: "issueSession", governs: ["ri2"], run: async (f, t, scope = f.scope) => {
    const { identity, sessionToken } = await f.service.issueSession(t.ri2, scope);
    return { participantId: identity.participantId, issuedAtSeconds: f.decode(sessionToken).issuedAtSeconds };
  } },
  { name: "resolveCredential", nullable: true, governs: ["ri2"], run: async (f, t, scope = f.scope) => {
    const current = await f.service.resolveCredential(t.ri2, scope);
    return current && { participantId: current.identity.participantId };
  } },
  { name: "resolveSession", nullable: true, governs: ["rs2"], run: async (f, t, scope = f.scope) => {
    const current = await f.service.resolveSession(t.rs2, scope);
    return current && { participantId: current.identity.participantId, sessionId: current.sessionId, expiresAtSeconds: current.expiresAtSeconds };
  } },
  { name: "renewSession", governs: ["ri2", "rs2"], run: async (f, t, scope = f.scope) => {
    const renewed = await f.service.renewSession(t.rs2, t.ri2, scope);
    const signed = f.decode(renewed.sessionToken);
    assert.equal(renewed.sessionId, signed.sessionId, "returned and signed session ids agree");
    return { participantId: renewed.identity.participantId, issuedAtSeconds: signed.issuedAtSeconds, sessionId: signed.sessionId };
  } }
];

for (const entry of entries) for (const short of entry.governs) {
  test(`${entry.name} keeps the original ${short} deadline across a slow resolve`, async () => {
    const f = await fixture(), tokens = f.tokens(short);
    const run = () => entry.run(f, tokens);
    for (const lateMs of [deadlineMs, deadlineMs + 5_000]) {
      assert.equal(await refused(entry, f.resolveAt(run, lateMs)), true, `refused ${lateMs - deadlineMs}ms past original deadline`);
    }
    f.state.widen = true;
    assert.equal(await refused(entry, f.resolveAt(run, deadlineMs)), true, "storage cannot widen the original deadline");
    const widenedLive = await f.resolveAt(run, deadlineMs - 1);
    f.state.widen = false;
    const live = await f.resolveAt(run, deadlineMs - 1);
    for (const outcome of [widenedLive, live]) {
      assert.ok(outcome, "1ms before the deadline is still live");
      assert.equal(outcome.participantId, f.identity.participantId);
      if (outcome.issuedAtSeconds !== undefined) assert.equal(outcome.issuedAtSeconds, deadlineSeconds - 1);
      if (outcome.sessionId !== undefined) assert.equal(outcome.sessionId, f.sessionId);
      if (outcome.expiresAtSeconds !== undefined) assert.equal(outcome.expiresAtSeconds, deadlineSeconds);
    }
    f.at(deadlineMs);
    const calls = f.state.resolveCalls;
    assert.equal(await refused(entry, run()), true, "expired at entry");
    assert.equal(f.state.resolveCalls, calls, "expired entry never reaches storage");
  });
}

test("mis-scoped, wrong-purpose, forged, epoch-mismatched and revoked tokens stay refused", async () => {
  const f = await fixture(), tokens = f.tokens("ri2");
  for (const entry of entries) assert.ok(await entry.run(f, tokens), `${entry.name} accepts the live pair`);
  const forge = (token: string) => {
    const [prefix, body, signature] = token.split(".");
    return `${prefix}.${body}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  };
  const rotated = f.tokens("ri2", { ...f.identity, authEpoch: f.identity.authEpoch + 1 });
  const refusals: { label: string; tokens: Tokens; scope: RoomIdentityScope; reachesStorage: boolean }[] = [
    { label: "wrong scope", tokens, scope: { ...f.scope, roomId: randomUUID() }, reachesStorage: false },
    { label: "wrong purpose", tokens: { ri2: tokens.rs2, rs2: tokens.ri2 }, scope: f.scope, reachesStorage: false },
    { label: "bad MAC", tokens: { ri2: forge(tokens.ri2), rs2: forge(tokens.rs2) }, scope: f.scope, reachesStorage: false },
    { label: "epoch mismatch", tokens: rotated, scope: f.scope, reachesStorage: true }
  ];
  const expectRefused = async ({ label, tokens, scope, reachesStorage }: typeof refusals[number]) => {
    for (const entry of entries) {
      const calls = f.state.resolveCalls;
      assert.equal(await refused(entry, entry.run(f, tokens, scope)), true, `${entry.name}: ${label}`);
      assert.equal(f.state.resolveCalls > calls, reachesStorage, `${entry.name}: ${label} storage reach`);
    }
  };
  for (const refusal of refusals) await expectRefused(refusal);
  await f.revoke();
  await expectRefused({ label: "revoked old epoch", tokens, scope: f.scope, reachesStorage: true });
  await expectRefused({ label: "revoked rotated epoch", tokens: rotated, scope: f.scope, reachesStorage: true });
});

test("direct host mutations cannot fall back to an unbounded proof when its deadline is absent", async () => {
  const memory = new MemoryStorage(() => S0 * 1000);
  const room = await memory.createRoom({ name: "Required possession deadline" });
  const scope = { tenantId: room.tenantId, roomId: room.roomId }, ids = memory.roomIdentities;
  const host = await ids.create({ ...scope, displayName: "Host", baseRole: "member",
    provenance: { kind: "invite", inviteId: randomUUID(), role: "host" } });
  const target = await ids.create({ ...scope, displayName: "Target", baseRole: "member",
    provenance: { kind: "invite", inviteId: randomUUID(), role: "member" } });
  const denied = (error: unknown) => error instanceof IdentityStorageError && error.code === "identity_not_active";
  const missing = { ...host } as unknown as RoomIdentityMutationProof;
  const before = await ids.authority(scope);
  await assert.rejects(ids.claimHost(missing, 0), denied);
  assert.deepEqual(await ids.authority(scope), before);
  await ids.claimHost({ ...host, expiresAtSeconds: deadlineSeconds }, 0);
  const claimed = await ids.authority(scope);
  await assert.rejects(ids.transferHost(missing, target.identityId, 1), denied);
  assert.deepEqual(await ids.authority(scope), claimed);
  await ids.transferHost({ ...host, expiresAtSeconds: deadlineSeconds }, target.identityId, 1);
  assert.equal((await ids.authority(scope))?.hostIdentityId, target.identityId);
});
