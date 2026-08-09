import { isMediaObjectTypeAvailable } from "@vrata/shared-types";

import { validateRoomTemplateAssetLock } from "./asset-lock.js";

export interface RoomTemplateVersionContractIssue {
  path: string;
  code: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSemanticVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(isNonEmptyString)
    && new Set(value).size === value.length;
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isValidSurface(value: unknown): boolean {
  if (!isRecord(value)
    || !isNonEmptyString(value.surfaceId)
    || !isNonEmptyString(value.label)
    || (value.purpose !== "workspace" && value.purpose !== "collaboration" && value.purpose !== "presentation")
    || !isStringList(value.allowedObjectTypes)
    || value.allowedObjectTypes.length === 0
    || !value.allowedObjectTypes.every(isMediaObjectTypeAvailable)) return false;
  if (value.aspectRatio === undefined) return true;
  return isRecord(value.aspectRatio)
    && isFinitePositiveNumber(value.aspectRatio.width)
    && isFinitePositiveNumber(value.aspectRatio.height)
    && typeof value.aspectRatio.maxRelativeError === "number"
    && Number.isFinite(value.aspectRatio.maxRelativeError)
    && value.aspectRatio.maxRelativeError >= 0;
}

function isValidSurfaceList(value: unknown): value is Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isValidSurface)) return false;
  const ids = value.map((surface) => (surface as Record<string, unknown>).surfaceId);
  return new Set(ids).size === ids.length;
}

function isValidDefaults(value: unknown): boolean {
  if (!isRecord(value)
    || (value.roomType !== "standard" && value.roomType !== "personal")
    || (value.visibility !== "public" && value.visibility !== "unlisted" && value.visibility !== "private")
    || typeof value.guestAllowed !== "boolean"
    || !isRecord(value.features)
    || typeof value.features.voice !== "boolean"
    || typeof value.features.spatialAudio !== "boolean"
    || typeof value.features.screenShare !== "boolean"
    || !isRecord(value.theme)
    || !isNonEmptyString(value.theme.primaryColor)
    || !isNonEmptyString(value.theme.accentColor)
    || !isRecord(value.avatarConfig)
    || typeof value.avatarConfig.avatarsEnabled !== "boolean"
    || !isNonEmptyString(value.avatarConfig.avatarCatalogUrl)
    || !["mobile-lite", "desktop-standard", "xr"].includes(String(value.avatarConfig.avatarQualityProfile))
    || typeof value.avatarConfig.avatarFallbackCapsulesEnabled !== "boolean"
    || typeof value.avatarConfig.avatarSeatsEnabled !== "boolean"
    || !isValidSurfaceList(value.surfaces)
    || !isRecord(value.settings)) return false;

  const settings = value.settings;
  const audio = settings.audio;
  const presentation = settings.presentation;
  if (!["personal-workspace", "meeting", "presentation"].includes(String(settings.layout))
    || !isRecord(settings.notes)
    || typeof settings.notes.enabled !== "boolean"
    || (settings.notes.defaultScope !== "shared" && settings.notes.defaultScope !== "private")
    || !isRecord(audio)
    || typeof audio.enabled !== "boolean"
    || typeof audio.spatial !== "boolean"
    || typeof audio.joinMutedByDefault !== "boolean"
    || !["owner-focused", "round-table", "audience"].includes(String(audio.participantLayout))
    || !isRecord(presentation)
    || typeof presentation.enabled !== "boolean") return false;

  if (presentation.surfaceId !== undefined) {
    if (!isNonEmptyString(presentation.surfaceId)
      || !value.surfaces.some((surface) => surface.surfaceId === presentation.surfaceId)) return false;
  } else if (presentation.enabled) {
    return false;
  }
  return audio.enabled === value.features.voice
    && audio.spatial === value.features.spatialAudio;
}

function isValidScene(value: unknown): boolean {
  return isRecord(value)
    && value.schemaVersion === 1
    && isNonEmptyString(value.templateId)
    && isSemanticVersion(value.templateVersion)
    && typeof value.sceneId === "string"
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.sceneId)
    && isSemanticVersion(value.sceneVersion)
    && isValidSurfaceList(value.surfaces)
    && isRecord(value.seats)
    && Number.isSafeInteger(value.seats.minimum)
    && Number(value.seats.minimum) >= 0
    && Number.isSafeInteger(value.seats.maximum)
    && Number(value.seats.maximum) >= Number(value.seats.minimum);
}

function sameStringSet(left: unknown, right: unknown): boolean {
  if (!isStringList(left) || !isStringList(right)) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function sameAspectRatio(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return isRecord(left) && isRecord(right)
    && left.width === right.width
    && left.height === right.height
    && left.maxRelativeError === right.maxRelativeError;
}

function sameSurface(left: unknown, right: unknown): boolean {
  return isRecord(left) && isRecord(right)
    && left.surfaceId === right.surfaceId
    && left.label === right.label
    && left.purpose === right.purpose
    && sameStringSet(left.allowedObjectTypes, right.allowedObjectTypes)
    && sameAspectRatio(left.aspectRatio, right.aspectRatio);
}

function surfacesMatch(defaults: unknown, scene: unknown): boolean {
  if (!Array.isArray(defaults) || !Array.isArray(scene) || defaults.length !== scene.length) return false;
  const defaultIds = defaults.map((surface) => isRecord(surface) ? surface.surfaceId : undefined);
  const sceneIds = scene.map((surface) => isRecord(surface) ? surface.surfaceId : undefined);
  if (!defaultIds.every(isNonEmptyString) || !sceneIds.every(isNonEmptyString)
    || new Set(defaultIds).size !== defaultIds.length || new Set(sceneIds).size !== sceneIds.length) return false;
  return scene.every((sceneSurface) => {
    const sceneId = isRecord(sceneSurface) ? sceneSurface.surfaceId : undefined;
    if (!isNonEmptyString(sceneId)) return false;
    return sameSurface(defaults.find((surface) => isRecord(surface) && surface.surfaceId === sceneId), sceneSurface);
  });
}

export function validateRoomTemplateVersionContract(contract: unknown): RoomTemplateVersionContractIssue[] {
  if (!isRecord(contract)) return [{ path: "contract", code: "invalid_template_version_contract" }];

  const issues: RoomTemplateVersionContractIssue[] = [];
  if (contract.schemaVersion !== 1) {
    issues.push({ path: "schemaVersion", code: "invalid_template_version_contract_schema" });
  }
  const templateId = isNonEmptyString(contract.templateId) ? contract.templateId : null;
  const version = isSemanticVersion(contract.version) ? contract.version : null;
  if (!templateId || !version) {
    issues.push({ path: "templateId", code: "invalid_template_version_contract_identity" });
  }
  if (!isNonEmptyString(contract.label) || !isNonEmptyString(contract.description) || !isStringList(contract.assetSlots)) {
    issues.push({ path: "contract", code: "invalid_template_version_contract_metadata" });
  }

  const defaults = isRecord(contract.defaults) ? contract.defaults : null;
  if (!isValidDefaults(defaults)) {
    issues.push({ path: "defaults", code: "invalid_template_version_contract_defaults" });
  }

  const scene = isRecord(contract.scene) ? contract.scene : null;
  if (!isValidScene(scene)) {
    issues.push({ path: "scene", code: "invalid_template_scene_contract" });
  }
  if (scene) {
    if (scene.templateId !== templateId || scene.templateVersion !== version) {
      issues.push({ path: "scene", code: "template_scene_contract_identity_mismatch" });
    }
    if (!defaults || !surfacesMatch(defaults.surfaces, scene.surfaces)) {
      issues.push({ path: "defaults.surfaces", code: "template_default_surfaces_mismatch" });
    }
  }

  for (const assetIssue of validateRoomTemplateAssetLock(contract.assetLock)) {
    issues.push({
      path: assetIssue.path === "assetLock" ? assetIssue.path : `assetLock.${assetIssue.path}`,
      code: assetIssue.code
    });
  }

  const expectedReleaseId = scene && typeof scene.sceneId === "string"
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scene.sceneId) && isSemanticVersion(scene.sceneVersion)
    ? `${scene.sceneId}@${scene.sceneVersion}`
    : null;
  const assetLock = isRecord(contract.assetLock) ? contract.assetLock : null;
  if (expectedReleaseId && assetLock?.sceneReleaseId !== expectedReleaseId) {
    issues.push({ path: "assetLock.sceneReleaseId", code: "template_asset_release_identity_mismatch" });
  }

  return issues;
}
