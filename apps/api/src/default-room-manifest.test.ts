import assert from "node:assert/strict";
import { IncomingMessage, type IncomingHttpHeaders } from "node:http";
import { Socket } from "node:net";
import test from "node:test";
import type { RoomTemplateVersionSnapshotV1 } from "@vrata/shared-types";
import { getCurrentTemplateVersion } from "@vrata/templates";

import { defaultManifest } from "./default-room-manifest.js";

const environmentKeys = [
  "NODE_ENV", "ROOM_STATE_PUBLIC_URL", "VRATA_DEV_ROLE_QUERY", "NOAH_DEV_ROLE_QUERY", "FEATURE_DEV_ROLE_QUERY",
  "FEATURE_AVATAR_POSE_BINARY", "FEATURE_AVATAR_LIPSYNC", "FEATURE_AVATAR_LEG_IK", "FEATURE_AVATAR_CUSTOMIZATION",
  "FEATURE_SPATIAL_AUDIO", "SPATIAL_AUDIO_ENABLED", "FEATURE_XR", "XR_ENABLED"
] as const;

// Environment checks are synchronous; every changed key is restored.
function withEnvironment(env: NodeJS.ProcessEnv, check: () => void): void {
  const saved = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of environmentKeys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    check();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function request(headers: IncomingHttpHeaders): IncomingMessage {
  const message = new IncomingMessage(new Socket());
  message.headers = headers;
  return message;
}

function template(): RoomTemplateVersionSnapshotV1 {
  return { schemaVersion: 1, templateId: "custom-template", version: "7.2.1", label: "Custom template", assetSlots: ["custom-slot"] };
}

const roomConfig = {
  roomType: "standard", visibility: "public", guestAllowed: true, sceneBundleUrl: null,
  features: { voice: true, spatialAudio: true, screenShare: true },
  theme: { primaryColor: "#5fc8ff", accentColor: "#163354" },
  avatarConfig: {
    avatarsEnabled: true, avatarCatalogUrl: "/assets/avatars/catalog.v1.json", avatarQualityProfile: "desktop-standard",
    avatarFallbackCapsulesEnabled: true, avatarSeatsEnabled: true
  }
};

const avatars = {
  avatarsEnabled: true, avatarCatalogUrl: "/assets/avatars/catalog.v1.json", avatarQualityProfile: "desktop-standard",
  avatarPoseBinaryEnabled: true, avatarLipsyncEnabled: false, avatarLegIkEnabled: false,
  avatarFallbackCapsulesEnabled: true, avatarSeatsEnabled: true, avatarCustomizationEnabled: false
};

test("default manifest preserves the complete contract with a resolved template", () => withEnvironment({}, () => {
  const resolved = template();
  assert.deepEqual(defaultManifest("room-1", undefined, resolved), {
    schemaVersion: 1, tenantId: "demo-tenant", roomId: "room-1", roomType: "standard", ownerParticipantId: null,
    template: "meeting-room-basic", templateVersion: "7.2.1",
    templateSnapshot: { ...resolved, roomConfig }, sceneBundle: undefined,
    realtime: { roomStateUrl: "ws://127.0.0.1:2567" },
    theme: roomConfig.theme, assets: [], features: roomConfig.features, avatars,
    quality: { default: "desktop-standard", mobile: "mobile-lite", xr: "xr" },
    access: { joinMode: "link", guestAllowed: true, roleQueryAllowed: true, visibility: "public", disabled: false }
  });
}));

test("omitted and runtime-null templates use the current seed template", () => withEnvironment({}, () => {
  const seed = getCurrentTemplateVersion("meeting-room-basic");
  assert.ok(seed);
  const expected = { ...seed, roomConfig };
  assert.deepEqual(defaultManifest("room").templateSnapshot, expected);
  assert.deepEqual(defaultManifest("room", undefined, null as unknown as RoomTemplateVersionSnapshotV1).templateSnapshot, expected);
}));

test("resolved template takes precedence without normalizing its version or room identity", () => withEnvironment({}, () => {
  const resolved = { ...template(), version: "" };
  const result = defaultManifest(" room/a?b=1 ", undefined, resolved);
  assert.equal(result.roomId, " room/a?b=1 ");
  assert.equal(result.templateVersion, "");
  assert.equal(result.templateSnapshot.schemaVersion, 1);
  assert.equal(result.templateSnapshot.templateId, "custom-template");
  assert.equal(result.template, "meeting-room-basic");
}));

test("snapshot shallow-copies the supplied template but replaces its roomConfig", () => withEnvironment({}, () => {
  const resolved = { ...template(), roomConfig: { custom: true }, extraMetadata: { source: "stored" } };
  const before = structuredClone(resolved);
  const result = defaultManifest("room", undefined, resolved);
  assert.deepEqual(resolved, before);
  assert.notEqual(result.templateSnapshot, resolved);
  assert.equal(result.templateSnapshot.assetSlots, resolved.assetSlots);
  assert.equal((result.templateSnapshot as unknown as typeof resolved).extraMetadata, resolved.extraMetadata);
  assert.notEqual(result.templateSnapshot.roomConfig, resolved.roomConfig);
  assert.deepEqual(result.templateSnapshot.roomConfig, roomConfig);
}));

test("each call allocates independent defaults while retaining supplied nested template references", () => withEnvironment({}, () => {
  const resolved = template();
  const first = defaultManifest("room-1", undefined, resolved);
  const second = defaultManifest("room-2", undefined, resolved);
  for (const key of ["templateSnapshot", "realtime", "theme", "assets", "features", "avatars", "quality", "access"] as const) {
    assert.notEqual(first[key], second[key], key);
  }
  assert.notEqual(first.templateSnapshot.roomConfig, second.templateSnapshot.roomConfig);
  assert.notEqual(first.templateSnapshot.roomConfig.theme, first.theme);
  assert.notEqual(first.templateSnapshot.roomConfig.features, first.features);
  assert.equal(first.templateSnapshot.assetSlots, second.templateSnapshot.assetSlots);
  first.theme.primaryColor = "changed";
  first.features.voice = false;
  first.templateSnapshot.roomConfig.theme.primaryColor = "snapshot changed";
  assert.deepEqual(second.theme, roomConfig.theme);
  assert.deepEqual(second.features, roomConfig.features);
  assert.deepEqual(second.templateSnapshot.roomConfig, roomConfig);
}));

test("the absent scene bundle remains an own undefined property and is omitted only in JSON", () => withEnvironment({}, () => {
  const result = defaultManifest("room", undefined, template());
  assert.equal(Object.hasOwn(result, "sceneBundle"), true);
  assert.equal(result.sceneBundle, undefined);
  const json = JSON.parse(JSON.stringify(result));
  assert.equal(Object.hasOwn(json, "sceneBundle"), false);
  assert.equal(json.ownerParticipantId, null);
  assert.equal(json.templateSnapshot.roomConfig.sceneBundleUrl, null);
}));

const endpointCases: Array<{ name: string; env?: NodeJS.ProcessEnv; headers?: IncomingHttpHeaders; expected: string }> = [
  { name: "missing request", expected: "ws://127.0.0.1:2567" },
  { name: "local host", headers: { host: "localhost:4000" }, expected: "ws://localhost:2567" },
  { name: "HTTPS proxy", headers: { host: "internal:4000", "x-forwarded-host": "203.0.113.10.sslip.io", "x-forwarded-proto": "https" }, expected: "wss://state.203.0.113.10.sslip.io" },
  { name: "custom domain", headers: { host: "app.example", "x-forwarded-proto": "https" }, expected: "wss://state-app.example" },
  { name: "explicit secure URL", env: { ROOM_STATE_PUBLIC_URL: "wss://state.example/custom" }, headers: { host: "app.example" }, expected: "wss://state.example/custom" },
  { name: "insecure setting behind HTTPS", env: { ROOM_STATE_PUBLIC_URL: "ws://internal:2567" }, headers: { host: "app.example", "x-forwarded-proto": "https" }, expected: "wss://state-app.example" },
  { name: "empty setting without host", env: { ROOM_STATE_PUBLIC_URL: "" }, expected: "" }
];
for (const { name, env, headers, expected } of endpointCases) {
  test(`default manifest forwards room-state endpoint inputs: ${name}`, () => withEnvironment(env ?? {}, () => {
    assert.equal(defaultManifest("room", headers ? request(headers) : undefined, template()).realtime.roomStateUrl, expected);
  }));
}

const roleCases = [
  { name: "development default", env: {}, expected: true },
  { name: "production default", env: { NODE_ENV: "production" }, expected: false },
  { name: "explicit production override", env: { NODE_ENV: "production", VRATA_DEV_ROLE_QUERY: "yes" }, expected: true },
  { name: "current override precedes legacy", env: { VRATA_DEV_ROLE_QUERY: "false", NOAH_DEV_ROLE_QUERY: "true" }, expected: false },
  { name: "legacy override", env: { NODE_ENV: "production", NOAH_DEV_ROLE_QUERY: "true" }, expected: true },
  { name: "feature override", env: { FEATURE_DEV_ROLE_QUERY: "off" }, expected: false }
];
for (const { name, env, expected } of roleCases) {
  test(`default manifest keeps role-query policy: ${name}`, () => withEnvironment(env, () => {
    assert.equal(defaultManifest("room", undefined, template()).access.roleQueryAllowed, expected);
  }));
}

test("environment is read at call time, not captured when the module is imported", () => withEnvironment({}, () => {
  const first = defaultManifest("room");
  process.env.NODE_ENV = "production";
  process.env.ROOM_STATE_PUBLIC_URL = "wss://changed.example";
  const second = defaultManifest("room");
  assert.equal(first.access.roleQueryAllowed, true);
  assert.equal(first.realtime.roomStateUrl, "ws://127.0.0.1:2567");
  assert.equal(second.access.roleQueryAllowed, false);
  assert.equal(second.realtime.roomStateUrl, "wss://changed.example");
}));

test("seed defaults deliberately ignore avatar and spatial feature overrides", () => withEnvironment({
  FEATURE_AVATAR_POSE_BINARY: "false", FEATURE_AVATAR_LIPSYNC: "true", FEATURE_AVATAR_LEG_IK: "true",
  FEATURE_AVATAR_CUSTOMIZATION: "true", FEATURE_SPATIAL_AUDIO: "false", SPATIAL_AUDIO_ENABLED: "false",
  FEATURE_XR: "false", XR_ENABLED: "false"
}, () => {
  const result = defaultManifest("room", undefined, template());
  assert.deepEqual(result.avatars, avatars);
  assert.deepEqual(result.features, roomConfig.features);
  assert.deepEqual(result.templateSnapshot.roomConfig, roomConfig);
}));
