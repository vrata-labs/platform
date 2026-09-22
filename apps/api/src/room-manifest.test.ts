import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { getCurrentTemplateVersion } from "@vrata/templates";

import type { AssetRecord, RoomRecord, Storage } from "./storage.js";
import { defaultManifest } from "./default-room-manifest.js";
import { createRoomManifestBuilder } from "./room-manifest.js";

type ManifestStorage = Pick<Storage, "getRoom" | "getTemplateVersion" | "listAssets">;

function roomFixture(overrides: Partial<RoomRecord> = {}): RoomRecord {
  const manifest = defaultManifest("room-a");
  return {
    roomId: "room-a", tenantId: "tenant-a", name: "Room A",
    templateId: manifest.template, templateVersion: manifest.templateVersion,
    templateSnapshot: manifest.templateSnapshot,
    features: { voice: false, spatialAudio: true, screenShare: false }, assetIds: [],
    ...overrides
  };
}

function fixture(room: RoomRecord | null = roomFixture(), assets: AssetRecord[] = []) {
  const calls: string[] = [];
  const storage: ManifestStorage = {
    async getRoom(id) { calls.push(`room:${id}`); return room; },
    async getTemplateVersion(id) { calls.push(`template:${id}`); return getCurrentTemplateVersion(id) ?? null; },
    async listAssets() { calls.push("assets"); return assets; }
  };
  return { storage, calls, build: createRoomManifestBuilder(Promise.resolve(storage)) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const environmentKeys = [
  "NODE_ENV", "VRATA_DEV_ROLE_QUERY", "NOAH_DEV_ROLE_QUERY", "FEATURE_DEV_ROLE_QUERY",
  "ROOM_STATE_PUBLIC_URL", "FEATURE_AVATAR_POSE_BINARY", "FEATURE_AVATAR_LIPSYNC",
  "FEATURE_AVATAR_LEG_IK", "FEATURE_AVATAR_CUSTOMIZATION"
];

async function withEnv(values: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const previous = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of environmentKeys) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("factory does not read storage before a build and each build reloads the room", async () => {
  const { calls, build } = fixture();
  await Promise.resolve();
  assert.deepEqual(calls, []);
  await build("requested-a");
  await build("requested-b");
  assert.deepEqual(calls, ["room:requested-a", "assets", "room:requested-b", "assets"]);
});

test("storage readiness and room lookup are awaited before listing assets", async () => {
  const ready = deferred<ManifestStorage>();
  const room = deferred<RoomRecord | null>();
  const { storage, calls } = fixture();
  storage.getRoom = async () => { calls.push("room-start"); return room.promise; };
  const building = createRoomManifestBuilder(ready.promise)("room-a");
  await Promise.resolve();
  assert.deepEqual(calls, []);
  ready.resolve(storage);
  await Promise.resolve();
  assert.deepEqual(calls, ["room-start"]);
  room.resolve(roomFixture());
  await building;
  assert.deepEqual(calls, ["room-start", "assets"]);
});

test("storage initialization rejection reaches the caller unchanged", async () => {
  const error = new Error("storage unavailable");
  await assert.rejects(createRoomManifestBuilder(Promise.reject(error))("room-a"), (value) => value === error);
});

for (const method of ["getRoom", "getTemplateVersion", "listAssets"] as const) {
  test(`${method} rejection propagates without additional storage calls`, async () => {
    const { storage, calls } = fixture(method === "getTemplateVersion" ? null : roomFixture());
    const error = new Error(method);
    storage[method] = async () => { calls.push(`failed:${method}`); throw error; };
    await assert.rejects(createRoomManifestBuilder(Promise.resolve(storage))("room-a"), (value) => value === error);
    assert.deepEqual(calls, method === "getRoom" ? ["failed:getRoom"] : ["room:room-a", `failed:${method}`]);
  });
}

test("missing rooms use the storage template version and do not list assets", async () => {
  const { storage, calls } = fixture(null);
  const original = getCurrentTemplateVersion("meeting-room-basic");
  assert.ok(original);
  const version = { ...original, version: "stored-version" };
  storage.getTemplateVersion = async (id, requestedVersion) => {
    calls.push(`template:${id}`);
    assert.equal(requestedVersion, "0.1.0");
    return version;
  };
  const request = { headers: { host: "example.test", "x-forwarded-proto": "https" } } as unknown as IncomingMessage;
  const actual = await createRoomManifestBuilder(Promise.resolve(storage))("absent", request);
  assert.deepEqual(actual, defaultManifest("absent", request, version));
  assert.equal(actual.templateVersion, "stored-version");
  assert.deepEqual(calls, ["room:absent", "template:meeting-room-basic"]);
});

test("missing fallback template retains the exact error", async () => {
  const { storage, calls } = fixture(null);
  storage.getTemplateVersion = async () => null;
  await assert.rejects(createRoomManifestBuilder(Promise.resolve(storage))("absent"), {
    message: "template_version_not_found:meeting-room-basic"
  });
  assert.deepEqual(calls, ["room:absent"]);
});

test("stored room metadata wins over request ID and template snapshot defaults", async () => {
  const room = roomFixture({ roomId: "stored-id", roomType: "personal", templateId: "stored-template", templateVersion: "stored-version", ownerParticipantId: "owner" });
  const result = await fixture(room).build("requested-id");
  assert.equal(result.roomId, "stored-id");
  assert.equal(result.tenantId, "tenant-a");
  assert.equal(result.roomType, "personal");
  assert.equal(result.ownerParticipantId, "owner");
  assert.equal(result.template, "stored-template");
  assert.equal(result.templateVersion, "stored-version");
  assert.strictEqual(result.templateSnapshot, room.templateSnapshot);
  assert.strictEqual(result.features, room.features);
});

test("asset selection follows storage order including duplicate records without tenant filtering", async () => {
  const asset = (assetId: string, tenantId = "tenant-a"): AssetRecord => ({ assetId, tenantId, kind: "model", url: `https://assets.test/${assetId}` });
  const assets = [asset("b"), asset("excluded"), asset("a", "other-tenant"), asset("b")];
  const result = await fixture(roomFixture({ assetIds: ["a", "b", "a", "missing"] }), assets).build("room-a");
  assert.deepEqual(result.assets.map((item) => item.assetId), ["b", "a", "b"]);
  assert.deepEqual(assets.map((item) => item.assetId), ["b", "excluded", "a", "b"]);
});

test("asset projection preserves optional fields and order without leaking storage fields", async () => {
  const asset: AssetRecord = { assetId: "a", tenantId: "secret-tenant", kind: "model", url: "raw", processedUrl: "processed", validationStatus: "rejected" };
  const result = await fixture(roomFixture({ assetIds: ["a"] }), [asset]).build("room-a");
  assert.deepEqual(result.assets, [{ assetId: "a", kind: "model", url: "raw", processedUrl: "processed", validationStatus: "rejected" }]);
  assert.deepEqual(Object.keys(result.assets[0]!), ["assetId", "kind", "url", "processedUrl", "validationStatus"]);
  assert.notStrictEqual(result.assets[0], asset);
  assert.equal(asset.tenantId, "secret-tenant");
});

test("existing theme, features and template snapshot keep their references", async () => {
  const room = roomFixture({ theme: { primaryColor: "", accentColor: "custom" } });
  const before = structuredClone(room);
  const result = await fixture(room).build("room-a");
  assert.strictEqual(result.theme, room.theme);
  assert.strictEqual(result.features, room.features);
  assert.strictEqual(result.templateSnapshot, room.templateSnapshot);
  assert.deepEqual(room, before);
});

test("nullish room fields retain their defaults and fresh fallback objects", async () => {
  const room = roomFixture({ roomType: undefined, ownerParticipantId: undefined, guestAllowed: undefined });
  const { build } = fixture(room);
  const first = await build("room-a");
  const second = await build("room-a");
  assert.equal(first.roomType, "standard");
  assert.equal(first.ownerParticipantId, null);
  assert.equal(first.access.guestAllowed, true);
  assert.deepEqual(first.theme, { primaryColor: "#5fc8ff", accentColor: "#163354" });
  assert.notStrictEqual(first.theme, second.theme);
  assert.notStrictEqual(first.avatars, second.avatars);
  assert.notStrictEqual(first.quality, second.quality);
  Object.assign(room, { roomType: null, ownerParticipantId: null, guestAllowed: null, theme: null, avatarConfig: null });
  const third = await build("room-a");
  assert.equal(third.roomType, "standard");
  assert.equal(third.access.guestAllowed, true);
  assert.deepEqual(third.theme, first.theme);
});

test("false avatar and guest options and empty owner/catalog strings are retained", async () => {
  const room = roomFixture({ guestAllowed: false, ownerParticipantId: "", avatarConfig: {
    avatarsEnabled: false, avatarCatalogUrl: "", avatarQualityProfile: "mobile-lite",
    avatarFallbackCapsulesEnabled: false, avatarSeatsEnabled: false
  } });
  const result = await fixture(room).build("room-a");
  assert.equal(result.access.guestAllowed, false);
  assert.equal(result.ownerParticipantId, "");
  assert.equal(result.avatars.avatarsEnabled, false);
  assert.equal(result.avatars.avatarCatalogUrl, "");
  assert.equal(result.avatars.avatarQualityProfile, "mobile-lite");
  assert.equal(result.avatars.avatarFallbackCapsulesEnabled, false);
  assert.equal(result.avatars.avatarSeatsEnabled, false);
});

test("scene URL truthiness is preserved without trimming or validation", async () => {
  for (const sceneBundleUrl of [undefined, "", " ", "relative/scene.json", "https://assets.test/scene.json"]) {
    const result = await fixture(roomFixture({ sceneBundleUrl })).build("room-a");
    assert.ok(Object.hasOwn(result, "sceneBundle"));
    assert.deepEqual(result.sceneBundle, sceneBundleUrl ? { url: sceneBundleUrl } : undefined);
  }
});

test("visibility and disabled flags preserve the existing rules independently of session locks", async () => {
  for (const [visibility, status, disabledAt, expectedVisibility, disabled] of [
    ["private", "active", undefined, "private", false], ["unlisted", "disabled", undefined, "unlisted", true],
    ["invalid", "active", "not-a-date", "public", true], [undefined, "active", "", "public", false]
  ] as const) {
    const room = roomFixture({ sessionControl: { lockedAt: "locked", endedAt: "ended" } });
    Object.assign(room, { visibility, status, disabledAt });
    const result = await fixture(room).build("room-a");
    assert.equal(result.access.visibility, expectedVisibility);
    assert.equal(result.access.disabled, disabled);
  }
});

for (const value of [undefined, "true", "false", "TRUE", "", " false "]) {
  test(`avatar environment flags retain exact string comparisons for ${JSON.stringify(value)}`, async () => {
    const values = value === undefined ? {} : Object.fromEntries([
      "FEATURE_AVATAR_POSE_BINARY", "FEATURE_AVATAR_LIPSYNC", "FEATURE_AVATAR_LEG_IK", "FEATURE_AVATAR_CUSTOMIZATION"
    ].map((key) => [key, value]));
    await withEnv(values, async () => {
      const result = await fixture().build("room-a");
      assert.equal(result.avatars.avatarPoseBinaryEnabled, value !== "false");
      for (const key of ["avatarLipsyncEnabled", "avatarLegIkEnabled", "avatarCustomizationEnabled"] as const) {
        assert.equal(result.avatars[key], value === "true");
      }
      assert.equal(result.avatars.avatarsEnabled, true);
      assert.equal(result.avatars.avatarQualityProfile, "desktop-standard");
    });
  });
}

test("environment is read after asset loading and again on subsequent calls", async () => {
  await withEnv({ FEATURE_AVATAR_LIPSYNC: "false", NODE_ENV: "production" }, async () => {
    const assets = deferred<AssetRecord[]>();
    const started = deferred<boolean>();
    const { storage } = fixture();
    storage.listAssets = async () => { started.resolve(true); return assets.promise; };
    const build = createRoomManifestBuilder(Promise.resolve(storage));
    const pending = build("room-a");
    await started.promise;
    process.env.FEATURE_AVATAR_LIPSYNC = "true";
    process.env.VRATA_DEV_ROLE_QUERY = "true";
    assets.resolve([]);
    const first = await pending;
    assert.equal(first.avatars.avatarLipsyncEnabled, true);
    assert.equal(first.access.roleQueryAllowed, true);
    process.env.FEATURE_AVATAR_LIPSYNC = "false";
    process.env.VRATA_DEV_ROLE_QUERY = "false";
    const second = await build("room-a");
    assert.equal(second.avatars.avatarLipsyncEnabled, false);
    assert.equal(second.access.roleQueryAllowed, false);
  });
});

test("room state URL preserves request forwarding and configured URL behavior", async () => {
  const request = { headers: { host: "internal:4000", "x-forwarded-host": "public.test, proxy", "x-forwarded-proto": "https" } } as unknown as IncomingMessage;
  await withEnv({}, async () => {
    const { build } = fixture();
    assert.equal((await build("room-a", request)).realtime.roomStateUrl, "wss://state-public.test");
    process.env.ROOM_STATE_PUBLIC_URL = "wss://configured.test/custom";
    assert.equal((await build("room-a", request)).realtime.roomStateUrl, "wss://configured.test/custom");
    process.env.ROOM_STATE_PUBLIC_URL = "ws://internal:2567";
    assert.equal((await build("room-a", request)).realtime.roomStateUrl, "wss://state-public.test");
  });
});

test("manifest field order and undefined asset fields remain unchanged", async () => {
  const result = await fixture(roomFixture({ assetIds: ["a"] }), [{ assetId: "a", tenantId: "t", kind: "model", url: "a" }]).build("room-a");
  assert.deepEqual(Object.keys(result), ["schemaVersion", "tenantId", "roomId", "roomType", "ownerParticipantId", "template", "templateVersion", "templateSnapshot", "sceneBundle", "realtime", "theme", "assets", "features", "avatars", "quality", "access"]);
  assert.ok(Object.hasOwn(result.assets[0]!, "processedUrl"));
  assert.ok(Object.hasOwn(result.assets[0]!, "validationStatus"));
  assert.equal(JSON.stringify(result.assets), '[{"assetId":"a","kind":"model","url":"a"}]');
});

test("builders remain bound to their own storage and retain method receivers", async () => {
  const first = fixture(roomFixture({ roomId: "first" }));
  const second = fixture(roomFixture({ roomId: "second" }));
  const getRoom = first.storage.getRoom;
  first.storage.getRoom = async function (id) { assert.strictEqual(this, first.storage); return getRoom(id); };
  assert.equal((await first.build("x")).roomId, "first");
  assert.equal((await second.build("x")).roomId, "second");
  assert.equal((await first.build("y")).roomId, "first");
});
