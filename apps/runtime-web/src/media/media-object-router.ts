import {
  SURFACE_TEST_CARD_TYPE,
  WHITEBOARD_OBJECT_TYPE,
  type MediaObjectInstance,
  type SurfaceInputEvent,
  type WhiteboardState
} from "@noah/shared-types";

import { isWhiteboardState } from "./media-object-state.js";

export interface MediaObjectSurfaceInputRouterOptions {
  event: SurfaceInputEvent;
  object: MediaObjectInstance | null | undefined;
  routeWhiteboardInput: (event: SurfaceInputEvent, object: MediaObjectInstance<WhiteboardState>) => boolean;
  sendTestCardPatch: (object: MediaObjectInstance, event: SurfaceInputEvent) => boolean;
}

export function routeMediaObjectSurfaceInput(options: MediaObjectSurfaceInputRouterOptions): boolean {
  const { event, object } = options;
  if (!object) {
    return false;
  }
  if (object.type === WHITEBOARD_OBJECT_TYPE && isWhiteboardState(object.state)) {
    return options.routeWhiteboardInput(event, object as MediaObjectInstance<WhiteboardState>);
  }
  if (event.kind === "click" && object.type === SURFACE_TEST_CARD_TYPE) {
    return options.sendTestCardPatch(object, event);
  }
  return false;
}
