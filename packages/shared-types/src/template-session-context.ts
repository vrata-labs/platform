import { isMediaObjectTypeAvailable } from "./media-objects.js";
import { parseSceneMediaSurfaceDefinitions } from "./scene-media-surfaces.js";
import type { RoomTemplateSessionContext } from "./room-template.js";

export function parseRoomTemplateSessionContext(input: unknown): RoomTemplateSessionContext {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_template_session_context");
  const value = input as Record<string, unknown>;
  if (typeof value.templateId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value.templateId)
    || typeof value.templateVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(value.templateVersion)
    || typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(value.contentHash)) throw new Error("invalid_template_session_context");
  if (!Array.isArray(value.surfaces) || value.surfaces.some(surface => !surface || typeof surface !== "object" || !Array.isArray(surface.allowedObjectTypes) || typeof surface.label !== "string")) throw new Error("invalid_template_session_surfaces");
  const surfaces = parseSceneMediaSurfaceDefinitions(value.surfaces);
  if (!surfaces.length || surfaces.some(surface => !surface.allowedObjectTypes.length || !surface.allowedObjectTypes.every(isMediaObjectTypeAvailable))) throw new Error("invalid_template_session_surfaces");
  const result = { templateId: value.templateId, templateVersion: value.templateVersion, contentHash: value.contentHash, surfaces };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 4096) throw new Error("template_session_context_too_large");
  return result;
}
