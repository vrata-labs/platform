import type { RoomTemplateAssetLock, RoomTemplateVersionContractV1 } from "@vrata/shared-types";
import { getStandardRoomTemplateVersionContract, listStandardRoomTemplateVersionContracts } from "./standard-room-definitions.js";
import { validateRoomTemplateVersionContract } from "./version-contract.js";

export const PRODUCT_ROOM_TEMPLATE_VERSION = "2.0.0";
export const PRODUCT_ROOM_TEMPLATE_IDS = ["personal-room-basic", "meeting-room-basic", "presentation-room-basic"] as const;

const assets: Record<typeof PRODUCT_ROOM_TEMPLATE_IDS[number], RoomTemplateAssetLock> = {
  "personal-room-basic": {
    repository: "vrata-labs/personal-workspace-v1", commitSha: "a5cfb79c478492632e639fd6704eee02f2306fbd", sceneReleaseId: "personal-workspace-v1@0.4.2",
    releaseManifest: { path: "manifest.json", sha256: "4d80675fafc7f04362aa6da72063909c1384760a8ed6497cf1159c3635539ab5", sizeBytes: 10746 },
    sceneManifest: { path: "assets/scenes/personal-workspace-v1/0.4.2/scene.json", sha256: "60f5090745ae4ac1131bb35380fc9f6c5569c691b87c60e29aa781edfec85149", sizeBytes: 6717 },
    sceneAsset: { path: "assets/scenes/personal-workspace-v1/0.4.2/scene.glb", sha256: "d69bd6fe61edc74254e35d421a2ca9fa1ddf9760fbc129dbc851a9485073e6f2", sizeBytes: 12071664 },
    preview: { path: "assets/scenes/personal-workspace-v1/0.4.2/preview.webp", sha256: "a261623c4dbf70a015269866ec164ae061fcc17c1a9dd6dfbb9acee324e62377", sizeBytes: 38098 }
  },
  "meeting-room-basic": {
    repository: "vrata-labs/warm-modern-meeting-room-candidate-01", commitSha: "a237ab799acbee3932846147c9f48bf1d1b4aaa8", sceneReleaseId: "warm-modern-meeting-room-candidate-01@0.3.4",
    releaseManifest: { path: "manifest.json", sha256: "b4c6e15be7dcbe4b4cb1d918ec777ae239541db01c45e4f1049bb90a2d08911a", sizeBytes: 10046 },
    sceneManifest: { path: "assets/scenes/warm-modern-meeting-room-candidate-01/0.3.4/scene.json", sha256: "35f9d9c3045308f5d36095293f1f130262003202a3cdc33c103f715f53f658f8", sizeBytes: 5864 },
    sceneAsset: { path: "assets/scenes/warm-modern-meeting-room-candidate-01/0.3.4/scene.glb", sha256: "7553a8dea3dd61521b887bba5657f5f2f8bd37b9bed6e0b2337396f08dacb2cb", sizeBytes: 11576640 },
    preview: { path: "assets/scenes/warm-modern-meeting-room-candidate-01/0.3.4/preview.webp", sha256: "5553f8d0aee2b65c15a59fce1877da3c27b847313da1e58bfad8a9000269cdfd", sizeBytes: 71300 }
  },
  "presentation-room-basic": {
    repository: "vrata-labs/presentation-room-v1", commitSha: "f6661970535bb316642fcfc3c2c5df21b963ce30", sceneReleaseId: "presentation-room-v1@0.4.2",
    releaseManifest: { path: "manifest.json", sha256: "27fee324e6c1297f597ba41568192dbbcb618387f32515b42ab670f8ad1c7ec4", sizeBytes: 14001 },
    sceneManifest: { path: "assets/scenes/presentation-room-v1/0.4.2/scene.json", sha256: "5bdf5c2402ac1e6b4d0d5b24f1f2d4b3b8400069646aae27631abcf250882aeb", sizeBytes: 6848 },
    sceneAsset: { path: "assets/scenes/presentation-room-v1/0.4.2/scene.glb", sha256: "d51ec7deb341c7ba45c12dd0f7ffff1d45d784b7352bb8851fea792156f0f2e2", sizeBytes: 12396712 },
    preview: { path: "assets/scenes/presentation-room-v1/0.4.2/preview.webp", sha256: "9f03ebab1c4bb68b7f95aa3c1e4ff7b43aed6234ff06b3d42e8463eb4cbfaa12", sizeBytes: 23820 }
  }
};

const definitions = PRODUCT_ROOM_TEMPLATE_IDS.map(templateId => {
  const definition = getStandardRoomTemplateVersionContract(templateId, "1.0.0")!;
  definition.version = PRODUCT_ROOM_TEMPLATE_VERSION;
  definition.assetLock = structuredClone(assets[templateId]);
  const [sceneId, sceneVersion] = definition.assetLock.sceneReleaseId.split("@");
  definition.scene.templateVersion = definition.version;
  definition.scene.sceneId = sceneId!;
  definition.scene.sceneVersion = sceneVersion!;
  definition.defaults.avatarConfig.avatarFallbackCapsulesEnabled = false;
  if (templateId === "personal-room-basic") {
    definition.scene.seats = { minimum: 1, maximum: 1 };
    definition.scene.surfaces[0]!.surfaceId = "workspace-main";
    definition.scene.surfaces[0]!.aspectRatio = { width: 16, height: 9, maxRelativeError: .02 };
  } else {
    definition.scene.seats = { minimum: 8, maximum: 8 };
  }
  if (templateId === "meeting-room-basic") definition.description = "An eight-person meeting room with spatial audio, a shared display, and a collaboration wall.";
  definition.defaults.surfaces = structuredClone(definition.scene.surfaces);
  const issues = validateRoomTemplateVersionContract(definition);
  if (issues.length) throw new Error(`invalid_product_template:${templateId}:${issues.map(value => value.code).join(",")}`);
  return definition;
});

export function listProductRoomTemplateVersionContracts(): RoomTemplateVersionContractV1[] {
  return structuredClone(definitions);
}

export function listReferenceTemplateVersionContracts(): RoomTemplateVersionContractV1[] {
  return [...listStandardRoomTemplateVersionContracts(), ...listProductRoomTemplateVersionContracts()];
}
