import test from "node:test";
import assert from "node:assert/strict";
import { isMediaObjectTypeAvailable } from "@vrata/shared-types";

import {
  STANDARD_ROOM_ASSETS_COMMIT_SHA,
  getStandardRoomTemplateSceneContract,
  getStandardRoomTemplateVersionContract,
  listStandardRoomTemplateSceneContracts,
  listStandardRoomTemplateVersionContracts,
  resolveRoomTemplateAssetUrl,
  templates,
  validateRoomTemplateAssetLock,
  validateRoomTemplateVersionContract,
  type TemplateDefinition
} from "./index.js";
import type { RoomTemplateAssetLock, RoomTemplateVersionContractV1 } from "@vrata/shared-types";
import { createSpaceManifest, getCurrentTemplateVersion, getTemplateDefinition, getTemplateVersion, listTemplateDefinitions } from "./registry.js";

test("createSpaceManifest resolves template slot config", () => {
  const manifest = createSpaceManifest("meeting-room-basic");
  assert.equal(manifest.templateId, "meeting-room-basic");
  assert.deepEqual(manifest.assetSlots, ["logo", "hero-screen"]);
});

test("legacy public catalog preserves mutable shape and reference behavior", () => {
  assert.deepEqual(Object.keys(templates[0] ?? {}).sort(), ["assetSlots", "id", "label"]);
  assert.equal(Object.isFrozen(templates), false);
  assert.equal(Object.isFrozen(templates[0]), false);
  assert.equal(Object.isFrozen(templates[0]?.assetSlots), false);

  const definition = getTemplateDefinition("meeting-room-basic");
  assert.ok(definition);
  const originalLabel = definition.label;
  const originalSlots = [...definition.assetSlots];
  const added: TemplateDefinition = { id: "legacy-added-template", label: "Legacy Added", assetSlots: ["logo"] };
  try {
    definition.label = "Mutated Legacy Label";
    definition.assetSlots.push("legacy-slot");
    templates.push(added);

    assert.equal(getTemplateDefinition("meeting-room-basic"), definition);
    assert.equal(getTemplateDefinition(added.id), added);
    const manifest = createSpaceManifest("meeting-room-basic");
    assert.equal(manifest.assetSlots, definition.assetSlots);
    assert.deepEqual(manifest.assetSlots, [...originalSlots, "legacy-slot"]);
  } finally {
    definition.label = originalLabel;
    definition.assetSlots.splice(0, definition.assetSlots.length, ...originalSlots);
    templates.splice(templates.indexOf(added), 1);
  }
});

test("versioned registry exposes only the four active 0.1.0 templates", () => {
  assert.deepEqual(
    listTemplateDefinitions().map(({ id, version, status }) => ({ id, version, status })),
    [
      { id: "meeting-room-basic", version: "0.1.0", status: "active" },
      { id: "showroom-basic", version: "0.1.0", status: "active" },
      { id: "event-demo-basic", version: "0.1.0", status: "active" },
      { id: "personal-workspace-basic", version: "0.1.0", status: "active" }
    ]
  );
});

test("standard room scene contracts remain separate from the active catalog seed", () => {
  const contracts = listStandardRoomTemplateSceneContracts();
  assert.deepEqual(
    contracts.map(({ templateId, templateVersion, sceneId, sceneVersion }) => ({ templateId, templateVersion, sceneId, sceneVersion })),
    [
      { templateId: "personal-room-basic", templateVersion: "1.0.0", sceneId: "personal-workspace-v1", sceneVersion: "1.0.0" },
      { templateId: "meeting-room-basic", templateVersion: "1.0.0", sceneId: "meeting-room-v1", sceneVersion: "1.0.0" },
      { templateId: "presentation-room-basic", templateVersion: "1.0.0", sceneId: "presentation-room-v1", sceneVersion: "1.0.0" }
    ]
  );
  assert.deepEqual(listTemplateDefinitions().map(({ id, version }) => `${id}@${version}`), [
    "meeting-room-basic@0.1.0",
    "showroom-basic@0.1.0",
    "event-demo-basic@0.1.0",
    "personal-workspace-basic@0.1.0"
  ]);
  assert.deepEqual(contracts[0]?.surfaces.map(({ surfaceId }) => surfaceId), ["debug-main"]);
  assert.deepEqual(contracts[1]?.surfaces.map(({ surfaceId }) => surfaceId), ["debug-main", "whiteboard-wall"]);
  assert.deepEqual(contracts[2]?.surfaces.map(({ surfaceId }) => surfaceId), ["debug-main"]);
  assert.deepEqual(contracts.map(({ seats }) => seats), [
    { minimum: 2, maximum: 2 },
    { minimum: 4, maximum: 4 },
    { minimum: 6, maximum: 24 }
  ]);
  for (const contract of contracts) {
    for (const surface of contract.surfaces) {
      assert.equal(surface.allowedObjectTypes.length > 0, true);
      assert.equal(surface.allowedObjectTypes.every(isMediaObjectTypeAvailable), true);
      assert.equal((surface.aspectRatio?.maxRelativeError ?? 1) <= 0.02, true);
    }
  }
});

test("standard room scene contract lookups return defensive clones", () => {
  const personal = getStandardRoomTemplateSceneContract("personal-room-basic", "1.0.0");
  assert.ok(personal);
  personal.sceneId = "spoofed-scene";
  personal.surfaces[0]?.allowedObjectTypes.push("spoofed-object");

  const fresh = getStandardRoomTemplateSceneContract("personal-room-basic", "1.0.0");
  assert.equal(fresh?.sceneId, "personal-workspace-v1");
  assert.equal(fresh?.surfaces[0]?.allowedObjectTypes.includes("spoofed-object"), false);
  assert.equal(getStandardRoomTemplateSceneContract("personal-room-basic", "0.1.0"), undefined);
  assert.equal(getStandardRoomTemplateSceneContract("unknown-template", "1.0.0"), undefined);
});

test("standard room version definitions pin final defaults and exact asset releases", () => {
  const definitions = listStandardRoomTemplateVersionContracts();
  assert.equal(STANDARD_ROOM_ASSETS_COMMIT_SHA, "908331faf0eedb345d60eb1966b89994f5a8fb4b");
  assert.deepEqual(
    definitions.map(({ templateId, version, scene, assetLock }) => ({
      templateId,
      version,
      sceneReleaseId: assetLock.sceneReleaseId,
      sceneId: scene.sceneId,
      commitSha: assetLock.commitSha
    })),
    [
      {
        templateId: "personal-room-basic",
        version: "1.0.0",
        sceneReleaseId: "personal-workspace-v1@1.0.0",
        sceneId: "personal-workspace-v1",
        commitSha: STANDARD_ROOM_ASSETS_COMMIT_SHA
      },
      {
        templateId: "meeting-room-basic",
        version: "1.0.0",
        sceneReleaseId: "meeting-room-v1@1.0.0",
        sceneId: "meeting-room-v1",
        commitSha: STANDARD_ROOM_ASSETS_COMMIT_SHA
      },
      {
        templateId: "presentation-room-basic",
        version: "1.0.0",
        sceneReleaseId: "presentation-room-v1@1.0.0",
        sceneId: "presentation-room-v1",
        commitSha: STANDARD_ROOM_ASSETS_COMMIT_SHA
      }
    ]
  );
  assert.deepEqual(definitions.map(({ defaults }) => defaults.settings.audio.joinMutedByDefault), [false, false, true]);
  assert.deepEqual(definitions.map(({ templateId, label, description, assetSlots, defaults }) => ({
    templateId,
    label,
    description,
    assetSlots,
    roomType: defaults.roomType,
    visibility: defaults.visibility,
    guestAllowed: defaults.guestAllowed,
    features: defaults.features,
    theme: defaults.theme,
    avatarConfig: defaults.avatarConfig,
    settings: defaults.settings
  })), [
    {
      templateId: "personal-room-basic",
      label: "Personal Workspace",
      description: "A private addressable workspace with personal notes and a focused workspace surface.",
      assetSlots: ["logo", "personal-surface"],
      roomType: "personal",
      visibility: "private",
      guestAllowed: false,
      features: { voice: true, spatialAudio: true, screenShare: false },
      theme: { primaryColor: "#7dd3fc", accentColor: "#312e81" },
      avatarConfig: {
        avatarsEnabled: true,
        avatarCatalogUrl: "/assets/avatars/catalog.v1.json",
        avatarQualityProfile: "desktop-standard",
        avatarFallbackCapsulesEnabled: true,
        avatarSeatsEnabled: true
      },
      settings: {
        layout: "personal-workspace",
        notes: { enabled: true, defaultScope: "private" },
        audio: { enabled: true, spatial: true, joinMutedByDefault: false, participantLayout: "owner-focused" },
        presentation: { enabled: false }
      }
    },
    {
      templateId: "meeting-room-basic",
      label: "Meeting Room",
      description: "A small-group room with spatial audio, four participant seats, a shared display, and a collaboration wall.",
      assetSlots: ["logo", "hero-screen"],
      roomType: "standard",
      visibility: "public",
      guestAllowed: true,
      features: { voice: true, spatialAudio: true, screenShare: true },
      theme: { primaryColor: "#5fc8ff", accentColor: "#163354" },
      avatarConfig: {
        avatarsEnabled: true,
        avatarCatalogUrl: "/assets/avatars/catalog.v1.json",
        avatarQualityProfile: "desktop-standard",
        avatarFallbackCapsulesEnabled: true,
        avatarSeatsEnabled: true
      },
      settings: {
        layout: "meeting",
        notes: { enabled: true, defaultScope: "shared" },
        audio: { enabled: true, spatial: true, joinMutedByDefault: false, participantLayout: "round-table" },
        presentation: { enabled: true, surfaceId: "debug-main" }
      }
    },
    {
      templateId: "presentation-room-basic",
      label: "Presentation Room",
      description: "An audience-oriented room with a dedicated presentation surface and presenter media controls.",
      assetSlots: ["logo", "hero-screen", "media-placeholder"],
      roomType: "standard",
      visibility: "public",
      guestAllowed: true,
      features: { voice: true, spatialAudio: true, screenShare: true },
      theme: { primaryColor: "#f59e0b", accentColor: "#1e293b" },
      avatarConfig: {
        avatarsEnabled: true,
        avatarCatalogUrl: "/assets/avatars/catalog.v1.json",
        avatarQualityProfile: "desktop-standard",
        avatarFallbackCapsulesEnabled: true,
        avatarSeatsEnabled: true
      },
      settings: {
        layout: "presentation",
        notes: { enabled: true, defaultScope: "shared" },
        audio: { enabled: true, spatial: true, joinMutedByDefault: true, participantLayout: "audience" },
        presentation: { enabled: true, surfaceId: "debug-main" }
      }
    }
  ]);
  assert.deepEqual(definitions.map(({ scene }) => scene.seats), [
    { minimum: 2, maximum: 2 },
    { minimum: 4, maximum: 4 },
    { minimum: 6, maximum: 24 }
  ]);
  assert.deepEqual(definitions.map(({ defaults }) => defaults.surfaces), [
    [{
      surfaceId: "debug-main",
      label: "Personal workspace",
      purpose: "workspace",
      allowedObjectTypes: ["markdown-board", "image-viewer", "video-player"],
      aspectRatio: { width: 2, height: 1, maxRelativeError: 0.02 }
    }],
    [
      {
        surfaceId: "debug-main",
        label: "Meeting display",
        purpose: "collaboration",
        allowedObjectTypes: ["screen-share", "pdf-presentation", "image-viewer", "video-player", "remote-browser"],
        aspectRatio: { width: 16, height: 9, maxRelativeError: 0.02 }
      },
      {
        surfaceId: "whiteboard-wall",
        label: "Collaboration wall",
        purpose: "collaboration",
        allowedObjectTypes: ["whiteboard", "markdown-board"],
        aspectRatio: { width: 48, height: 25, maxRelativeError: 0.02 }
      }
    ],
    [{
      surfaceId: "debug-main",
      label: "Presentation screen",
      purpose: "presentation",
      allowedObjectTypes: ["pdf-presentation", "screen-share", "image-viewer", "video-player", "remote-browser"],
      aspectRatio: { width: 16, height: 9, maxRelativeError: 0.02 }
    }]
  ]);
  assert.deepEqual(definitions.map(({ assetLock }) => assetLock.releaseManifest), [
    { path: "manifest.json", sha256: "1be3bd12c5ddb6935c11227e64c8175a76d38022d9ebf7e9f598dab059611ce0", sizeBytes: 17865 },
    { path: "manifest.json", sha256: "1be3bd12c5ddb6935c11227e64c8175a76d38022d9ebf7e9f598dab059611ce0", sizeBytes: 17865 },
    { path: "manifest.json", sha256: "1be3bd12c5ddb6935c11227e64c8175a76d38022d9ebf7e9f598dab059611ce0", sizeBytes: 17865 }
  ]);
  for (const definition of definitions) {
    assert.deepEqual(validateRoomTemplateVersionContract(definition), []);
  }

  const personal = definitions[0]!;
  assert.deepEqual({
    roomType: personal.defaults.roomType,
    visibility: personal.defaults.visibility,
    guestAllowed: personal.defaults.guestAllowed,
    screenShare: personal.defaults.features.screenShare,
    noteScope: personal.defaults.settings.notes.defaultScope,
    surfaces: personal.defaults.surfaces.map(({ surfaceId }) => surfaceId)
  }, {
    roomType: "personal",
    visibility: "private",
    guestAllowed: false,
    screenShare: false,
    noteScope: "private",
    surfaces: ["debug-main"]
  });
});

test("standard room version lookups return deep defensive copies", () => {
  const first = getStandardRoomTemplateVersionContract("meeting-room-basic", "1.0.0");
  assert.ok(first);
  first.defaults.theme.primaryColor = "#000000";
  first.defaults.surfaces[0]!.allowedObjectTypes.push("spoofed-object");
  first.assetLock.sceneManifest.path = "spoofed/scene.json";

  const fresh = getStandardRoomTemplateVersionContract("meeting-room-basic", "1.0.0");
  assert.equal(fresh?.defaults.theme.primaryColor, "#5fc8ff");
  assert.equal(fresh?.defaults.surfaces[0]?.allowedObjectTypes.includes("spoofed-object"), false);
  assert.equal(fresh?.assetLock.sceneManifest.path, "assets/scenes/meeting-room-v1/1.0.0/scene.json");
  assert.equal(getStandardRoomTemplateVersionContract("meeting-room-basic", "0.1.0"), undefined);
  assert.equal(getStandardRoomTemplateVersionContract("unknown-template", "1.0.0"), undefined);
});

test("asset lock validation and URL resolution require immutable safe inputs", () => {
  const checksum = "a".repeat(64);
  const lock: RoomTemplateAssetLock = {
    repository: "vrata-labs/scene-assets",
    commitSha: "b".repeat(40),
    sceneReleaseId: "meeting-room-v1@1.0.0",
    releaseManifest: { path: "manifest.json", sha256: checksum, sizeBytes: 100 },
    sceneManifest: { path: "assets/scenes/meeting-room-v1/1.0.0/scene.json", sha256: checksum, sizeBytes: 200 },
    sceneAsset: { path: "assets/scenes/meeting-room-v1/1.0.0/scene.glb", sha256: checksum, sizeBytes: 300 },
    preview: { path: "assets/scenes/meeting-room-v1/1.0.0/preview.webp", sha256: checksum, sizeBytes: 400 }
  };
  assert.deepEqual(validateRoomTemplateAssetLock(lock), []);
  assert.equal(
    resolveRoomTemplateAssetUrl("https://cdn.example/assets@full-sha", lock.sceneManifest.path),
    "https://cdn.example/assets@full-sha/assets/scenes/meeting-room-v1/1.0.0/scene.json"
  );
  assert.equal(
    resolveRoomTemplateAssetUrl("http://127.0.0.1:4000", lock.preview.path, { allowLoopbackHttp: true }),
    "http://127.0.0.1:4000/assets/scenes/meeting-room-v1/1.0.0/preview.webp"
  );

  const invalid = structuredClone(lock);
  invalid.repository = "../..";
  invalid.commitSha = "main";
  invalid.sceneAsset.path = "../scene.glb";
  invalid.preview.sha256 = "bad";
  invalid.releaseManifest.sizeBytes = 0;
  const codes = validateRoomTemplateAssetLock(invalid).map(({ code }) => code);
  assert.equal(codes.includes("invalid_template_asset_repository"), true);
  assert.equal(codes.includes("invalid_template_asset_commit_sha"), true);
  assert.equal(codes.includes("invalid_template_asset_path"), true);
  assert.equal(codes.includes("invalid_template_asset_sha256"), true);
  assert.equal(codes.includes("invalid_template_asset_size"), true);
  const malformedCodes = validateRoomTemplateAssetLock({}).map(({ code }) => code);
  assert.equal(malformedCodes.includes("invalid_template_scene_release_id"), true);
  assert.equal(malformedCodes.includes("invalid_template_asset_file_lock"), true);
  assert.throws(() => resolveRoomTemplateAssetUrl("http://cdn.example", lock.sceneManifest.path), /invalid_template_asset_base_url/);
  assert.throws(() => resolveRoomTemplateAssetUrl("https://cdn.example", "../scene.json"), /invalid_template_asset_path/);
  assert.throws(() => resolveRoomTemplateAssetUrl("https://cdn.example", "assets/%2e%2e/scene.json"), /invalid_template_asset_path/);
  assert.throws(() => resolveRoomTemplateAssetUrl("https://cdn.example", "scene.json?raw=1"), /invalid_template_asset_path/);
  assert.throws(() => resolveRoomTemplateAssetUrl("https://cdn.example/assets%2fencoded", lock.sceneManifest.path), /invalid_template_asset_base_url/);
  assert.throws(() => resolveRoomTemplateAssetUrl("https://cdn.example/immutable/%2e%2e/mutable", lock.sceneManifest.path), /invalid_template_asset_base_url/);
  assert.throws(() => resolveRoomTemplateAssetUrl("https://cdn.example/immutable/../mutable", lock.sceneManifest.path), /invalid_template_asset_base_url/);
  assert.throws(() => resolveRoomTemplateAssetUrl("https://cdn.example/immutable\\mutable", lock.sceneManifest.path), /invalid_template_asset_base_url/);
  assert.throws(() => resolveRoomTemplateAssetUrl("https://cdn.example/immutable/.\t./mutable", lock.sceneManifest.path), /invalid_template_asset_base_url/);
});

test("complete template version validation keeps identity surfaces and asset release consistent", () => {
  const checksum = "a".repeat(64);
  const surface = {
    surfaceId: "debug-main",
    label: "Meeting display",
    purpose: "collaboration" as const,
    allowedObjectTypes: ["screen-share"],
    aspectRatio: { width: 16, height: 9, maxRelativeError: 0.02 }
  };
  const contract: RoomTemplateVersionContractV1 = {
    schemaVersion: 1,
    templateId: "meeting-room-basic",
    version: "1.0.0",
    label: "Meeting Room",
    description: "Small-group meeting room",
    assetSlots: ["logo", "hero-screen"],
    defaults: {
      roomType: "standard",
      visibility: "public",
      guestAllowed: true,
      features: { voice: true, spatialAudio: true, screenShare: true },
      theme: { primaryColor: "#5fc8ff", accentColor: "#163354" },
      avatarConfig: {
        avatarsEnabled: true,
        avatarCatalogUrl: "/assets/avatars/catalog.v1.json",
        avatarQualityProfile: "desktop-standard",
        avatarFallbackCapsulesEnabled: true,
        avatarSeatsEnabled: true
      },
      surfaces: [structuredClone(surface)],
      settings: {
        layout: "meeting",
        notes: { enabled: true, defaultScope: "shared" },
        audio: { enabled: true, spatial: true, joinMutedByDefault: false, participantLayout: "round-table" },
        presentation: { enabled: true, surfaceId: "debug-main" }
      }
    },
    scene: {
      schemaVersion: 1,
      templateId: "meeting-room-basic",
      templateVersion: "1.0.0",
      sceneId: "meeting-room-v1",
      sceneVersion: "1.0.0",
      surfaces: [structuredClone(surface)],
      seats: { minimum: 4, maximum: 4 }
    },
    assetLock: {
      repository: "vrata-labs/scene-assets",
      commitSha: "b".repeat(40),
      sceneReleaseId: "meeting-room-v1@1.0.0",
      releaseManifest: { path: "manifest.json", sha256: checksum, sizeBytes: 100 },
      sceneManifest: { path: "assets/scenes/meeting-room-v1/1.0.0/scene.json", sha256: checksum, sizeBytes: 200 },
      sceneAsset: { path: "assets/scenes/meeting-room-v1/1.0.0/scene.glb", sha256: checksum, sizeBytes: 300 },
      preview: { path: "assets/scenes/meeting-room-v1/1.0.0/preview.webp", sha256: checksum, sizeBytes: 400 }
    }
  };
  assert.deepEqual(validateRoomTemplateVersionContract(contract), []);

  const inconsistent = structuredClone(contract);
  inconsistent.scene.templateId = "other-template";
  inconsistent.defaults.surfaces[0]!.purpose = "presentation";
  inconsistent.assetLock.sceneReleaseId = "other-scene@1.0.0";
  const codes = validateRoomTemplateVersionContract(inconsistent).map(({ code }) => code);
  assert.equal(codes.includes("template_scene_contract_identity_mismatch"), true);
  assert.equal(codes.includes("template_default_surfaces_mismatch"), true);
  assert.equal(codes.includes("template_asset_release_identity_mismatch"), true);

  const malformed = structuredClone(contract);
  malformed.label = "";
  malformed.assetSlots = [""];
  malformed.defaults.settings.audio.enabled = false;
  malformed.defaults.surfaces[0]!.allowedObjectTypes = ["unknown-object"];
  malformed.scene.sceneId = "";
  malformed.scene.seats.maximum = -1;
  malformed.scene.surfaces[0]!.allowedObjectTypes = ["unknown-object"];
  const malformedCodes = validateRoomTemplateVersionContract(malformed).map(({ code }) => code);
  assert.equal(malformedCodes.includes("invalid_template_version_contract_metadata"), true);
  assert.equal(malformedCodes.includes("invalid_template_version_contract_defaults"), true);
  assert.equal(malformedCodes.includes("invalid_template_scene_contract"), true);
});

test("versioned registry lookups return defensive clones isolated from legacy mutations", () => {
  const firstDefinition = getTemplateDefinition("meeting-room-basic");
  const firstList = listTemplateDefinitions();
  const firstCurrent = getCurrentTemplateVersion("meeting-room-basic");
  const firstVersion = getTemplateVersion("meeting-room-basic", "0.1.0");
  assert.ok(firstDefinition);
  assert.ok(firstCurrent);
  assert.ok(firstVersion);

  const legacySlots = [...firstDefinition.assetSlots];
  try {
    firstDefinition.assetSlots.push("legacy-mutation");
    firstList[0]?.assetSlots.push("spoofed-slot");
    firstCurrent.assetSlots.push("spoofed-slot");
    firstVersion.assetSlots.push("spoofed-slot");

    assert.deepEqual(listTemplateDefinitions()[0]?.assetSlots, ["logo", "hero-screen"]);
    assert.deepEqual(getCurrentTemplateVersion("meeting-room-basic")?.assetSlots, ["logo", "hero-screen"]);
    assert.deepEqual(getTemplateVersion("meeting-room-basic", "0.1.0")?.assetSlots, ["logo", "hero-screen"]);
    assert.equal(getTemplateVersion("meeting-room-basic", "0.2.0"), undefined);
  } finally {
    firstDefinition.assetSlots.splice(0, firstDefinition.assetSlots.length, ...legacySlots);
  }
});
