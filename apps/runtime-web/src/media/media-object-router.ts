import {
  REMOTE_BROWSER_OBJECT_TYPE,
  SURFACE_TEST_CARD_TYPE,
  WHITEBOARD_OBJECT_TYPE,
  type MediaObjectInstance,
  type RemoteBrowserObjectState,
  type SurfaceInputEvent,
  type WhiteboardState
} from "@noah/shared-types";

import { isRemoteBrowserState, isWhiteboardState } from "./media-object-state.js";

export interface MediaObjectSurfaceInputRouterOptions {
  event: SurfaceInputEvent;
  object: MediaObjectInstance | null | undefined;
  routeWhiteboardInput: (event: SurfaceInputEvent, object: MediaObjectInstance<WhiteboardState>) => boolean;
  routeRemoteBrowserInput: (event: SurfaceInputEvent, object: MediaObjectInstance<RemoteBrowserObjectState>) => boolean;
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
  if (object.type === REMOTE_BROWSER_OBJECT_TYPE && isRemoteBrowserState(object.state)) {
    return options.routeRemoteBrowserInput(event, object as MediaObjectInstance<RemoteBrowserObjectState>);
  }
  if (event.kind === "click" && object.type === SURFACE_TEST_CARD_TYPE) {
    return options.sendTestCardPatch(object, event);
  }
  return false;
}
