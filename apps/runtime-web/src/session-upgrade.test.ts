import test from "node:test";
import assert from "node:assert/strict";
import { identityRequirementFromClose, identityRequirementFromResponse } from "@vrata/shared-types";
import { createSessionAwareFetch, createSessionUpgradeGate, SessionUpgradeError } from "./session-upgrade.js";
import { createSessionUpgradeStorage } from "./session-upgrade-drafts.js";

test("only the versioned identity response or application close code requests an upgrade", () => {
  for (const reason of ["identity_upgrade_required", "identity_recovery_required"] as const) {
    for (const status of [401, 409, 426]) assert.equal(identityRequirementFromResponse(status, { error: "identity_required", reason }), reason);
    for (const status of [200, 202, 400, 403, 500]) assert.equal(identityRequirementFromResponse(status, { error: "identity_required", reason }), null);
    assert.equal(identityRequirementFromResponse(401, { error: "room_access_denied", reason }), null);
  }
  for (const payload of [null, "identity_upgrade_required", {}, { error: "identity_required", reason: "<script>secret</script>" }]) {
    assert.equal(identityRequirementFromResponse(426, payload), null);
  }
  assert.equal(identityRequirementFromClose(4406, "identity_upgrade_required"), "identity_upgrade_required");
  assert.equal(identityRequirementFromClose(4409, ""), "identity_recovery_required");
  assert.equal(identityRequirementFromClose(4409, "arbitrary server text"), null);
  assert.equal(identityRequirementFromClose(1006, "identity_upgrade_required"), null);
});

test("gate is terminal, replayable to a late UI, idempotent and only escalates to recovery", () => {
  const gate = createSessionUpgradeGate();
  const reasons: string[] = [];
  gate.require("identity_upgrade_required");
  const uninstall = gate.install(reason => reasons.push(reason));
  gate.require("identity_upgrade_required");
  gate.require("identity_recovery_required");
  gate.require("identity_upgrade_required");
  assert.deepEqual(reasons, ["identity_upgrade_required", "identity_recovery_required"]);
  assert.throws(() => gate.assertActive(), new SessionUpgradeError("identity_recovery_required"));
  uninstall();
});

test("REST denial shuts down synchronously and late successes or subsequent requests cannot restore a session", async () => {
  const gate = createSessionUpgradeGate();
  let release!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  let requests = 0;
  let stopped = false;
  gate.install(() => { stopped = true; });
  const request = createSessionAwareFetch(gate, async input => {
    requests++;
    return String(input).endsWith("/late") ? pending : Response.json({ error: "identity_required", reason: "identity_upgrade_required" }, { status: 426 });
  });
  const old = request("https://room.test/late");
  await assert.rejects(request("https://room.test/denial"), SessionUpgradeError);
  assert.equal(stopped, true);
  release(Response.json({ token: "obsolete-test-session" }));
  await assert.rejects(old, SessionUpgradeError);
  await assert.rejects(request("https://room.test/write", { method: "POST" }), SessionUpgradeError);
  assert.equal(requests, 2);
});

test("ordinary API errors, invalid JSON and conflicts retain their readable response body", async () => {
  for (const body of ['{"error":"revision_conflict"}', 'not JSON', '{"reason":"identity_upgrade_required"}']) {
    const gate = createSessionUpgradeGate();
    const request = createSessionAwareFetch(gate, async () => new Response(body, { status: 409 }));
    assert.equal(await (await request("https://room.test")).text(), body);
    assert.equal(gate.reason, null);
  }
});

test("room-scoped tab drafts and reload marker preserve identity, preferences and other room data", () => {
  const values = new Map([
    ["vrata.participantId", "tab-id"], ["noah.participantId", "legacy-id"], ["vrata.personalOwnerId", "owner-id"],
    ["vrata.displayName", "Name"], ["vrata.audio.joinMuted", "true"]
  ]);
  const original = [...values];
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const first = createSessionUpgradeStorage(() => storage, "room-a", "build-1");
  const otherRoom = createSessionUpgradeStorage(() => storage, "room-b", "build-1");
  assert.equal(first.saveDraft({ scope: "shared", content: "<h1>unsaved text</h1>" }), true);
  assert.equal(first.saveDraft({ scope: "private", content: "" }), true);
  assert.deepEqual(otherRoom.readDrafts(), []);
  first.recordReload();
  assert.equal(first.alreadyReloaded(), true);
  assert.equal(otherRoom.alreadyReloaded(), false);
  const newBuild = createSessionUpgradeStorage(() => storage, "room-a", "build-2");
  assert.equal(newBuild.alreadyReloaded(), false);
  assert.equal(newBuild.readDrafts().length, 2);
  first.discardDrafts();
  for (const [key, value] of original) assert.equal(values.get(key), value);
});

test("storage denial does not prevent the security gate or throw away the in-memory draft", () => {
  const storage = createSessionUpgradeStorage(() => { throw new Error("storage blocked"); }, "room", "build");
  assert.deepEqual(storage.readDrafts(), []);
  assert.equal(storage.saveDraft({ scope: "shared", content: "draft" }), false);
  assert.equal(storage.alreadyReloaded(), false);
  assert.doesNotThrow(() => storage.recordReload());
});
