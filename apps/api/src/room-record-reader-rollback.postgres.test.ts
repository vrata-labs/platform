import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import { resolveRoomTemplateCreate, roomTemplateSessionContext } from "./room-template-policy.js";
import { PostgresStorage, type RoomRecord } from "./storage.js";

const READER = { sha: "9b1d43f0eb7efe2fc2f8684669eda7379635c01c", env: "VRATA_READER_ROLLBACK_STORAGE_MODULE" };
const BOUNDARY = { sha: "033bd6e2b33e9149221464c934554977320ca36f", env: "VRATA_BOUNDARY_ROLLBACK_STORAGE_MODULE" };
const url = process.env.VRATA_TEST_POSTGRES_URL;
const tenantId = "demo-tenant";
const admin = { actorType: "admin-token" as const, actorId: "verified-admin", role: "admin" as const };
const roomId = (label: string) => `reader-${label}-${randomUUID().slice(0, 8)}`;
type Guard = { ROOM_RECORD_SCHEMA_SQL: string; OWNERLESS_REFERENCE_PERSONAL_SQL: string };
type StorageModule = { PostgresStorage: typeof PostgresStorage };
const guardSpecifier = new URL("../../../tools/identity-rollback-guard.mjs", import.meta.url).href;
const rollbackGuard = async () => await import(guardSpecifier) as Guard;
const pinnedLocally = Boolean(process.env[READER.env]?.trim() && process.env[BOUNDARY.env]?.trim());

function pinnedStorage({ sha, env }: { sha: string; env: string }): string | undefined {
  const value = process.env[env]?.trim();
  if (process.env.CI) assert.ok(value, `CI requires ${env} from the independently checked out and built ${sha}`);
  if (!value) return undefined;
  assert.ok(isAbsolute(value), `${env} must be an absolute compiled storage module path`);
  assert.ok(statSync(value).isFile(), `build ${sha} before verification`);
  const root = realpathSync(resolve(dirname(value), "../../.."));
  assert.equal(realpathSync(value), resolve(root, "apps/api/dist/storage.js"), `${env} must point to the compiled API storage module`);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(realpathSync(git("rev-parse", "--show-toplevel").trim()), root, `${env} must be its own checkout root`);
  assert.equal(git("rev-parse", "HEAD").trim(), sha, `${env} checkout must be the exact pinned revision`);
  assert.equal(git("diff", "--name-status", "HEAD"), "", `${env} tracked source must match ${sha}`);
  assert.equal(git("status", "--porcelain", "--untracked-files=all"), "", `${env} checkout must be fully clean`);
  return pathToFileURL(value).href;
}
async function isolated(t: TestContext, prefix: string) {
  assert.ok(url, "CI requires VRATA_TEST_POSTGRES_URL");
  const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`, connection = new URL(url);
  connection.searchParams.set("options", `-c search_path=${schema}`);
  const root = new Pool({ connectionString: url }), pools: Pool[] = [];
  t.after(async () => { await Promise.all(pools.map(pool => pool.end())); await root.query(`drop schema if exists "${schema}" cascade`); await root.end(); });
  await root.query(`create schema "${schema}"`);
  return { open: () => { const pool = new Pool({ connectionString: connection.href }); pools.push(pool); return pool; } };
}
async function probe(pool: Pool, sql: string): Promise<boolean> {
  const { rows, fields } = await pool.query(sql);
  assert.equal(rows.length, 1); assert.equal(fields.length, 1);
  const [value] = Object.values(rows[0]);
  assert.equal(typeof value, "boolean", "rollout probes return one scalar boolean, never room data");
  return value as boolean;
}
async function snapshotEditor(pool: Pool, id: string) {
  const row = (await pool.query("select template_id, template_version from rooms where room_id=$1", [id])).rows[0];
  const key = [row.template_id, row.template_version];
  // Corruption is confined to this disposable schema, bypassing immutable template fixtures.
  await pool.query("alter table template_versions disable trigger template_versions_immutable");
  const original = JSON.stringify((await pool.query("select snapshot from template_versions where template_id=$1 and version=$2", key)).rows[0].snapshot);
  return {
    set: (expression: string, value?: string) => pool.query(`update template_versions set snapshot=${expression} where template_id=$1 and version=$2`,
      value === undefined ? key : [...key, value]),
    type: async () => (await pool.query("select jsonb_typeof(snapshot) as type from template_versions where template_id=$1 and version=$2", key)).rows[0].type as string,
    restore: async () => {
      await pool.query("update template_versions set snapshot=$3::jsonb where template_id=$1 and version=$2", [...key, original]);
      await pool.query("alter table template_versions enable trigger template_versions_immutable");
    }
  };
}
async function ownerlessReference(storage: PostgresStorage, label: string) {
  const { input } = await resolveRoomTemplateCreate(storage, { roomId: roomId(label), tenantId, templateId: "personal-room-basic",
    name: "Ownerless reference", roomType: "personal" }, { allowUnownedPersonal: true });
  return storage.createAdministrativeRoom(input);
}

test("rollback guard probes classify real room records and fail closed on corrupt snapshots", {
  skip: !url && !process.env.CI, timeout: 90_000
}, async t => {
  const guard = await rollbackGuard(), pool = (await isolated(t, "reader_guard")).open();
  const ownerless = () => probe(pool, guard.OWNERLESS_REFERENCE_PERSONAL_SQL);
  assert.equal(await probe(pool, guard.ROOM_RECORD_SCHEMA_SQL), false, "an empty namespace has no room-record schema");
  const storage = new PostgresStorage(pool); await storage.init();
  assert.equal(await probe(pool, guard.ROOM_RECORD_SCHEMA_SQL), true);
  assert.equal(await ownerless(), false);
  const legacy = await storage.createAdministrativeRoom({ roomId: roomId("legacy"), tenantId, roomType: "personal", templateId: "personal-workspace-basic", name: "Legacy ownerless" });
  assert.deepEqual([legacy.ownerParticipantId, roomTemplateSessionContext(legacy)], [null, undefined]);
  assert.equal(await ownerless(), false, "legacy ownerless personal records are readable by every reader");
  const legacySnapshot = await snapshotEditor(pool, legacy.roomId);
  await legacySnapshot.set("to_jsonb(snapshot::text)");
  assert.equal(await legacySnapshot.type(), "string");
  assert.equal(await ownerless(), false, "string-encoded legacy snapshots are decoded, not misclassified");
  for (const [label, value, expected] of [
    ["JSON null", null, true], ["array", [], true], ["scalar", 42, true], ["string-encoded array", "[]", true],
    ["partial reference marker", { assetLock: {} }, true], ["string-encoded reference marker", JSON.stringify({ scene: null }), true],
    ["object without reference markers", { schemaVersion: 1 }, false], ["string-encoded object without markers", JSON.stringify({ schemaVersion: 1 }), false]
  ] as const) {
    await legacySnapshot.set("$3::jsonb", JSON.stringify(value));
    assert.equal(await ownerless(), expected, label);
  }
  await legacySnapshot.set("to_jsonb($3::text)", `{"roomId":"${legacy.roomId}"`);
  await assert.rejects(ownerless(), error => error instanceof Error && /invalid input syntax for type json/.test(error.message)
    && !error.message.includes(legacy.roomId));
  await legacySnapshot.restore();
  assert.equal(await ownerless(), false);
  assert.equal((await storage.getRoom(legacy.roomId))?.ownerParticipantId, null);
  await storage.transitionReferenceTemplateCatalog("active");
  const owned = await storage.createAdministrativeRoom({ roomId: roomId("owned"), tenantId, roomType: "personal", templateId: "personal-room-basic",
    name: "Owned reference", ownerParticipantId: "legacy-owner" });
  assert.ok(roomTemplateSessionContext(owned));
  assert.equal(await ownerless(), false, "non-null reference owners are readable by every reader");
  assert.equal(await storage.identityProtocol.raise(2), 2);
  const unowned = await ownerlessReference(storage, "unowned");
  assert.equal(await ownerless(), true);
  const referenceSnapshot = await snapshotEditor(pool, unowned.roomId);
  await referenceSnapshot.set("to_jsonb(snapshot::text)");
  assert.equal(await referenceSnapshot.type(), "string");
  assert.equal(await ownerless(), true);
  await referenceSnapshot.restore();
  await pool.query("alter table template_versions alter column snapshot type text using snapshot::text");
  assert.equal(await probe(pool, guard.ROOM_RECORD_SCHEMA_SQL), false, "the schema probe requires the jsonb snapshot the readers bind");
});

test("exact reader-two rollback reopens ownerless personal references the accepted boundary cannot read", {
  skip: process.env.CI || (url && pinnedLocally) ? false : `requires VRATA_TEST_POSTGRES_URL, ${READER.env} and ${BOUNDARY.env}`, timeout: 120_000
}, async t => {
  assert.ok(url, "CI requires VRATA_TEST_POSTGRES_URL");
  const readerModule = pinnedStorage(READER)!, boundaryModule = pinnedStorage(BOUNDARY)!;
  const { PostgresStorage: ReaderStorage } = await import(readerModule) as StorageModule;
  const { PostgresStorage: BoundaryStorage } = await import(boundaryModule) as StorageModule;
  const guard = await rollbackGuard(), { open } = await isolated(t, "reader_rollback");
  const pool = open(), storage = new PostgresStorage(pool); await storage.init();
  assert.equal(await probe(pool, guard.ROOM_RECORD_SCHEMA_SQL), true);
  await storage.transitionReferenceTemplateCatalog("active");
  assert.equal(await storage.identityProtocol.raise(2), 2);
  const boundary = new BoundaryStorage(open()); await boundary.init();
  const ordinary = await storage.createAdministrativeRoom({ roomId: roomId("ordinary"), tenantId, templateId: "meeting-room-basic", name: "Ordinary meeting" });
  assert.equal(await probe(pool, guard.OWNERLESS_REFERENCE_PERSONAL_SQL), false);
  const personal = await ownerlessReference(storage, "personal");
  assert.deepEqual([personal.roomType, personal.ownerParticipantId, personal.visibility, personal.guestAllowed], ["personal", null, "private", false]);
  assert.ok(roomTemplateSessionContext(personal));
  assert.equal(await probe(pool, guard.OWNERLESS_REFERENCE_PERSONAL_SQL), true);
  const frozen = async () => (await pool.query(`select room_type,owner_participant_id,visibility,guest_allowed,template_id,template_version,
    template_snapshot->'assetLock' as asset_lock from rooms where room_id=$1`, [personal.roomId])).rows[0];
  const created = await frozen();
  assert.deepEqual([created.owner_participant_id, created.visibility, created.guest_allowed], [null, "private", false]);
  assert.deepEqual(created.asset_lock, personal.templateSnapshot.assetLock);
  const view = (room: RoomRecord | null | undefined) => [room?.roomId, room?.templateId, room?.templateVersion, room?.roomType,
    room?.ownerParticipantId, room?.visibility, room?.guestAllowed, room?.templateSnapshot?.assetLock];
  const refused = async (label: string) => {
    await assert.rejects(boundary.getRoom(personal.roomId), { message: "invalid_reference_personal_configuration" }, label);
    await assert.rejects(boundary.listRooms(), { message: "invalid_reference_personal_configuration" }, label);
    assert.equal((await boundary.getRoom(ordinary.roomId))?.roomId, ordinary.roomId, label);
  };
  const accepted = async (label: string) => {
    const reader = new ReaderStorage(open()); await reader.init();
    assert.deepEqual(view(await reader.getRoom(personal.roomId)), view(personal), label);
    const listed = await reader.listRooms();
    assert.deepEqual(view(listed.find(room => room.roomId === personal.roomId)), view(personal), label);
    assert.equal(listed.find(room => room.roomId === ordinary.roomId)?.name, ordinary.name, label);
    const name = `Renamed by reader rollback ${label}`;
    const renamed = await reader.updateRoom(personal.roomId, { name, theme: { primaryColor: "#111111", accentColor: "#222222" } });
    assert.equal(renamed?.name, name, label); assert.deepEqual(view(renamed), view(personal), label);
    await assert.rejects(reader.updateRoom(personal.roomId, { ownerParticipantId: "late-owner" }));
    assert.deepEqual(await frozen(), created, label);
    assert.equal((await storage.getRoom(personal.roomId))?.name, name, label);
  };
  await refused("before handoff"); await accepted("before handoff");
  const scope = { tenantId, roomId: personal.roomId };
  const invite = await storage.createRoomInviteV2({ roomId: personal.roomId, role: "member", waitingRoomEnabled: false,
    tokenHash: randomBytes(32).toString("base64url"), expiresAt: new Date(Date.now() + 600_000).toISOString(), actor: admin });
  const recipient = await storage.roomIdentities.admit({ ...scope, displayName: "Recipient", inviteTokenHash: invite.tokenHash });
  const authority = await storage.roomIdentities.authority(scope);
  assert.deepEqual([authority?.ownerIdentityId, authority?.hostIdentityId], [null, null]);
  await storage.roomIdentities.transition(scope, admin, authority!.revision, { type: "transfer-owner", targetParticipantId: recipient.participantId });
  const handedOff = await storage.roomIdentities.authority(scope);
  assert.equal(handedOff?.ownerIdentityId, recipient.identityId);
  assert.equal((await storage.roomIdentities.resolve(recipient))?.isOwner, true);
  assert.deepEqual(await frozen(), created, "owner handoff is identity authority, not a raw owner write");
  assert.equal(await probe(pool, guard.OWNERLESS_REFERENCE_PERSONAL_SQL), true);
  await refused("after handoff"); await accepted("after handoff");
  assert.deepEqual(await storage.roomIdentities.authority(scope), handedOff, "reader metadata writes leave authority untouched");
  assert.equal((await storage.roomIdentities.resolve(recipient))?.isOwner, true);
});
