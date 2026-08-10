import type {
  RoomTemplateAssetLock,
  RoomTemplateDefaults,
  RoomTemplateSettings,
  RoomTemplateVersionContractV1
} from "@vrata/shared-types";

import { getStandardRoomTemplateSceneContract } from "./standard-room-contracts.js";
import { validateRoomTemplateVersionContract } from "./version-contract.js";

export const STANDARD_ROOM_ASSETS_REPOSITORY = "vrata-labs/scene-assets";
export const STANDARD_ROOM_ASSETS_COMMIT_SHA = "908331faf0eedb345d60eb1966b89994f5a8fb4b";

const releaseManifest = {
  path: "manifest.json",
  sha256: "1be3bd12c5ddb6935c11227e64c8175a76d38022d9ebf7e9f598dab059611ce0",
  sizeBytes: 17865
} as const;

const assetFiles = {
  "personal-workspace-v1": {
    sceneManifest: { sha256: "4e003af8338f295489acc5f8b39772b4909591818c392a489b923786f7f1750a", sizeBytes: 2087 },
    sceneAsset: { sha256: "84d5fd1c44abeea1d37d0187977d5c18d7051820c9ebfa31321719e5ce7a4309", sizeBytes: 3275652 },
    preview: { sha256: "c46ff3fb1959c3560ca8d3c63fcae08fbeb8c162ac2bb752c5692b3e0612589f", sizeBytes: 57160 }
  },
  "meeting-room-v1": {
    sceneManifest: { sha256: "1900d8d1f48e966a0f2a847383ea1ede087b08c7fb8051579181b1cbaf51b0ee", sizeBytes: 2900 },
    sceneAsset: { sha256: "992894bcfc4e313d7571678e2787d380ce3ed8d9f0e6868db84c279713c1198e", sizeBytes: 3257440 },
    preview: { sha256: "d4667b1744f48e2d2c30cc9fa0145ce0a38a78c1d794ebbd8c4f2dba2995c9e5", sizeBytes: 90350 }
  },
  "presentation-room-v1": {
    sceneManifest: { sha256: "00ba89320150ad779031b36c77ab5dfe3bc32a2a502c8643a9b3ddda16c04c64", sizeBytes: 4355 },
    sceneAsset: { sha256: "eea67b99cb86d325fafbddb4905b66aec271e541a7f70f14d39a3ef50f130e1d", sizeBytes: 4427004 },
    preview: { sha256: "2c43dd1d4ee68e66c838f81ef7eddf84b6c8b848836516895afabed849d8e26a", sizeBytes: 57498 }
  }
} as const;

const defaultAvatarConfig = {
  avatarsEnabled: true,
  avatarCatalogUrl: "/assets/avatars/catalog.v1.json",
  avatarQualityProfile: "desktop-standard",
  avatarFallbackCapsulesEnabled: true,
  avatarSeatsEnabled: true
} as const;

type StandardRoomSceneId = keyof typeof assetFiles;

interface StandardRoomDefinitionInput {
  templateId: "personal-room-basic" | "meeting-room-basic" | "presentation-room-basic";
  sceneId: StandardRoomSceneId;
  label: string;
  description: string;
  assetSlots: string[];
  roomType: RoomTemplateDefaults["roomType"];
  visibility: RoomTemplateDefaults["visibility"];
  guestAllowed: boolean;
  screenShare: boolean;
  theme: RoomTemplateDefaults["theme"];
  settings: RoomTemplateSettings;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function createAssetLock(sceneId: StandardRoomSceneId): RoomTemplateAssetLock {
  const version = "1.0.0";
  const releaseRoot = `assets/scenes/${sceneId}/${version}`;
  const files = assetFiles[sceneId];
  return {
    repository: STANDARD_ROOM_ASSETS_REPOSITORY,
    commitSha: STANDARD_ROOM_ASSETS_COMMIT_SHA,
    sceneReleaseId: `${sceneId}@${version}`,
    releaseManifest: { ...releaseManifest },
    sceneManifest: { path: `${releaseRoot}/scene.json`, ...files.sceneManifest },
    sceneAsset: { path: `${releaseRoot}/scene.glb`, ...files.sceneAsset },
    preview: { path: `${releaseRoot}/preview.webp`, ...files.preview }
  };
}

function createStandardRoomDefinition(input: StandardRoomDefinitionInput): RoomTemplateVersionContractV1 {
  const version = "1.0.0";
  const scene = getStandardRoomTemplateSceneContract(input.templateId, version);
  if (!scene || scene.sceneId !== input.sceneId) {
    throw new Error(`missing_standard_room_scene_contract:${input.templateId}@${version}`);
  }

  const contract: RoomTemplateVersionContractV1 = {
    schemaVersion: 1,
    templateId: input.templateId,
    version,
    label: input.label,
    description: input.description,
    assetSlots: [...input.assetSlots],
    defaults: {
      roomType: input.roomType,
      visibility: input.visibility,
      guestAllowed: input.guestAllowed,
      features: {
        voice: true,
        spatialAudio: true,
        screenShare: input.screenShare
      },
      theme: { ...input.theme },
      avatarConfig: { ...defaultAvatarConfig },
      surfaces: structuredClone(scene.surfaces),
      settings: structuredClone(input.settings)
    },
    scene,
    assetLock: createAssetLock(input.sceneId)
  };
  const issues = validateRoomTemplateVersionContract(contract);
  if (issues.length > 0) {
    throw new Error(`invalid_standard_room_definition:${input.templateId}@${version}:${issues.map(({ code }) => code).join(",")}`);
  }
  return deepFreeze(contract);
}

const standardRoomTemplateVersionContracts = deepFreeze([
  createStandardRoomDefinition({
    templateId: "personal-room-basic",
    sceneId: "personal-workspace-v1",
    label: "Personal Workspace",
    description: "A private addressable workspace with personal notes and a focused workspace surface.",
    assetSlots: ["logo", "personal-surface"],
    roomType: "personal",
    visibility: "private",
    guestAllowed: false,
    screenShare: false,
    theme: { primaryColor: "#7dd3fc", accentColor: "#312e81" },
    settings: {
      layout: "personal-workspace",
      notes: { enabled: true, defaultScope: "private" },
      audio: { enabled: true, spatial: true, joinMutedByDefault: false, participantLayout: "owner-focused" },
      presentation: { enabled: false }
    }
  }),
  createStandardRoomDefinition({
    templateId: "meeting-room-basic",
    sceneId: "meeting-room-v1",
    label: "Meeting Room",
    description: "A small-group room with spatial audio, four participant seats, a shared display, and a collaboration wall.",
    assetSlots: ["logo", "hero-screen"],
    roomType: "standard",
    visibility: "public",
    guestAllowed: true,
    screenShare: true,
    theme: { primaryColor: "#5fc8ff", accentColor: "#163354" },
    settings: {
      layout: "meeting",
      notes: { enabled: true, defaultScope: "shared" },
      audio: { enabled: true, spatial: true, joinMutedByDefault: false, participantLayout: "round-table" },
      presentation: { enabled: true, surfaceId: "debug-main" }
    }
  }),
  createStandardRoomDefinition({
    templateId: "presentation-room-basic",
    sceneId: "presentation-room-v1",
    label: "Presentation Room",
    description: "An audience-oriented room with a dedicated presentation surface and presenter media controls.",
    assetSlots: ["logo", "hero-screen", "media-placeholder"],
    roomType: "standard",
    visibility: "public",
    guestAllowed: true,
    screenShare: true,
    theme: { primaryColor: "#f59e0b", accentColor: "#1e293b" },
    settings: {
      layout: "presentation",
      notes: { enabled: true, defaultScope: "shared" },
      audio: { enabled: true, spatial: true, joinMutedByDefault: true, participantLayout: "audience" },
      presentation: { enabled: true, surfaceId: "debug-main" }
    }
  })
] satisfies RoomTemplateVersionContractV1[]);

const definitionKeys = standardRoomTemplateVersionContracts.map(({ templateId, version }) => `${templateId}@${version}`);
if (new Set(definitionKeys).size !== definitionKeys.length) {
  throw new Error("duplicate_standard_room_template_version");
}

export function listStandardRoomTemplateVersionContracts(): RoomTemplateVersionContractV1[] {
  return structuredClone(standardRoomTemplateVersionContracts);
}

export function getStandardRoomTemplateVersionContract(templateId: string, version: string): RoomTemplateVersionContractV1 | undefined {
  const contract = standardRoomTemplateVersionContracts.find((candidate) => candidate.templateId === templateId && candidate.version === version);
  return contract ? structuredClone(contract) : undefined;
}
