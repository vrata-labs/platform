import {
  DISABLED_EXTENSION_CARD_TYPE,
  EXTENSION_TEST_CARD_TYPE,
  MARKDOWN_BOARD_OBJECT_TYPE,
  MISSING_CAPABILITY_EXTENSION_CARD_TYPE,
  REMOTE_BROWSER_OBJECT_TYPE,
  SCREEN_SHARE_OBJECT_TYPE,
  SURFACE_TEST_CARD_TYPE,
  WHITEBOARD_OBJECT_TYPE,
  hasRoomPermission,
  type MarkdownBoardState,
  type MediaObjectInstance,
  type RemoteBrowserObjectState,
  type RoomPermission,
  type ScreenShareObjectState,
  type WhiteboardState
} from "@vrata/shared-types";

import type { MarkdownBoardObjectRuntime } from "../media/markdown-board-object.js";
import type { MediaSurfaceCommandClient } from "../media/media-surface-commands.js";
import type { RemoteBrowserObjectRuntime } from "../media/remote-browser-object.js";
import type { WhiteboardObjectRuntime } from "../media/whiteboard-object.js";

export interface MediaObjectTestControlsContext {
  participantId: string;
  debugSurfaceId: string;
  // Supply getters for mutable runtime state; never capture a selection or permissions snapshot.
  readonly selectedMediaSurfaceId: string;
  readonly permissions: readonly RoomPermission[];
  mediaSurfaceCommands: Pick<MediaSurfaceCommandClient, "createCommandId" | "sendCreateObject" | "sendStopObject" | "sendPatchObjectState" | "sendMediaAudio">;
  activeMediaObjectForSurface: (surfaceId: string) => MediaObjectInstance | null;
  activeScreenShareObjectForSurface: (surfaceId: string) => MediaObjectInstance<ScreenShareObjectState> | null;
  findActiveScreenShareObject: () => MediaObjectInstance<ScreenShareObjectState> | null;
  activeWhiteboardObjectForSurface: (surfaceId: string) => MediaObjectInstance<WhiteboardState> | null;
  getWhiteboardRuntime: (surfaceId: string) => Pick<WhiteboardObjectRuntime, "createClearPatch">;
  activeMarkdownBoardObjectForSurface: (surfaceId: string) => MediaObjectInstance<MarkdownBoardState> | null;
  findActiveMarkdownBoardObject: () => MediaObjectInstance<MarkdownBoardState> | null;
  getMarkdownBoardRuntime: (surfaceId: string) => Pick<MarkdownBoardObjectRuntime, "createNotePatch" | "createUpdateNotePatch" | "createMoveNotePatch" | "createDeleteNotePatch">;
  latestStickyNoteId: (object: MediaObjectInstance<MarkdownBoardState> | null) => string | null;
  activeRemoteBrowserObjectForSurface: (surfaceId: string) => MediaObjectInstance<RemoteBrowserObjectState> | null;
  findActiveRemoteBrowserObject: () => MediaObjectInstance<RemoteBrowserObjectState> | null;
  getRemoteBrowserRuntime: (surfaceId: string) => Pick<RemoteBrowserObjectRuntime, "createTakeControlPatch" | "createReleaseControlPatch">;
}

export interface MediaObjectTestControls {
  sendPrivilegedSurfaceCreate: () => boolean;
  createSurfaceTestCard: () => boolean;
  createExtensionTestCard: (surfaceId?: string) => boolean;
  createMissingCapabilityExtensionObject: (surfaceId?: string) => boolean;
  createDisabledExtensionObject: (surfaceId?: string) => boolean;
  createScreenShareObject: (surfaceId?: string) => boolean;
  createWhiteboardObject: (surfaceId?: string) => boolean;
  createMarkdownBoardObject: (surfaceId?: string) => boolean;
  createStickyNote: (input?: { text?: string; x?: number; y?: number; surfaceId?: string }) => boolean;
  updateStickyNote: (noteId?: string, text?: string, surfaceId?: string) => boolean;
  moveStickyNote: (noteId?: string, x?: number, y?: number, surfaceId?: string) => boolean;
  deleteStickyNote: (noteId?: string, surfaceId?: string) => boolean;
  createRemoteBrowserObject: (surfaceId?: string) => boolean;
  takeRemoteBrowserControl: () => boolean;
  releaseRemoteBrowserControl: () => boolean;
  createUnknownSurfaceObject: () => boolean;
  stopActiveSurfaceObject: (surfaceId?: string) => boolean;
  sendStaleSurfaceTestCardPatch: () => boolean;
  sendStaleScreenSharePatch: () => boolean;
  sendStaleWhiteboardPatch: () => boolean;
  sendStaleMarkdownBoardPatch: () => boolean;
  sendDuplicateMarkdownBoardPatch: () => boolean;
  sendDuplicateWhiteboardPatch: () => boolean;
  clearWhiteboardObject: () => boolean;
  setDebugSurfaceMediaAudioEnabled: (enabled: boolean, surfaceId?: string) => boolean;
}

export function createMediaObjectTestControls(context: MediaObjectTestControlsContext): MediaObjectTestControls {
  const {
    debugSurfaceId: DEBUG_SURFACE_ID,
    participantId,
    mediaSurfaceCommands,
    activeMediaObjectForSurface,
    activeScreenShareObjectForSurface,
    findActiveScreenShareObject,
    activeWhiteboardObjectForSurface,
    getWhiteboardRuntime,
    activeMarkdownBoardObjectForSurface,
    findActiveMarkdownBoardObject,
    getMarkdownBoardRuntime,
    latestStickyNoteId,
    activeRemoteBrowserObjectForSurface,
    findActiveRemoteBrowserObject,
    getRemoteBrowserRuntime
  } = context;

  return {
    sendPrivilegedSurfaceCreate: () => {
      return mediaSurfaceCommands.sendCreateObject();
    },
    createSurfaceTestCard: () => {
      return mediaSurfaceCommands.sendCreateObject({
        commandId: mediaSurfaceCommands.createCommandId("create"),
        surfaceId: DEBUG_SURFACE_ID,
        objectType: SURFACE_TEST_CARD_TYPE,
        probeOnly: false
      });
    },
    createExtensionTestCard: (surfaceId = context.selectedMediaSurfaceId) => {
      return mediaSurfaceCommands.sendCreateObject({
        commandId: mediaSurfaceCommands.createCommandId("extension-test-card-create"),
        surfaceId,
        objectType: EXTENSION_TEST_CARD_TYPE,
        probeOnly: false
      });
    },
    createMissingCapabilityExtensionObject: (surfaceId = context.selectedMediaSurfaceId) => {
      return mediaSurfaceCommands.sendCreateObject({
        commandId: mediaSurfaceCommands.createCommandId("missing-capability-extension-create"),
        surfaceId,
        objectType: MISSING_CAPABILITY_EXTENSION_CARD_TYPE,
        probeOnly: false
      });
    },
    createDisabledExtensionObject: (surfaceId = context.selectedMediaSurfaceId) => {
      return mediaSurfaceCommands.sendCreateObject({
        commandId: mediaSurfaceCommands.createCommandId("disabled-extension-create"),
        surfaceId,
        objectType: DISABLED_EXTENSION_CARD_TYPE,
        probeOnly: false
      });
    },
    createScreenShareObject: (surfaceId = context.selectedMediaSurfaceId) => {
      return mediaSurfaceCommands.sendCreateObject({
        commandId: mediaSurfaceCommands.createCommandId("screen-share-create-test"),
        surfaceId,
        objectType: SCREEN_SHARE_OBJECT_TYPE,
        probeOnly: false
      });
    },
    createWhiteboardObject: (surfaceId = context.selectedMediaSurfaceId) => {
      return mediaSurfaceCommands.sendCreateObject({
        commandId: mediaSurfaceCommands.createCommandId("whiteboard-create-test"),
        surfaceId,
        objectType: WHITEBOARD_OBJECT_TYPE,
        probeOnly: false
      });
    },
    createMarkdownBoardObject: (surfaceId = context.selectedMediaSurfaceId) => {
      return mediaSurfaceCommands.sendCreateObject({
        commandId: mediaSurfaceCommands.createCommandId("markdown-board-create-test"),
        surfaceId,
        objectType: MARKDOWN_BOARD_OBJECT_TYPE,
        probeOnly: false
      });
    },
    createStickyNote: (input = {}) => {
      const object = activeMarkdownBoardObjectForSurface(input.surfaceId ?? context.selectedMediaSurfaceId) ?? findActiveMarkdownBoardObject();
      if (!object || !hasRoomPermission(context.permissions, "markdown-board.edit")) {
        return false;
      }
      return mediaSurfaceCommands.sendPatchObjectState("markdown-board-create-note-test", {
        surfaceId: object.surfaceId,
        objectId: object.objectId,
        expectedRevision: object.revision,
        patch: getMarkdownBoardRuntime(object.surfaceId).createNotePatch({
          text: input.text ?? "# Sticky note\n- synced",
          x: input.x ?? 0.12,
          y: input.y ?? 0.18
        })
      });
    },
    updateStickyNote: (noteId, text = "## Updated\nSafe Markdown", surfaceId = context.selectedMediaSurfaceId) => {
      const object = activeMarkdownBoardObjectForSurface(surfaceId) ?? findActiveMarkdownBoardObject();
      const targetNoteId = noteId ?? latestStickyNoteId(object);
      if (!object || !targetNoteId || !hasRoomPermission(context.permissions, "markdown-board.edit")) {
        return false;
      }
      return mediaSurfaceCommands.sendPatchObjectState("markdown-board-update-note-test", {
        surfaceId: object.surfaceId,
        objectId: object.objectId,
        expectedRevision: object.revision,
        patch: getMarkdownBoardRuntime(object.surfaceId).createUpdateNotePatch(targetNoteId, text)
      });
    },
    moveStickyNote: (noteId, x = 0.54, y = 0.42, surfaceId = context.selectedMediaSurfaceId) => {
      const object = activeMarkdownBoardObjectForSurface(surfaceId) ?? findActiveMarkdownBoardObject();
      const targetNoteId = noteId ?? latestStickyNoteId(object);
      if (!object || !targetNoteId || !hasRoomPermission(context.permissions, "markdown-board.edit")) {
        return false;
      }
      return mediaSurfaceCommands.sendPatchObjectState("markdown-board-move-note-test", {
        surfaceId: object.surfaceId,
        objectId: object.objectId,
        expectedRevision: object.revision,
        patch: getMarkdownBoardRuntime(object.surfaceId).createMoveNotePatch(targetNoteId, x, y)
      });
    },
    deleteStickyNote: (noteId, surfaceId = context.selectedMediaSurfaceId) => {
      const object = activeMarkdownBoardObjectForSurface(surfaceId) ?? findActiveMarkdownBoardObject();
      const targetNoteId = noteId ?? latestStickyNoteId(object);
      if (!object || !targetNoteId || !hasRoomPermission(context.permissions, "markdown-board.edit")) {
        return false;
      }
      return mediaSurfaceCommands.sendPatchObjectState("markdown-board-delete-note-test", {
        surfaceId: object.surfaceId,
        objectId: object.objectId,
        expectedRevision: object.revision,
        patch: getMarkdownBoardRuntime(object.surfaceId).createDeleteNotePatch(targetNoteId)
      });
    },
    createRemoteBrowserObject: (surfaceId = context.selectedMediaSurfaceId) => {
      return mediaSurfaceCommands.sendCreateObject({
        commandId: mediaSurfaceCommands.createCommandId("remote-browser-create-test"),
        surfaceId,
        objectType: REMOTE_BROWSER_OBJECT_TYPE,
        probeOnly: false
      });
    },
    takeRemoteBrowserControl: () => {
      const object = activeRemoteBrowserObjectForSurface(context.selectedMediaSurfaceId) ?? findActiveRemoteBrowserObject();
      if (!object) {
        return false;
      }
      return mediaSurfaceCommands.sendPatchObjectState("remote-browser-take-control-test", {
        surfaceId: object.surfaceId,
        objectId: object.objectId,
        expectedRevision: object.revision,
        patch: getRemoteBrowserRuntime(object.surfaceId).createTakeControlPatch()
      });
    },
    releaseRemoteBrowserControl: () => {
      const object = activeRemoteBrowserObjectForSurface(context.selectedMediaSurfaceId) ?? findActiveRemoteBrowserObject();
      if (!object) {
        return false;
      }
      return mediaSurfaceCommands.sendPatchObjectState("remote-browser-release-control-test", {
        surfaceId: object.surfaceId,
        objectId: object.objectId,
        expectedRevision: object.revision,
        patch: getRemoteBrowserRuntime(object.surfaceId).createReleaseControlPatch()
      });
    },
    createUnknownSurfaceObject: () => {
      return mediaSurfaceCommands.sendCreateObject({
        commandId: mediaSurfaceCommands.createCommandId("unknown"),
        surfaceId: DEBUG_SURFACE_ID,
        objectType: "unknown-object",
        probeOnly: false
      });
    },
    stopActiveSurfaceObject: (surfaceId = context.selectedMediaSurfaceId) => {
      const object = activeMediaObjectForSurface(surfaceId);
      if (!object) {
        return false;
      }
      return mediaSurfaceCommands.sendStopObject({
        commandId: mediaSurfaceCommands.createCommandId("stop"),
        surfaceId,
        objectId: object.objectId
      });
    },
    sendStaleSurfaceTestCardPatch: () => {
      const object = activeMediaObjectForSurface(context.selectedMediaSurfaceId);
      if (!object) {
        return false;
      }
      return mediaSurfaceCommands.sendPatchObjectState("stale-patch", {
        surfaceId: context.selectedMediaSurfaceId,
        objectId: object.objectId,
        expectedRevision: object.revision + 1,
        patch: {
          type: "increment-click-count",
          inputEventId: `${participantId}:stale:${Date.now()}`
        }
      });
    },
    sendStaleScreenSharePatch: () => {
      const object = activeScreenShareObjectForSurface(context.selectedMediaSurfaceId) ?? findActiveScreenShareObject();
      if (!object) {
        return false;
      }
      return mediaSurfaceCommands.sendPatchObjectState("stale-screen-share-patch", {
        surfaceId: object.surfaceId,
        objectId: object.objectId,
        expectedRevision: object.revision + 1,
        patch: {
          type: "mark-active",
          mediaTrackSid: `stale:${participantId}:${Date.now()}`
        }
      });
    },
    sendStaleWhiteboardPatch: () => {
      const object = activeWhiteboardObjectForSurface(context.selectedMediaSurfaceId);
      if (!object) {
        return false;
      }
      return mediaSurfaceCommands.sendPatchObjectState("stale-whiteboard-patch", {
        surfaceId: object.surfaceId,
        objectId: object.objectId,
        expectedRevision: object.revision + 1,
        patch: {
          type: "append-stroke",
          inputEventId: `${participantId}:stale-whiteboard:${Date.now()}`,
          stroke: {
            strokeId: `${participantId}:stale-stroke`,
            participantId,
            tool: "pen",
            color: "#111827",
            width: 2,
            points: [{ u: 0.25, v: 0.25, t: Date.now() }]
          }
        }
      });
    },
    sendStaleMarkdownBoardPatch: () => {
      const object = activeMarkdownBoardObjectForSurface(context.selectedMediaSurfaceId) ?? findActiveMarkdownBoardObject();
      if (!object) {
        return false;
      }
      return mediaSurfaceCommands.sendPatchObjectState("stale-markdown-board-patch", {
        surfaceId: object.surfaceId,
        objectId: object.objectId,
        expectedRevision: object.revision + 1,
        patch: getMarkdownBoardRuntime(object.surfaceId).createNotePatch({
          text: "# Stale note",
          x: 0.2,
          y: 0.2
        })
      });
    },
    sendDuplicateMarkdownBoardPatch: () => {
      const object = activeMarkdownBoardObjectForSurface(context.selectedMediaSurfaceId) ?? findActiveMarkdownBoardObject();
      if (!object || !object.state.lastInputEventId) {
        return false;
      }
      return mediaSurfaceCommands.sendPatchObjectState("duplicate-markdown-board-patch", {
        surfaceId: object.surfaceId,
        objectId: object.objectId,
        expectedRevision: object.revision,
        patch: {
          type: "create-note",
          inputEventId: object.state.lastInputEventId,
          noteId: `${participantId}:duplicate-note`,
          text: "Duplicate",
          x: 0.24,
          y: 0.24
        }
      });
    },
    sendDuplicateWhiteboardPatch: () => {
      const object = activeWhiteboardObjectForSurface(context.selectedMediaSurfaceId);
      if (!object || !object.state.lastInputEventId) {
        return false;
      }
      return mediaSurfaceCommands.sendPatchObjectState("duplicate-whiteboard-patch", {
        surfaceId: object.surfaceId,
        objectId: object.objectId,
        expectedRevision: object.revision,
        patch: {
          type: "append-stroke",
          inputEventId: object.state.lastInputEventId,
          stroke: {
            strokeId: `${participantId}:duplicate-stroke`,
            participantId,
            tool: "pen",
            color: "#111827",
            width: 2,
            points: [{ u: 0.35, v: 0.35, t: Date.now() }]
          }
        }
      });
    },
    clearWhiteboardObject: () => {
      const object = activeWhiteboardObjectForSurface(context.selectedMediaSurfaceId);
      if (!object) {
        return false;
      }
      return mediaSurfaceCommands.sendPatchObjectState("whiteboard-clear-test", {
        surfaceId: object.surfaceId,
        objectId: object.objectId,
        expectedRevision: object.revision,
        patch: getWhiteboardRuntime(object.surfaceId).createClearPatch()
      });
    },
    setDebugSurfaceMediaAudioEnabled: (enabled, surfaceId = context.selectedMediaSurfaceId) => {
      return mediaSurfaceCommands.sendMediaAudio({
        commandId: mediaSurfaceCommands.createCommandId("surface-audio-test"),
        surfaceId,
        enabled
      });
    }
  };
}
