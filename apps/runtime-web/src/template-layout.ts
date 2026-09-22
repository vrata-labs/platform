import type { RoomTemplateSurface } from "@vrata/shared-types";
import type { SceneBundleMediaSurface } from "./scene-bundle.js";

export function assertTemplateSceneSurfaces(required: RoomTemplateSurface[], physical: SceneBundleMediaSurface[] | undefined): void {
  const byId = new Map<string, SceneBundleMediaSurface>();
  for (const surface of physical ?? []) {
    if (byId.has(surface.surfaceId)) throw new Error(`duplicate_template_surface:${surface.surfaceId}`);
    byId.set(surface.surfaceId, surface);
  }
  const seen = new Set<string>();
  for (const logical of required) {
    if (seen.has(logical.surfaceId)) throw new Error(`duplicate_required_surface:${logical.surfaceId}`);
    seen.add(logical.surfaceId);
    const actual = byId.get(logical.surfaceId);
    if (!actual || !actual.visible) throw new Error(`missing_template_surface:${logical.surfaceId}`);
    if (logical.aspectRatio) {
      const expected = logical.aspectRatio.width/logical.aspectRatio.height;
      if (Math.abs(actual.widthM/actual.heightM/expected-1) > logical.aspectRatio.maxRelativeError) throw new Error(`template_surface_aspect_mismatch:${logical.surfaceId}`);
    }
  }
  if (byId.size !== seen.size) throw new Error("unexpected_template_surface");
}
