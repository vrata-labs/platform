import {
  REMOTE_BROWSER_OBJECT_TYPE,
  WHITEBOARD_OBJECT_TYPE,
  getMediaObjectDefinition,
  isMediaObjectDefinitionAvailable,
  type MediaObjectInstance,
  type RemoteBrowserObjectState,
  type SurfaceInputEvent,
  type WhiteboardState
} from "@vrata/shared-types";

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
  const definition = getMediaObjectDefinition(object.type);
  if (event.kind === "click" && definition && isMediaObjectDefinitionAvailable(definition) && definition.stateKind === "surface-test-card") {
    return options.sendTestCardPatch(object, event);
  }
  return false;
}
