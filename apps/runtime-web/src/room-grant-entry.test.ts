import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeAccessError } from "./index.js";
import { describeRoomAccessEnded } from "./room-access-ended.js";
import { exchangeRoomGrant, takeRoomGrant } from "./room-grant-entry.js";

const roomId = "3f2b8c1e-5a6d-4e7f-9a1b-2c3d4e5f6a7b";
const code = "Qm9iX3Byb2JlX2NvZGVfb25seV9mb3Jfc2NoZW1hX3Rlc3Rz";

function tab() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
}

test("the grant code leaves the address at once and survives a reload of the same tab until it is spent", () => {
  const storage = tab();
  const replaced: string[] = [];
  const history = { state: { kept: true }, replaceState: (_state: unknown, _title: string, url?: string | URL | null) => { replaced.push(String(url)); } };
  const pending = takeRoomGrant({ hash: `#grant=${code}&view=1`, pathname: `/rooms/${roomId}`, search: "?lang=ru" }, history, storage, roomId);
  assert.deepEqual(replaced, [`/rooms/${roomId}?lang=ru#view=1`]);
  assert.equal(pending.code(), code);
  const reloaded = takeRoomGrant({ hash: "", pathname: `/rooms/${roomId}`, search: "" }, history, storage, roomId);
  assert.equal(reloaded.code(), code);
  assert.equal(takeRoomGrant({ hash: "", pathname: "/rooms/other", search: "" }, history, storage, "other").code(), null, "a code belongs to its room");
  reloaded.clear();
  assert.equal(takeRoomGrant({ hash: "", pathname: `/rooms/${roomId}`, search: "" }, history, storage, roomId).code(), null);
  assert.equal(replaced.length, 1);
  const broken = takeRoomGrant({ hash: "#grant=short", pathname: `/rooms/${roomId}`, search: "" }, history, storage, roomId);
  assert.deepEqual([broken.code(), replaced.at(-1)], [null, `/rooms/${roomId}`], "even an invalid code is removed from the address");
  assert(pending.retryable("rate_limited") && !pending.retryable("grant_invalid") && !pending.retryable("room_closed"));
});

test("the exchange returns the identity credential and turns refusals into access errors with the contract code", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const answer = (status: number, body: unknown): typeof fetch => (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init! });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const ok = await exchangeRoomGrant("https://app.example.test", roomId, code, "  Anna  ", answer(200, {
    roomId, participantId: "9b2d7f4a-1c3e-4f5a-8b6c-7d8e9f0a1b2c", identityCredential: "ri2.x.y", cutoff: "2026-10-23T12:00:00Z", sessionToken: "rs2.x"
  }));
  assert.equal(ok.identityCredential, "ri2.x.y");
  assert.equal(requests[0]!.url, "https://app.example.test/api/room-grants/exchange");
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { roomId, code, displayName: "Anna" });
  assert.equal(requests[0]!.init.referrerPolicy, "no-referrer");
  await assert.rejects(exchangeRoomGrant("https://app.example.test", roomId, code, null, answer(409, { error: { code: "grant_invalid", requestId: "req_1" } })),
    (error: unknown) => error instanceof RuntimeAccessError && error.status === 409 && error.reason === "grant_invalid" && error.requestId === "req_1");
  await assert.rejects(exchangeRoomGrant("https://app.example.test", roomId, code, null, answer(500, "oops")),
    (error: unknown) => error instanceof RuntimeAccessError && error.reason === "grant_exchange_failed");
  await assert.rejects(exchangeRoomGrant("https://app.example.test", roomId, code, null, answer(200, { roomId: "other", participantId: "p", identityCredential: "ri2.x.y" })),
    (error: unknown) => error instanceof RuntimeAccessError && error.reason === "grant_exchange_failed");
});

test("final access outcomes have their own screen; transient ones do not", () => {
  for (const reason of ["room_closed", "access_expired", "grant_invalid", "grant_revoked", "grant_required", "capacity_full"]) {
    assert.ok(describeRoomAccessEnded(reason)?.title, reason);
  }
  for (const reason of ["room_paused", "rate_limited", "room_locked", "waiting_room_pending"]) assert.equal(describeRoomAccessEnded(reason), null, reason);
});
