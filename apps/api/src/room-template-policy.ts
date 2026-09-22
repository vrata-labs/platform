import { materializeReferenceTemplate, referenceTemplateContract, resolveLockedRoomTemplateAssetUrl } from "@vrata/templates";
import { parseRoomTemplateSessionContext, type RoomTemplateSessionContext, type RoomTemplateVersionSnapshotV1, type RoomTemplateCatalogRecord } from "@vrata/shared-types";
import type { RoomRecord, Storage } from "./storage-contracts.js";
import { templateVersionContentHash } from "./storage-room-records.js";

export function templateAssetOptions(env: NodeJS.ProcessEnv = process.env) {
  return { mirrorBaseUrl: env.ROOM_TEMPLATE_ASSET_BASE_URL || undefined, allowLoopbackHttp: env.NODE_ENV !== "production" };
}

export function roomTemplateSessionContext(room?: RoomRecord | null): RoomTemplateSessionContext | undefined {
  if (!room) return undefined;
  const contract = referenceTemplateContract(room.templateSnapshot);
  if (!contract) return undefined;
  return parseRoomTemplateSessionContext({
    templateId: contract.templateId, templateVersion: contract.version,
    contentHash: templateVersionContentHash(contract),
    surfaces: contract.defaults.surfaces.map(({ surfaceId, label, allowedObjectTypes }) => ({ surfaceId, label, allowedObjectTypes }))
  });
}

export function materializeStoredRoomInput(snapshot: RoomTemplateVersionSnapshotV1, input: Partial<RoomRecord>): Partial<RoomRecord> {
  if (Object.hasOwn(input, "templateSnapshot")) throw new Error("server_owned_template_snapshot");
  if (input.templateVersion !== undefined && input.templateVersion !== snapshot.version) throw new Error("template_version_not_current");
  const contract = referenceTemplateContract(snapshot);
  return contract ? { ...input, ...materializeReferenceTemplate(contract, input, templateAssetOptions()) } : input;
}

export function assertRoomTemplatePatch(room: RoomRecord, input: Partial<RoomRecord>): void {
  if (Object.hasOwn(input, "templateSnapshot")) throw new Error("server_owned_template_snapshot");
  if ((input.templateId !== undefined && input.templateId !== room.templateId)
    || (input.templateVersion !== undefined && input.templateVersion !== room.templateVersion)) throw new Error("template_change_not_supported");
  const contract = referenceTemplateContract(room.templateSnapshot);
  if (!contract) return;
  if (input.sceneBundleUrl !== undefined) throw new Error("reference_scene_override_not_allowed");
  if (input.roomType !== undefined && input.roomType !== contract.defaults.roomType) throw new Error("template_room_type_conflict");
  if (contract.defaults.roomType === "personal") {
    if (input.ownerParticipantId !== undefined && input.ownerParticipantId !== room.ownerParticipantId) throw new Error("personal_room_owner_immutable");
    if (input.visibility !== undefined && input.visibility !== "private") throw new Error("personal_room_must_be_private");
    if (input.guestAllowed !== undefined && input.guestAllowed !== false) throw new Error("personal_room_guest_access_forbidden");
  }
  materializeReferenceTemplate(contract, { ...input, ownerParticipantId: room.ownerParticipantId, sceneBundleUrl: undefined });
}

export async function resolveRoomTemplateCreate(storage: Pick<Storage, "listTemplates" | "getTemplateVersion">, input: Partial<RoomRecord>): Promise<{ input: Partial<RoomRecord>; version: RoomTemplateVersionSnapshotV1 }> {
  if (Object.hasOwn(input, "templateSnapshot")) throw new Error("server_owned_template_snapshot");
  if (input.templateVersion !== undefined && (typeof input.templateVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(input.templateVersion))) throw new Error("invalid_template_version");
  const active = await storage.listTemplates();
  const id = input.templateId ?? (input.roomType === "personal" ? active.some(item => item.templateId === "personal-room-basic") ? "personal-room-basic" : "personal-workspace-basic" : undefined);
  if (!id) throw new Error("unknown_template");
  const current = await storage.getTemplateVersion(id);
  if (!current) throw new Error("unknown_template");
  const version = input.templateVersion === undefined ? current : await storage.getTemplateVersion(id, input.templateVersion);
  if (!version) throw new Error("unknown_template_version");
  const catalog = active.find(item => item.templateId === id);
  if (!catalog) throw new Error("deprecated_template");
  if (version.version !== catalog.currentVersion) throw new Error("template_version_not_current");
  const contract = referenceTemplateContract(version);
  if (contract && Object.hasOwn(input, "sceneBundleUrl")) throw new Error("reference_scene_override_not_allowed");
  return { input: materializeStoredRoomInput(version, { ...input, templateId: id, templateVersion: version.version }), version };
}

export function templateInputError(error: unknown): { code: string; status: number } | null {
  const message = error instanceof Error ? error.message : "";
  const code = message.split(":", 1)[0]!;
  if (["template_version_not_current", "deprecated_template", "template_change_not_supported", "reference_scene_override_not_allowed", "personal_room_owner_immutable"].includes(code)) return { code, status: 409 };
  if (["invalid_template_version", "unknown_template", "unknown_template_version", "server_owned_template_snapshot", "missing_personal_room_owner", "personal_room_must_be_private", "personal_room_guest_access_forbidden", "template_room_type_conflict", "invalid_room_visibility", "invalid_guest_allowed", "invalid_room_feature", "invalid_room_theme", "invalid_avatar_config", "invalid_template_override"].includes(code)) return { code, status: 400 };
  if (code === "template_deprecated") return { code: "deprecated_template", status: 409 };
  return null;
}

export async function listRoomTemplateMetadata(storage: Pick<Storage, "listTemplates" | "getTemplateVersion">): Promise<RoomTemplateCatalogRecord[]> {
  return Promise.all((await storage.listTemplates()).map(async row => {
    const snapshot = await storage.getTemplateVersion(row.templateId, row.currentVersion);
    if (!snapshot) throw new Error("template_version_not_found");
    const contract = referenceTemplateContract(snapshot);
    return contract ? { ...row, description: contract.description, defaults: contract.defaults, previewUrl: resolveLockedRoomTemplateAssetUrl(contract.assetLock, contract.assetLock.preview.path, templateAssetOptions()) } : row;
  }));
}
