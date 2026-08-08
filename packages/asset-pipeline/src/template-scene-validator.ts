import type { RoomTemplateSceneContract } from "@vrata/shared-types";
import type { SceneBundleValidationIssue } from "./scene-bundle-validator.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isValidSeatAnchor(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || !isRecord(value.position)) return false;
  return [value.position.x, value.position.y, value.position.z, value.yaw, value.seatHeight]
    .every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function error(path: string, code: string, message: string): SceneBundleValidationIssue {
  return { severity: "error", path, code, message };
}

export function validateTemplateScenePair(manifest: unknown, contract: RoomTemplateSceneContract, sceneVersion: string): SceneBundleValidationIssue[] {
  const issues: SceneBundleValidationIssue[] = [];
  if (!isRecord(manifest)) {
    return [error("scene.json", "invalid_template_scene_manifest", "Template pair validation requires a scene manifest object.")];
  }

  if (manifest.sceneId !== contract.sceneId) {
    issues.push(error(
      "scene.json#/sceneId",
      "template_scene_id_mismatch",
      `Template ${contract.templateId}@${contract.templateVersion} requires sceneId=${contract.sceneId}.`
    ));
  }
  if (manifest.schemaVersion !== contract.schemaVersion) {
    issues.push(error(
      "scene.json#/schemaVersion",
      "template_scene_schema_mismatch",
      `Template ${contract.templateId}@${contract.templateVersion} requires scene schemaVersion=${contract.schemaVersion}.`
    ));
  }
  if (sceneVersion !== contract.sceneVersion) {
    issues.push(error(
      "scene.json",
      "template_scene_version_mismatch",
      `Template ${contract.templateId}@${contract.templateVersion} requires sceneVersion=${contract.sceneVersion}; received ${sceneVersion}.`
    ));
  }

  const contractSurfaceIds = new Set<string>();
  for (const surface of contract.surfaces) {
    if (contractSurfaceIds.has(surface.surfaceId)) {
      issues.push(error(
        `template:${contract.templateId}@${contract.templateVersion}#/surfaces/${surface.surfaceId}`,
        "duplicate_template_surface_id",
        `Template scene contract contains duplicate surfaceId=${surface.surfaceId}.`
      ));
    }
    contractSurfaceIds.add(surface.surfaceId);
    if (surface.allowedObjectTypes.length === 0) {
      issues.push(error(
        `template:${contract.templateId}@${contract.templateVersion}#/surfaces/${surface.surfaceId}/allowedObjectTypes`,
        "invalid_template_surface_contract",
        `Template surface ${surface.surfaceId} must allow at least one object type.`
      ));
    }
    if (surface.aspectRatio && (!isFinitePositiveNumber(surface.aspectRatio.width)
      || !isFinitePositiveNumber(surface.aspectRatio.height)
      || typeof surface.aspectRatio.maxRelativeError !== "number"
      || !Number.isFinite(surface.aspectRatio.maxRelativeError)
      || surface.aspectRatio.maxRelativeError < 0)) {
      issues.push(error(
        `template:${contract.templateId}@${contract.templateVersion}#/surfaces/${surface.surfaceId}/aspectRatio`,
        "invalid_template_surface_contract",
        `Template surface ${surface.surfaceId} has an invalid aspect-ratio requirement.`
      ));
    }
  }

  if (!Number.isSafeInteger(contract.seats.minimum) || !Number.isSafeInteger(contract.seats.maximum)
    || contract.seats.minimum < 0 || contract.seats.maximum < contract.seats.minimum) {
    issues.push(error(
      `template:${contract.templateId}@${contract.templateVersion}#/seats`,
      "invalid_template_seat_contract",
      "Template seat minimum and maximum must be safe non-negative integers with maximum >= minimum."
    ));
  }

  const sceneSurfaces = Array.isArray(manifest.mediaSurfaces)
    ? manifest.mediaSurfaces.filter((surface): surface is Record<string, unknown> => isRecord(surface) && typeof surface.surfaceId === "string" && surface.surfaceId.length > 0)
    : [];
  for (const requiredSurface of contract.surfaces) {
    const sceneSurface = sceneSurfaces.find((surface) => surface.surfaceId === requiredSurface.surfaceId);
    if (!sceneSurface) {
      issues.push(error(
        "scene.json#/mediaSurfaces",
        "missing_template_surface",
        `Template ${contract.templateId}@${contract.templateVersion} requires surfaceId=${requiredSurface.surfaceId}.`
      ));
      continue;
    }

    const expectedAspect = requiredSurface.aspectRatio;
    if ((sceneSurface.widthPx === undefined) !== (sceneSurface.heightPx === undefined)) {
      issues.push(error(
        `scene.json#/mediaSurfaces/${requiredSurface.surfaceId}`,
        "template_surface_pixel_dimensions_required",
        `Surface ${requiredSurface.surfaceId} must declare widthPx and heightPx together when either is provided.`
      ));
    }
    if (!isFinitePositiveNumber(sceneSurface.widthM) || !isFinitePositiveNumber(sceneSurface.heightM)) {
      issues.push(error(
        `scene.json#/mediaSurfaces/${requiredSurface.surfaceId}`,
        "template_surface_dimensions_required",
        `Surface ${requiredSurface.surfaceId} must declare positive widthM and heightM.`
      ));
    }
    const transform = isRecord(sceneSurface.transform) ? sceneSurface.transform : null;
    if (!transform || ![transform.x, transform.y, transform.z].every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
      issues.push(error(
        `scene.json#/mediaSurfaces/${requiredSurface.surfaceId}/transform`,
        "template_surface_transform_required",
        `Surface ${requiredSurface.surfaceId} must declare a finite x/y/z transform.`
      ));
    }
    if (expectedAspect && isFinitePositiveNumber(sceneSurface.widthM) && isFinitePositiveNumber(sceneSurface.heightM)) {
      const expected = expectedAspect.width / expectedAspect.height;
      const physicalAspect = sceneSurface.widthM / sceneSurface.heightM;
      const pixelAspect = isFinitePositiveNumber(sceneSurface.widthPx) && isFinitePositiveNumber(sceneSurface.heightPx)
        ? sceneSurface.widthPx / sceneSurface.heightPx
        : null;
      if (Math.abs(physicalAspect - expected) / expected > expectedAspect.maxRelativeError
        || (pixelAspect !== null && Math.abs(pixelAspect - expected) / expected > expectedAspect.maxRelativeError)) {
        issues.push(error(
          `scene.json#/mediaSurfaces/${requiredSurface.surfaceId}`,
          "template_surface_aspect_ratio_mismatch",
          `Surface ${requiredSurface.surfaceId} must match expected aspect ratio ${expected.toFixed(4)} within relative error ${expectedAspect.maxRelativeError}.`
        ));
      }
    }
    if (Array.isArray(sceneSurface.allowedObjectTypes)) {
      const unexpectedObjectType = sceneSurface.allowedObjectTypes.find((objectType) => typeof objectType === "string" && !requiredSurface.allowedObjectTypes.includes(objectType));
      if (unexpectedObjectType) {
        issues.push(error(
          `scene.json#/mediaSurfaces/${requiredSurface.surfaceId}/allowedObjectTypes`,
          "template_surface_object_type_mismatch",
          `Surface ${requiredSurface.surfaceId} declares objectType=${unexpectedObjectType}, which is not allowed by the template contract.`
        ));
      }
    }
  }

  const anchors = isRecord(manifest.anchors) ? manifest.anchors : null;
  const seatCount = anchors && Array.isArray(anchors.seatAnchors) ? anchors.seatAnchors.filter(isValidSeatAnchor).length : 0;
  if (seatCount < contract.seats.minimum || seatCount > contract.seats.maximum) {
    issues.push(error(
      "scene.json#/anchors/seatAnchors",
      "template_seat_count_mismatch",
      `Template ${contract.templateId}@${contract.templateVersion} requires ${contract.seats.minimum}-${contract.seats.maximum} seats; scene provides ${seatCount}.`
    ));
  }

  return issues;
}
