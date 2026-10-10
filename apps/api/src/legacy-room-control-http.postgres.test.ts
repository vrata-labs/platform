import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { verifyRoomSessionToken } from "@vrata/shared-types/session-token";
import { AUTHOR_HTTP_SECRET, authorHttpBearer, startAuthorHttpFixture, until, type AuthorHttpResponse } from "./plugins/author-http.test-helper.js";

const postgres = { skip: !process.env.VRATA_TEST_POSTGRES_URL && !process.env.CI, timeout: 300_000 };
const LONG_TENANT = `room-control-${"t".repeat(188)}`;
const ADMIN = "control-plane-admin";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNAVAILABLE = JSON.stringify({ error: "identity_authority_unavailable", reason: "identity_authority_unavailable" });
const UPGRADE = { error: "identity_required", reason: "identity_upgrade_required" };
const CHANGED = { error: "room_state_changed", reason: "room_state_changed" };
const STATE_KEYS = ["hostParticipantId", "presenterParticipantId", "presenterGrantedAt", "presenterGrantedBy", "presenterRevokedAt",
  "presenterRevokedBy", "lockedAt", "lockedBy", "endedAt", "endedBy", "removedParticipants"];
const GHOST = { removedAt: "fixture-raw", removedBy: "fixture-raw", reason: null, fixtureExtra: 1 };
const REVOKE: readonly string[] = ["presenterParticipantId", "presenterRevokedAt", "presenterRevokedBy"];
type Command = "lock" | "unlock" | "end" | "remove" | "grant" | "revoke" | "transfer";
/** The only keys each command may write; every other raw key must survive byte-for-byte. */
const WRITES: Record<Command, readonly string[]> = { lock: ["lockedAt", "lockedBy"], unlock: ["lockedAt", "lockedBy"],
  end: ["endedAt", "endedBy", ...REVOKE], remove: ["removedParticipants", ...REVOKE], grant: [...REVOKE, "presenterGrantedAt", "presenterGrantedBy"],
  revoke: REVOKE, transfer: ["hostParticipantId", ...REVOKE] };
const HOST = (action: string) => `vrata_host_actions_total{action="${action}",result="allowed"}`;
const PRESENTER = (action: string) => `vrata_presenter_changes_total{action="${action}",result="allowed"}`;
const SERIES = /^(?:(?:vrata_host_actions_total|vrata_presenter_changes_total)\{[^}]*\}|vrata_room_locked_total|vrata_participants_removed_total|vrata_sessions_ended_total) /;
type Fixture = Awaited<ReturnType<typeof startAuthorHttpFixture>>;
type Bag = Record<string, unknown>;
type Counters = Record<string, number>;
type Hold = "legacy-control-entry" | "control-written" | "admission-write" | "admission-written";
interface Mac { token: string; participantId: string; exp: number; role: unknown; roleSource: unknown }
interface Raw { text: string; control: Bag; columns: Bag }

/** Settles to true once the reply arrives; never rejects. */
function watch(response: Promise<AuthorHttpResponse>): () => boolean {
  let done = false; void response.then(() => { done = true; }, () => { done = true; }); return () => done;
}

/** Native HTTP vocabulary for the seven guarded floor-1 session-control routes. Every token comes from the real issuer and is
 * MAC-verified; assertions read statuses, fixed bodies, canonical counters and private fixture rows, never a raw token. */
function controls(h: Fixture) {
  const stem = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}`;
  const held = new Set<string>();
  async function createRoom(tenantId = "demo-tenant") {
    const roomId = randomUUID();
    const response = await h.request("/api/rooms", "POST", h.adminHeaders, { roomId, tenantId, templateId: "meeting-room-basic",
      name: "Room control fixture", visibility: "public", guestAllowed: true });
    assert.equal(response.status, 201, "the room is created over HTTP"); return roomId;
  }
  const post = (body: Bag) => h.request("/api/tokens/state", "POST", {}, { displayName: "Control participant", ...body });
  function issued(response: AuthorHttpResponse, roomId: string): Mac {
    assert.equal(response.status, 200, `expected a floor-1 state token; received HTTP ${response.status}`);
    const token = String(response.json<Bag>().token), result = verifyRoomSessionToken(token, AUTHOR_HTTP_SECRET, { roomId });
    assert.equal(result.ok, true, `the issuer's MAC verifies: ${result.ok ? "ok" : result.code}`);
    const claims = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")) as Bag;
    return { token, participantId: String(claims.participantId), exp: Number(claims.exp), role: claims.role, roleSource: claims.roleSource };
  }
  async function host(roomId: string): Promise<Mac> {
    const participantId = randomUUID(), { inviteToken } = await h.invite(roomId, "host");
    const value = issued(await post({ roomId, participantId, inviteToken }), roomId);
    assert.deepEqual([value.participantId === participantId, value.role, value.roleSource], [true, "host", "trusted"], "a trusted host seat");
    return value;
  }
  const presence = (roomId: string, actor: Mac, method: "PUT" | "DELETE" = "PUT") => h.request(`${stem(roomId)}/presence/${actor.participantId}`,
    method, authorHttpBearer(actor.token), method === "PUT" ? { participantId: actor.participantId, displayName: "Control participant",
      updatedAt: new Date().toISOString() } : undefined);
  async function member(roomId: string, live = true): Promise<Mac> {
    const value = issued(await post({ roomId }), roomId);
    if (live) assert.equal((await presence(roomId, value)).status, 200, "real HTTP presence");
    return value;
  }
  async function present(roomId: string): Promise<string[]> {
    const response = await h.request(`${stem(roomId)}/presence`, "GET", h.adminHeaders); assert.equal(response.status, 200);
    return response.json<{ items: Array<{ participantId: string }> }>().items.map(item => item.participantId).sort();
  }
  function path(roomId: string, command: Command, target = "") {
    if (command === "remove") return `${stem(roomId)}/participants/${target}/remove`;
    if (command === "grant" || command === "revoke") return `${stem(roomId)}/presenters/${target}/${command}`;
    return command === "transfer" ? `${stem(roomId)}/host/transfer` : `${stem(roomId)}/session-control/${command}`;
  }
  const payload = (command: Command, target?: string) => command === "transfer" ? { participantId: target } : command === "remove" ? { reason: "fixture" } : {};
  /** The administrator token unless a floor-1 MAC actor is given; an explicit request ID is echoed by every refusal that carries one. */
  const send = (roomId: string, command: Command, target?: string, actor?: Mac, requestId?: string) => h.request(path(roomId, command, target), "POST",
    { ...(actor ? authorHttpBearer(actor.token) : h.adminHeaders), ...(requestId ? { "x-request-id": requestId } : {}) }, payload(command, target));
  async function ok(roomId: string, command: Command, target?: string, actor?: Mac) {
    const response = await send(roomId, command, target, actor);
    assert.equal(response.status, 200, `${command} must succeed; received HTTP ${response.status}`); return response.json<Bag>();
  }
  function refused(response: AuthorHttpResponse, status: number, error: string, reason?: string, requestId?: string) {
    assert.equal(response.status, status, `expected ${error}/${reason ?? "-"}; received HTTP ${response.status}`);
    assert.deepEqual(response.json(), { error, ...(reason === undefined ? {} : { reason }),
      ...(error === "forbidden" ? { permission: "room.session-control" } : {}), ...(requestId === undefined ? {} : { requestId }) });
  }
  function unavailable(response: AuthorHttpResponse) {
    assert.equal(response.status === 503 && response.bytes.toString("utf8") === UNAVAILABLE, true, `one fixed 503 (status ${response.status})`);
  }
  async function raw(roomId: string): Promise<Raw> {
    const row = (await h.pool.query(`select session_control::text as text, session_control as control, to_jsonb(r) - 'session_control' as columns
      from "${h.schema}".rooms r where room_id=$1`, [roomId])).rows[0];
    assert.ok(row, "the fixture room exists"); return row as Raw;
  }
  /** Fixture-only: raw values no API path writes; every guarded merge must keep them verbatim. */
  const spare = (roomId: string) => h.pool.query(`update "${h.schema}".rooms set session_control = session_control || jsonb_build_object(
    'fixtureSpare', '{"kept":true}'::jsonb, 'removedParticipants', jsonb_build_object('ghost-fixture', $2::jsonb)) where room_id=$1`, [roomId, JSON.stringify(GHOST)]);
  function selective(before: Bag, after: Bag, written: readonly string[]) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!written.includes(key)) assert.deepEqual(after[key], before[key], `unwritten session-control key changed: ${key}`);
    }
    assert.deepEqual([after.fixtureSpare, (after.removedParticipants as Bag)["ghost-fixture"]], [{ kept: true }, GHOST], "spare raw values survive");
  }
  async function counters(): Promise<Counters> {
    const response = await h.request("/metrics"); assert.equal(response.status, 200);
    const result: Counters = {};
    for (const line of response.bytes.toString("utf8").split("\n")) if (SERIES.test(line)) result[line.slice(0, line.lastIndexOf(" "))] = Number(line.slice(line.lastIndexOf(" ") + 1));
    return result;
  }
  const delta = (before: Counters, after: Counters): Counters => Object.fromEntries(Object.keys({ ...before, ...after })
    .map(key => [key, (after[key] ?? 0) - (before[key] ?? 0)] as const).filter(([, value]) => value !== 0));
  const sinks = (value: Counters) => Object.fromEntries(Object.entries(value).filter(([key]) => !key.includes('result="denied"')));
  async function hold(phase: Hold, roomId: string, request: () => Promise<AuthorHttpResponse>) {
    const id = await h.arm(phase, roomId); held.add(id);
    const response = request(); void response.catch(() => undefined);
    await h.phase(id, phase); return { id, response };
  }
  async function resume(id: string) { held.delete(id); await h.resumePhase(id); }
  async function reset() { await h.clock(0); for (const id of [...held]) await resume(id); }
  async function openPid(): Promise<number> {
    const rows = (await h.pool.query(`select pid from pg_stat_activity where application_name=$1 and state like 'idle in transaction%'`, [h.schema])).rows;
    assert.equal(rows.length, 1, "exactly one held fence is open"); return rows[0].pid as number;
  }
  const blockedBy = (pid: number) => until(async () => (await h.pool.query(`select exists(select 1 from pg_stat_activity
    where application_name=$2 and $1=any(pg_blocking_pids(pid))) as blocked`, [pid, h.schema])).rows[0].blocked, "the fresh fence must wait on the held row");
  async function settled() {
    const open = await h.pool.query(`select count(*)::int as open from pg_stat_activity where application_name=$1 and state like 'idle in transaction%'`, [h.schema]);
    assert.equal(open.rows[0].open, 0, "no control fence stays open");
  }
  const pastExp = (actor: Mac) => actor.exp * 1000 - Date.now() + 1000;
  return { stem, createRoom, post, issued, host, presence, member, present, path, payload, send, ok, refused, unavailable, raw, spare, selective,
    counters, delta, sinks, hold, resume, reset, openPid, blockedBy, settled, pastExp };
}

test("floor-1 session control is guarded, fresh and acknowledged over native HTTP", postgres, async t => {
  await t.test("owned floor-1 fixture", async c => {
    const h = await startAuthorHttpFixture(c, 1, true), x = controls(h);
    const guarded = (name: string, body: () => Promise<void>) => c.test(name, async () => { try { await body(); } finally { await x.reset(); } });

    await guarded("a host claim holding its seat UPDATE blocks the fresh control read; the control lands on the claimed row", async () => {
      for (const command of ["lock", "end"] as const) {
        const roomId = await x.createRoom(), claimant = randomUUID(), { inviteToken } = await h.invite(roomId, "host");
        await x.spare(roomId);
        const before = await x.raw(roomId);
        const claim = await x.hold("admission-written", roomId, () => x.post({ roomId, participantId: claimant, inviteToken }));
        const holder = await x.openPid();
        const control = await x.hold("legacy-control-entry", roomId, () => x.send(roomId, command));
        assert.equal((await x.raw(roomId)).control.hostParticipantId, null, `${command}: the route's initial read could only see the vacant seat`);
        const answered = watch(control.response);
        await x.resume(control.id); await x.blockedBy(holder);
        assert.equal(answered(), false, `${command}: no fresh control decision while the claim holds its UPDATE`);
        await x.resume(claim.id);
        const [claimed, controlled] = await Promise.all([claim.response, control.response]);
        // Reply order is unspecified: an end committed before the claim's fresh release refuses the token, never the seat.
        if (command === "end" && claimed.status === 403) assert.equal(claimed.json<Bag>().reason, "session_ended");
        else assert.deepEqual([x.issued(claimed, roomId).participantId, x.issued(claimed, roomId).role], [claimant, "host"]);
        assert.equal(controlled.status, 200, `${command}: the control waited, then applied`);
        const reply = controlled.json<{ state: Bag }>(), after = await x.raw(roomId);
        assert.deepEqual([Object.keys(reply), reply.state.hostParticipantId, after.control.hostParticipantId], [["state"], claimant, claimant],
          `${command}: the fresh read saw the claimed seat and never reverted it`);
        x.selective(before.control, after.control, ["hostParticipantId", ...WRITES[command]]);
        assert.deepEqual([after.columns, after.control[command === "lock" ? "lockedBy" : "endedBy"]], [before.columns, ADMIN],
          `${command}: name, theme, avatar and status are untouched`);
      }
      await x.settled();
    });

    await guarded("a control holding its UPDATE blocks a claim past its initial snapshot; end refuses it, lock keeps it", async () => {
      for (const command of ["end", "lock"] as const) {
        const roomId = await x.createRoom(), claimant = randomUUID(), { inviteToken } = await h.invite(roomId, "host");
        const claim = await x.hold("admission-write", roomId, () => x.post({ roomId, participantId: claimant, inviteToken }));
        const control = await x.hold("control-written", roomId, () => x.send(roomId, command));
        const holder = await x.openPid(), answered = watch(claim.response);
        await x.resume(claim.id); await x.blockedBy(holder);
        assert.equal(answered(), false, `${command}: the claim waits for the control's row lock`);
        await x.resume(control.id);
        const [claimed, controlled] = await Promise.all([claim.response, control.response]);
        const after = (await x.raw(roomId)).control;
        assert.equal(controlled.status, 200);
        if (command === "end") {
          assert.deepEqual([claimed.status, claimed.json<Bag>().reason, after.hostParticipantId], [403, "session_ended", null], "no host after an end");
        } else {
          assert.equal(x.issued(claimed, roomId).role, "host");
          assert.deepEqual([after.hostParticipantId, after.lockedBy], [claimant, ADMIN], "the claim seated on the locked row; the lock survived");
        }
      }
      await x.settled();
    });

    await guarded("each of the seven commands merges only its own keys and answers its exact receipt and counters", async () => {
      const roomId = await x.createRoom();
      await x.host(roomId);
      const p = await x.member(roomId), q = await x.member(roomId), pid = p.participantId, qid = q.participantId;
      await x.spare(roomId);
      const steps: Array<[Command, string | undefined, Bag, Bag, Counters]> = [
        ["lock", undefined, {}, { lockedBy: ADMIN }, { [HOST("lock")]: 1, vrata_room_locked_total: 1 }],
        ["unlock", undefined, {}, { lockedAt: null, lockedBy: null }, { [HOST("unlock")]: 1 }],
        ["grant", pid, { presenterParticipantId: pid }, { presenterParticipantId: pid, presenterGrantedBy: ADMIN, presenterRevokedBy: null }, { [PRESENTER("grant")]: 1 }],
        ["revoke", pid, { presenterParticipantId: null }, { presenterParticipantId: null, presenterRevokedBy: ADMIN }, { [PRESENTER("revoke")]: 1 }],
        ["grant", pid, { presenterParticipantId: pid }, { presenterParticipantId: pid }, { [PRESENTER("grant")]: 1 }],
        // Not the current presenter: the transfer leaves the presenter trio alone.
        ["transfer", qid, { hostParticipantId: qid }, { hostParticipantId: qid, presenterParticipantId: pid, presenterRevokedBy: null }, { [HOST("transfer_host")]: 1 }],
        ["remove", pid, { removedParticipantId: pid }, { presenterParticipantId: null, presenterRevokedBy: ADMIN }, { [HOST("remove")]: 1, vrata_participants_removed_total: 1 }],
        ["end", undefined, {}, { endedBy: ADMIN }, { [HOST("end")]: 1, vrata_sessions_ended_total: 1 }]
      ];
      for (const [command, target, extra, stored, counted] of steps) {
        const before = await x.raw(roomId), metrics = await x.counters();
        const reply = await x.ok(roomId, command, target), after = await x.raw(roomId);
        assert.deepEqual(Object.keys(reply).sort(), ["state", ...Object.keys(extra)].sort(), `${command}: exact receipt keys`);
        for (const [key, value] of Object.entries(extra)) assert.equal(reply[key], value, `${command}: receipt ${key}`);
        assert.deepEqual(reply.state, Object.fromEntries(STATE_KEYS.map(key => [key, after.control[key] ?? null])), `${command}: the receipt is the stored row, sanitized`);
        x.selective(before.control, after.control, WRITES[command]);
        for (const [key, value] of Object.entries(stored)) assert.deepEqual(after.control[key], value, `${command}: stored ${key}`);
        assert.deepEqual(x.delta(metrics, await x.counters()), counted, `${command}: canonical success counters`);
      }
      const removed = (await x.raw(roomId)).control.removedParticipants as Record<string, Bag>;
      assert.deepEqual([removed[pid]?.removedBy, removed[pid]?.reason], [ADMIN, "fixture"]);
      assert.deepEqual(await x.present(roomId), [], "remove dropped its target and end every live presence, after their ACKs");
    });

    await guarded("a control after a concurrent rename and disable keeps both; admin PATCH sessionControl stays a raw replacement", async () => {
      const roomId = await x.createRoom();
      const lock = await x.hold("legacy-control-entry", roomId, () => x.send(roomId, "lock"));
      assert.equal((await h.request(x.stem(roomId), "PATCH", h.adminHeaders, { name: "Renamed control room" })).status, 200);
      assert.equal((await h.request(`${x.stem(roomId)}/disable`, "POST", h.adminHeaders, {})).status, 200);
      await x.resume(lock.id);
      assert.equal((await lock.response).status, 200, "the administrator still manages a disabled room");
      const locked = await x.raw(roomId);
      assert.deepEqual([locked.columns.name, locked.columns.status, locked.control.lockedBy], ["Renamed control room", "disabled", ADMIN]);
      const patched = await x.createRoom(), seated = await x.host(patched), live = await x.member(patched);
      await x.spare(patched);
      const kept = await x.raw(patched);
      assert.equal((await h.request(x.stem(patched), "PATCH", h.adminHeaders, { name: "Name only" })).status, 200);
      assert.equal((await x.raw(patched)).text, kept.text, "a PATCH without sessionControl keeps the raw column byte-equal");
      const metrics = await x.counters();
      // Intentional and pre-existing: an explicit administrator sessionControl is a whole defaulted replacement.
      assert.equal((await h.request(x.stem(patched), "PATCH", h.adminHeaders,
        { sessionControl: { lockedAt: "2026-01-01T00:00:00.000Z", lockedBy: "patch-fixture" } })).status, 200);
      const replaced = (await x.raw(patched)).control;
      assert.deepEqual([replaced.fixtureSpare, replaced.removedParticipants, replaced.hostParticipantId === seated.participantId, replaced.lockedBy],
        [undefined, {}, false, "patch-fixture"], "unknown raw keys and unnamed fields are dropped, as before");
      assert.deepEqual([x.delta(metrics, await x.counters()), await x.present(patched)], [{}, [live.participantId]], "no command counter or presence effect");
    });

    await guarded("a held host command decides on the current seat and lifecycle, never its entry snapshot", async () => {
      const expected = { transfer: [403, "forbidden", "permission_denied"], remove: [403, "room_access_denied", "participant_removed"],
        end: [403, "room_access_denied", "session_ended"], disable: [403, "room_access_denied", "room_disabled"] } as const;
      for (const drift of ["transfer", "remove", "end", "disable"] as const) {
        const roomId = await x.createRoom(), actor = await x.host(roomId), next = await x.member(roomId), requestId = randomUUID();
        const metrics = await x.counters();
        const lock = await x.hold("legacy-control-entry", roomId, () => x.send(roomId, "lock", undefined, actor, requestId));
        if (drift === "disable") assert.equal((await h.request(`${x.stem(roomId)}/disable`, "POST", h.adminHeaders, {})).status, 200);
        else await x.ok(roomId, drift, drift === "transfer" ? next.participantId : drift === "remove" ? actor.participantId : undefined);
        const drifted = await x.raw(roomId);
        await x.resume(lock.id);
        const [status, error, reason] = expected[drift];
        x.refused(await lock.response, status, error, reason, requestId);
        const sunk = x.delta(metrics, await x.counters());
        assert.deepEqual([(await x.raw(roomId)).text === drifted.text, sunk[HOST("lock")], sunk.vrata_room_locked_total], [true, undefined, undefined],
          `${drift}: the stale host proof wrote and counted nothing`);
        if (drift === "remove") assert.equal(drifted.control.hostParticipantId, actor.participantId, "the leftover raw seat grants nothing");
        if (drift === "transfer") assert.equal((await x.send(roomId, "lock", undefined, actor)).status, 403, "the former host is refused at entry");
      }
    });

    await guarded("a bearer lapsing in the body wait or after the actual UPDATE is 401 expired_token with nothing kept", async () => {
      for (const command of ["remove", "transfer"] as const) {
        const roomId = await x.createRoom(), actor = await x.host(roomId), target = await x.member(roomId), requestId = randomUUID();
        const before = await x.raw(roomId);
        const stalled = h.stalled(x.path(roomId, command, target.participantId), { ...authorHttpBearer(actor.token), "x-request-id": requestId },
          Buffer.from(JSON.stringify(x.payload(command, target.participantId))));
        let response!: AuthorHttpResponse;
        try { await stalled.admitted(); await h.clock(x.pastExp(actor)); stalled.finish(); response = await stalled.response; }
        finally { stalled.destroy(); await h.clock(0); }
        x.refused(response, 401, "unauthorized", "expired_token", requestId);
        assert.deepEqual([(await x.raw(roomId)).text === before.text, (await x.present(roomId)).includes(target.participantId)], [true, true],
          `${command}: no SQL write and no presence change`);
      }
      const roomId = await x.createRoom(), actor = await x.host(roomId), requestId = randomUUID(), before = await x.raw(roomId), metrics = await x.counters();
      const lock = await x.hold("control-written", roomId, () => x.send(roomId, "lock", undefined, actor, requestId));
      await h.clock(x.pastExp(actor)); await x.resume(lock.id);
      x.refused(await lock.response, 401, "unauthorized", "expired_token", requestId);
      await h.clock(0);
      assert.deepEqual([(await x.raw(roomId)).text === before.text, x.sinks(x.delta(metrics, await x.counters()))], [true, {}],
        "the lapse after the actual UPDATE rolled it back with no success sink");
      await x.settled();
    });

    await guarded("a v2 binding while the command is held is 409 identity_upgrade_required with no write", async () => {
      const roomId = await x.createRoom(), actor = await x.host(roomId);
      const end = await x.hold("legacy-control-entry", roomId, () => x.send(roomId, "end", undefined, actor));
      await h.storage.roomIdentities.create({ tenantId: "demo-tenant", roomId, displayName: "Binding", baseRole: "guest", provenance: { kind: "guest" } });
      const before = await x.raw(roomId);
      await x.resume(end.id);
      const response = await end.response;
      assert.deepEqual([response.status, response.json(), (await x.raw(roomId)).text === before.text], [409, UPGRADE, true], "no stale receipt, no write");
    });

    await guarded("presence is sampled once after the locks; revoke and transfer read the current presenter", async () => {
      const roomId = await x.createRoom(), leaving = await x.member(roomId), arriving = await x.member(roomId, false);
      const grant = await x.hold("legacy-control-entry", roomId, () => x.send(roomId, "grant", leaving.participantId));
      assert.equal((await x.presence(roomId, leaving, "DELETE")).status, 200);
      await x.resume(grant.id); x.refused(await grant.response, 404, "participant_not_found");
      const transfer = await x.hold("legacy-control-entry", roomId, () => x.send(roomId, "transfer", arriving.participantId));
      assert.equal((await x.presence(roomId, arriving)).status, 200);
      await x.resume(transfer.id);
      assert.equal((await transfer.response).status, 200, "a target present at the sample is accepted");
      const removed = await x.member(roomId);
      const late = await x.hold("legacy-control-entry", roomId, () => x.send(roomId, "transfer", removed.participantId));
      await x.ok(roomId, "remove", removed.participantId);
      await x.resume(late.id); x.refused(await late.response, 404, "participant_not_found");
      const first = await x.member(roomId), second = await x.member(roomId);
      await x.ok(roomId, "grant", first.participantId);
      const revoke = await x.hold("legacy-control-entry", roomId, () => x.send(roomId, "revoke", first.participantId));
      await x.ok(roomId, "grant", second.participantId);
      await x.resume(revoke.id); x.refused(await revoke.response, 404, "presenter_not_found");
      assert.deepEqual([(await x.raw(roomId)).control.hostParticipantId, (await x.raw(roomId)).control.presenterParticipantId],
        [arriving.participantId, second.participantId], "the stale revoke never cleared the current presenter");
      await x.ok(roomId, "transfer", second.participantId);
      const after = (await x.raw(roomId)).control;
      assert.deepEqual([after.hostParticipantId, after.presenterParticipantId, after.presenterRevokedBy], [second.participantId, null, ADMIN],
        "a transfer to the current presenter clears the presenter");
    });

    await guarded("concurrent removals merge; a late presenter command never erases a lock, end, seat or removal", async () => {
      const roomId = await x.createRoom(), seated = await x.host(roomId), presenter = await x.member(roomId);
      await x.spare(roomId);
      const [one, two, three] = [randomUUID(), randomUUID(), randomUUID()];
      const remove = await x.hold("legacy-control-entry", roomId, () => x.send(roomId, "remove", one));
      await x.ok(roomId, "remove", two);
      await x.resume(remove.id); assert.equal((await remove.response).status, 200);
      const grant = await x.hold("legacy-control-entry", roomId, () => x.send(roomId, "grant", presenter.participantId));
      await x.ok(roomId, "lock"); await x.ok(roomId, "remove", three);
      await x.resume(grant.id); assert.equal((await grant.response).status, 200);
      const revoke = await x.hold("legacy-control-entry", roomId, () => x.send(roomId, "revoke", presenter.participantId));
      await x.ok(roomId, "end");
      await x.resume(revoke.id); x.refused(await revoke.response, 404, "presenter_not_found");
      const after = (await x.raw(roomId)).control;
      assert.deepEqual([Object.keys(after.removedParticipants as Bag).sort(), after.hostParticipantId, after.lockedBy, after.endedBy, after.fixtureSpare],
        [["ghost-fixture", one, two, three].sort(), seated.participantId, ADMIN, ADMIN, { kept: true }], "every concurrent write survives");
    });

    await guarded("a rejected COMMIT keeps nothing; a lost ACK is one 503 with no success sink or local projection", async () => {
      const rejected = await x.createRoom(), reject = `"${h.schema}".control_fixture_reject`;
      assert.match(rejected, UUID);
      await h.pool.query(`create function ${reject}() returns trigger language plpgsql as $$ begin
        raise exception using errcode = 'P0001', message = 'control_fixture_rejected'; end $$`);
      try {
        // Fixture-only: an owned deferred trigger makes the real COMMIT of a control-column change answer P0001 for one room.
        await h.pool.query(`create constraint trigger control_fixture_reject after update on "${h.schema}".rooms deferrable initially deferred
          for each row when (new.room_id = '${rejected}' and new.session_control is distinct from old.session_control) execute function ${reject}()`);
        const before = await x.raw(rejected), metrics = await x.counters();
        x.unavailable(await x.send(rejected, "lock"));
        assert.deepEqual([(await x.raw(rejected)).text === before.text, x.delta(metrics, await x.counters())], [true, {}], "byte-equal row, nothing counted");
      } finally {
        await h.pool.query(`drop trigger if exists control_fixture_reject on "${h.schema}".rooms`);
        await h.pool.query(`drop function if exists ${reject}()`);
      }
      await x.ok(rejected, "lock");
      const roomId = await x.createRoom(), stays = await x.member(roomId), leaves = await x.member(roomId);
      const lost = async (command: Command, target?: string) => {
        const metrics = await x.counters(), armed = await h.arm("control-ack-loss", roomId);
        x.unavailable(await x.send(roomId, command, target)); await h.phase(armed, "control-ack-loss");
        assert.deepEqual(x.delta(metrics, await x.counters()), {}, `${command}: no success counter before a known ACK`);
        return (await x.raw(roomId)).control;
      };
      const removedRow = (await lost("remove", leaves.participantId)).removedParticipants as Record<string, Bag>;
      assert.equal(typeof removedRow[leaves.participantId]?.removedAt, "string", "the real COMMIT removed the target");
      assert.deepEqual(await x.present(roomId), [stays.participantId, leaves.participantId].sort(), "no local presence projection without the ACK");
      x.refused(await x.presence(roomId, leaves), 403, "room_access_denied", "participant_removed");
      assert.equal((await x.presence(roomId, leaves, "DELETE")).status, 200, "the removed participant clears its own entry");
      assert.deepEqual(await x.present(roomId), [stays.participantId], "observed immediately, not after the presence TTL");
      const endedRow = await lost("end");
      assert.deepEqual(await x.present(roomId), [stays.participantId]);
      x.refused(await x.presence(roomId, stays), 403, "room_access_denied", "session_ended");
      assert.equal((await x.presence(roomId, stays, "DELETE")).status, 200);
      const metrics = await x.counters();
      await x.ok(roomId, "end");
      // Documented legacy compatibility: a natural retry after an unknown end re-applies and restamps.
      assert.equal(Date.parse(String((await x.raw(roomId)).control.endedAt)) >= Date.parse(String(endedRow.endedAt)), true);
      assert.deepEqual(x.delta(metrics, await x.counters()), { [HOST("end")]: 1, vrata_sessions_ended_total: 1 }, "the known ACK is the first success");
      const presenting = await x.createRoom(), presenter = await x.member(presenting);
      await x.ok(presenting, "grant", presenter.participantId);
      const armed = await h.arm("control-ack-loss", presenting);
      x.unavailable(await x.send(presenting, "revoke", presenter.participantId)); await h.phase(armed, "control-ack-loss");
      x.refused(await x.send(presenting, "revoke", presenter.participantId), 404, "presenter_not_found");
      await x.settled();
    });

    await guarded("a saved 201-character tenant is controlled; a malformed raw column is 409 with no default overwrite", async () => {
      assert.equal(LONG_TENANT.length, 201);
      assert.equal((await h.request("/api/tenants", "POST", h.adminHeaders, { tenantId: LONG_TENANT, name: "Long control tenant" })).status, 201);
      const longRoom = await x.createRoom(LONG_TENANT), actor = await x.host(longRoom);
      assert.equal(((await x.ok(longRoom, "lock", undefined, actor)).state as Bag).lockedBy, actor.participantId);
      await x.ok(longRoom, "unlock");
      const roomId = await x.createRoom(), seated = await x.host(roomId);
      // Fixture-only: a removal map no API path writes; the store must refuse it as drift, never default it.
      await h.pool.query(`update "${h.schema}".rooms set session_control = session_control || '{"removedParticipants":"fixture-malformed"}'::jsonb
        where room_id=$1`, [roomId]);
      const before = await x.raw(roomId);
      for (const by of [undefined, seated]) for (const command of ["lock", "end"] as const) {
        const response = await x.send(roomId, command, undefined, by);
        assert.deepEqual([response.status, response.json()], [409, CHANGED], `${command}: drift, not a default`);
      }
      assert.equal((await x.raw(roomId)).text, before.text, "the malformed column is never overwritten");
    });
  });

  // Activation is monotonic: it owns a fresh floor-1 fixture and runs last.
  await t.test("owned floor-1 fixture: activation while a host command is held refuses it with no write", async c => {
    const h = await startAuthorHttpFixture(c, 1, true), x = controls(h);
    const roomId = await x.createRoom(), actor = await x.host(roomId), before = await x.raw(roomId);
    try {
      const lock = await x.hold("legacy-control-entry", roomId, () => x.send(roomId, "lock", undefined, actor));
      await h.storage.identityProtocol.raise(2); await x.resume(lock.id);
      const response = await lock.response;
      assert.deepEqual([response.status, response.json()], [409, UPGRADE], "the fresh guard refuses; no stale receipt");
    } finally { await x.reset(); }
    assert.deepEqual([await h.storage.identityProtocol.minimum(), (await x.raw(roomId)).text === before.text], [2, true]);
  });
});
