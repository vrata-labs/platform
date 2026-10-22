import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { RoomPluginManifest } from "@vrata/room-plugin-sdk";
import { RoomPluginAuthorError, type RoomPluginAuthorLibrary, type RoomPluginAuthorPackage } from "./author-http.js";
import { RoomPluginAuthorSession, type RoomPluginAuthorContext, type RoomPluginAuthorState } from "./author-session.js";

const manifest: RoomPluginManifest = { schemaVersion: 1, sdkApiVersion: 1, id: "external.session", version: "1.0.0", displayName: "Session",
  requestedCapabilities: ["status.set"], configSchema: {}, entrySha256: "e".repeat(64) };
const value: RoomPluginAuthorPackage = { packageId: "00000000-0000-4000-8000-000000000001", pluginId: manifest.id, version: "1.0.0",
  artifactSha256: "a".repeat(64), byteLength: 1, manifest, state: "ready", uploadSettled: true };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
function harness() {
  const context: RoomPluginAuthorContext = { eligible: true, online: true };
  const calls: string[] = [], states: RoomPluginAuthorState[] = [];
  let library: RoomPluginAuthorLibrary = { revision: 1, packages: [value], bindings: [] };
  let pendingLibrary: ReturnType<typeof deferred<RoomPluginAuthorLibrary>> | null = null;
  let pendingWrite: ReturnType<typeof deferred<number>> | null = null;
  let libraryError: Error | null = null, changed = 0, now = 0;
  const http = {
    async library() { calls.push("library"); if (libraryError) throw libraryError; return pendingLibrary ? pendingLibrary.promise : library; },
    async upload() { calls.push("upload"); if (pendingWrite) await pendingWrite.promise; },
    async bind(pluginId: string, revision: number) { calls.push(`bind:${pluginId}:${revision}`); return pendingWrite ? pendingWrite.promise : revision + 1; },
    async unbind() { calls.push("unbind"); return 0; },
    async remove() { calls.push("remove"); }
  };
  const session = new RoomPluginAuthorSession({ http: http as never, context: () => context, clock: () => now,
    render: state => states.push(state), changed: () => { changed++; } });
  return { session, context, calls, states, get changed() { return changed; }, advance(ms: number) { now += ms; },
    set library(next: RoomPluginAuthorLibrary) { library = next; },
    holdLibrary() { pendingLibrary = deferred(); return pendingLibrary; }, releaseLibrary() { pendingLibrary = null; },
    holdWrite() { pendingWrite = deferred(); return pendingWrite; }, failLibrary(error: Error | null) { libraryError = error; } };
}
const enable = { type: "enable" as const, pluginId: value.pluginId, packageId: value.packageId, approved: ["status.set" as const], config: {} };

test("ineligible and floor-1 sessions stay hidden without retry noise", async () => {
  const h = harness(); h.context.eligible = false; h.session.sync(); await delay(1);
  assert.deepEqual(h.calls, []); assert.equal(h.session.state().phase, "hidden");
  h.context.eligible = true; h.failLibrary(new RoomPluginAuthorError("unsupported")); h.session.sync(); await delay(1);
  assert.equal(h.session.state().phase, "hidden"); assert.equal(h.session.state().message, null);
  h.session.observeRevision(5); h.session.sync(); h.session.sync(); await delay(1);
  assert.deepEqual(h.calls, ["library"], "a refused panel ignores hints and repeated authority renders");
  h.context.eligible = false; h.session.sync(); h.context.eligible = true; h.failLibrary(null); h.session.sync(); await delay(1);
  assert.deepEqual(h.calls, ["library", "library"], "a new eligibility period may read again"); assert.equal(h.session.state().phase, "ready");
  h.session.sync(); h.session.sync(); await delay(1); assert.equal(h.calls.length, 2, "stable authority renders do not re-read");
});

test("a write is single-flight, refreshes the library and asks the runtime to revalidate", async () => {
  const h = harness(); h.session.sync(); await delay(1); assert.equal(h.session.state().phase, "ready");
  const write = h.holdWrite();
  const first = h.session.apply(enable), second = h.session.apply(enable);
  await delay(1); assert.equal(h.calls.filter(call => call.startsWith("bind")).length, 1); assert.equal(h.session.state().busy, "write");
  h.library = { revision: 2, packages: [value], bindings: [] }; write.resolve(2); await Promise.all([first, second]);
  assert.deepEqual(h.calls, ["library", "bind:external.session:1", "library"]); assert.equal(h.changed, 1);
  assert.equal(h.session.state().library?.revision, 2); assert.equal(h.session.state().message?.kind, "info");
});

test("offline freezes writes; returning online re-reads before any new write", async () => {
  const h = harness(); h.session.sync(); await delay(1);
  h.context.online = false; h.session.sync();
  assert.equal(h.session.state().frozen, true); assert.match(h.session.state().message!.text, /^Offline:/);
  await h.session.apply(enable); await h.session.upload(new Uint8Array([1])); assert.deepEqual(h.calls, ["library"]);
  h.context.online = true; h.session.sync(); await delay(1);
  assert.deepEqual(h.calls, ["library", "library"]); assert.equal(h.session.state().frozen, false); assert.equal(h.session.state().message, null);
});

test("a write that loses connectivity mid-flight reports an unknown outcome and re-reads instead of retrying", async () => {
  const h = harness(); h.session.sync(); await delay(1);
  const write = h.holdWrite(); const pending = h.session.apply(enable);
  await delay(1); h.context.online = false; h.session.sync(); h.context.online = true;
  write.reject(new RoomPluginAuthorError("unavailable")); await pending;
  assert.equal(h.calls.filter(call => call.startsWith("bind")).length, 1); assert.equal(h.calls.at(-1), "library");
  assert.equal(h.session.state().message?.kind, "error"); assert.equal(h.changed, 0);
});

test("stale library reads never overwrite a newer read and hiding discards a late write result", async () => {
  const h = harness(); const slow = h.holdLibrary(); h.session.sync(); await delay(1);
  h.releaseLibrary(); h.library = { revision: 9, packages: [value], bindings: [] };
  h.session.observeRevision(9); await delay(1);
  assert.equal(h.calls.length, 1, "a read in flight coalesces the hint");
  slow.resolve({ revision: 8, packages: [], bindings: [] }); await delay(5);
  assert.equal(h.session.state().library?.revision, 9, "the queued newer read wins");
  const write = h.holdWrite(); const pending = h.session.apply(enable); await delay(1);
  h.context.eligible = false; h.session.sync(); write.resolve(10); await pending;
  assert.equal(h.session.state().phase, "hidden"); assert.equal(h.session.state().library, null); assert.equal(h.changed, 0);
});

test("conflicts and forbidden results come from fixed classes; a failed first read retries at most every 5 s", async () => {
  const h = harness(); h.failLibrary(new RoomPluginAuthorError("unavailable")); h.session.sync(); await delay(1);
  assert.equal(h.session.state().phase, "loading"); assert.equal(h.session.state().frozen, true);
  h.session.observeRevision(1); await delay(1); assert.equal(h.calls.length, 1);
  h.advance(5000); h.failLibrary(null); h.session.observeRevision(1); await delay(1);
  assert.equal(h.calls.length, 2); assert.equal(h.session.state().phase, "ready");
  h.failLibrary(new RoomPluginAuthorError("forbidden")); h.session.observeRevision(3); await delay(1);
  assert.equal(h.session.state().phase, "hidden");
});

test("stop hides a visible panel; a failed refresh with a loaded library is throttled", async () => {
  const h = harness(); h.session.sync(); await delay(1); assert.equal(h.session.state().phase, "ready");
  h.failLibrary(new RoomPluginAuthorError("unavailable")); h.session.observeRevision(2); await delay(1);
  assert.equal(h.calls.length, 2); assert.equal(h.session.state().library?.revision, 1, "the last good library stays visible");
  for (let i = 0; i < 4; i++) h.session.observeRevision(2);
  await delay(1); assert.equal(h.calls.length, 2, "a failing read is not repeated on every hint");
  h.advance(5000); h.failLibrary(null); h.session.observeRevision(2); await delay(1); assert.equal(h.calls.length, 3);
  h.session.stop(); assert.equal(h.states.at(-1)?.phase, "hidden"); assert.equal(h.states.at(-1)?.library, null);
  h.session.sync(); h.session.observeRevision(9); await delay(1); assert.equal(h.calls.length, 3);
});
