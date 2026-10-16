import { isMediaObjectTypeAvailable, type MediaSurface, type RoomTemplateSurface } from "@vrata/shared-types";

export interface MeetingSurfaceTargetInput {
  purpose: "presentation" | "collaboration";
  objectType: string;
  alternativeObjectTypes?: readonly string[];
  selectedSurfaceId: string;
  physicalSurfaceIds: ReadonlySet<string>;
  surfaces: Readonly<Record<string, MediaSurface>> | null;
  templateSurfaces: readonly RoomTemplateSurface[];
  preferredPresentationSurfaceId?: string;
  objectTypeAvailable?: boolean;
}

/** Local selection only: the server remains the authority for creating content.
 * No label guessing, hard-coded surface ID or DOM-option ordering. */
export function resolveMeetingSurfaceTarget(input: MeetingSurfaceTargetInput): { surfaceId: string; label: string } | null {
  const types = [input.objectType, ...(input.alternativeObjectTypes ?? [])].filter((type, index) => index === 0
    ? input.objectTypeAvailable ?? isMediaObjectTypeAvailable(type) : isMediaObjectTypeAvailable(type));
  if (!types.length || !input.surfaces) return null;
  const declared = new Map(input.templateSurfaces.map((surface, index) => [surface.surfaceId, { ...surface, order: index }]));
  const candidates = Object.values(input.surfaces).filter(surface => input.physicalSurfaceIds.has(surface.surfaceId)
    && surface.visible !== false && types.some(type => surface.allowedObjectTypes.includes(type)));
  const rank = (surface: MediaSurface) => {
    const definition = declared.get(surface.surfaceId);
    if (definition?.purpose === input.purpose) return 1;
    if (input.purpose === "presentation" && definition?.purpose === "workspace") return 2;
    return definition ? 4 : 3;
  };
  candidates.sort((left, right) => rank(left) - rank(right)
    || Number(right.surfaceId === input.selectedSurfaceId) - Number(left.surfaceId === input.selectedSurfaceId)
    || (input.purpose === "presentation" ? Number(right.surfaceId === input.preferredPresentationSurfaceId) - Number(left.surfaceId === input.preferredPresentationSurfaceId) : 0)
    || (declared.get(left.surfaceId)?.order ?? Infinity) - (declared.get(right.surfaceId)?.order ?? Infinity)
    || left.surfaceId.localeCompare(right.surfaceId));
  const target = candidates[0];
  if (!target) return null;
  return { surfaceId: target.surfaceId, label: target.label ?? declared.get(target.surfaceId)?.label ?? "Room surface" };
}
