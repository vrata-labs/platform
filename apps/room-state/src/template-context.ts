import { parseRoomTemplateSessionContext, registerSceneMediaSurfaces, type RoomTemplateSessionContext } from "@vrata/shared-types";
import type { RoomState } from "./state.js";

export function applyRoomTemplateContext(state: RoomState, input?: RoomTemplateSessionContext): RoomState {
  if (!input) {
    if (state.roomTemplate) throw new Error("room_template_context_required");
    return state;
  }
  const context = parseRoomTemplateSessionContext(input);
  if (state.roomTemplate) {
    if (JSON.stringify(state.roomTemplate) !== JSON.stringify(context)) throw new Error("room_template_context_mismatch");
    return state;
  }
  if (state.participants.length || Object.keys(state.mediaObjects.objects).length) throw new Error("room_template_context_mismatch");
  return { ...state, roomTemplate: context, mediaObjects: registerSceneMediaSurfaces({ surfaces: {}, objects: {} }, state.roomId, context.surfaces) };
}
