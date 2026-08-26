export interface MediaSurfaceRuntimeDimensions {
  widthM: number;
  heightM: number;
  widthPx: number;
  heightPx: number;
}

export interface MediaSurfaceObjectReference {
  objectId: string;
  surfaceId: string;
}

export interface MediaSurfaceMismatchPlan {
  physicalSurfaceIdsWithoutLogicalState: string[];
  logicalSurfaceIdsWithoutPhysicalView: string[];
  unrenderedObjectIds: string[];
}

export function mediaSurfaceDimensionsChanged(
  current: MediaSurfaceRuntimeDimensions,
  next: MediaSurfaceRuntimeDimensions
): boolean {
  return current.widthM !== next.widthM
    || current.heightM !== next.heightM
    || current.widthPx !== next.widthPx
    || current.heightPx !== next.heightPx;
}

export function planMediaSurfaceMismatches(input: {
  physicalSurfaceIds: Iterable<string>;
  logicalSurfaceIds: Iterable<string>;
  objects: Iterable<MediaSurfaceObjectReference>;
}): MediaSurfaceMismatchPlan {
  const physicalSurfaceIds = Array.from(input.physicalSurfaceIds);
  const logicalSurfaceIds = Array.from(input.logicalSurfaceIds);
  const physicalSurfaceIdSet = new Set(physicalSurfaceIds);
  const logicalSurfaceIdSet = new Set(logicalSurfaceIds);
  return {
    physicalSurfaceIdsWithoutLogicalState: physicalSurfaceIds.filter((surfaceId) => !logicalSurfaceIdSet.has(surfaceId)),
    logicalSurfaceIdsWithoutPhysicalView: logicalSurfaceIds.filter((surfaceId) => !physicalSurfaceIdSet.has(surfaceId)),
    unrenderedObjectIds: Array.from(input.objects)
      .filter((object) => !physicalSurfaceIdSet.has(object.surfaceId))
      .map((object) => object.objectId)
  };
}
