import { createDefaultRoomMediaObjectsState, listAvailableMediaObjectTypes, type RoomMediaObjectsState } from "./media-objects.js";

// Small server-issued contract: physical transforms remain in the scene manifest.
export interface SceneMediaSurfaceDefinition {
  surfaceId: string;
  label: string;
  allowedObjectTypes: string[];
}

export function parseSceneMediaSurfaceDefinitions(input: unknown): SceneMediaSurfaceDefinition[] {
  if (!Array.isArray(input) || input.length > 16) throw new Error("invalid_scene_media_surfaces");
  const ids = new Set<string>();
  const definitions = input.map(value => {
    if (!value || typeof value !== "object") throw new Error("invalid_scene_media_surface");
    const id = value.surfaceId ?? value.id;
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(id)
      || ["constructor", "prototype", "__proto__"].includes(id) || ids.has(id)) throw new Error("invalid_scene_media_surface_id");
    ids.add(id);
    const label = value.label ?? id;
    const allowed = value.allowedObjectTypes ?? listAvailableMediaObjectTypes();
    if (typeof label !== "string" || label.length > 128 || !Array.isArray(allowed) || allowed.length > 16
      || !allowed.every(type => typeof type === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(type))) throw new Error("invalid_scene_media_surface_metadata");
    return { surfaceId: id, label, allowedObjectTypes: [...new Set<string>(allowed)] };
  });
  if (new TextEncoder().encode(JSON.stringify(definitions)).byteLength > 4096) throw new Error("scene_media_surface_token_budget_exceeded");
  return definitions;
}

// Additive: reconnects and scene changes must not reset active shared objects or
// remove historical/default surfaces. Browser messages cannot call this operation.
export function registerSceneMediaSurfaces(state: RoomMediaObjectsState, roomId: string, definitions: SceneMediaSurfaceDefinition[]): RoomMediaObjectsState {
  const surfaces = { ...state.surfaces };
  const prototype = Object.values(createDefaultRoomMediaObjectsState(roomId).surfaces)[0]!;
  for (const definition of parseSceneMediaSurfaceDefinitions(definitions)) {
    if (Object.hasOwn(surfaces, definition.surfaceId)) continue;
    surfaces[definition.surfaceId] = { ...structuredClone(prototype), ...definition, roomId };
  }
  return { ...state, surfaces };
}
