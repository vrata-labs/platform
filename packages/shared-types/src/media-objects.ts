import type { RoomPermission, RoomRole } from "./access.js";
import type { SurfaceInputEvent } from "./surface-input.js";

export const DEFAULT_MEDIA_SURFACE_ID = "debug-main";
export const WHITEBOARD_MEDIA_SURFACE_ID = "whiteboard-wall";
export const LAPTOP_MEDIA_SURFACE_ID = "laptop-screen";
export const SURFACE_TEST_CARD_TYPE = "surface-test-card";
export const SCREEN_SHARE_OBJECT_TYPE = "screen-share";
export const WHITEBOARD_OBJECT_TYPE = "whiteboard";
export const REMOTE_BROWSER_OBJECT_TYPE = "remote-browser";
export const EXTENSION_TEST_CARD_TYPE = "extension-test-card";
export const MISSING_CAPABILITY_EXTENSION_CARD_TYPE = "missing-capability-extension-card";
export const DISABLED_EXTENSION_CARD_TYPE = "disabled-extension-card";
export const WHITEBOARD_MAX_STROKES = 500;
export const WHITEBOARD_MAX_POINTS_PER_STROKE = 256;
export const WHITEBOARD_ALLOWED_COLORS = ["#111827", "#2563eb", "#dc2626"] as const;
export const WHITEBOARD_ALLOWED_WIDTHS = [2, 4, 8] as const;

export type MediaObjectType = typeof SURFACE_TEST_CARD_TYPE | typeof SCREEN_SHARE_OBJECT_TYPE | typeof WHITEBOARD_OBJECT_TYPE | typeof REMOTE_BROWSER_OBJECT_TYPE | typeof EXTENSION_TEST_CARD_TYPE | string;

export type MediaExtensionCapability =
  | "surface.render"
  | "surface.input.pointer"
  | "surface.input.keyboard"
  | "room.state.read"
  | "room.state.write"
  | "media.publish"
  | "media.subscribe"
  | "remote.executor";

export type MediaObjectStateKind = "surface-test-card" | "screen-share" | "whiteboard" | "remote-browser";

export interface MediaObjectDefinition {
  objectType: MediaObjectType;
  displayName: string;
  stateKind: MediaObjectStateKind;
  requiredCapabilities: MediaExtensionCapability[];
  requiredPermissions: RoomPermission[];
  supportedSurfaceKinds?: MediaSurface["kind"][];
  enabled?: boolean;
}

export interface NoahMediaExtensionManifest {
  id: string;
  version: string;
  displayName: string;
  objectTypes: MediaObjectDefinition[];
  requiredCapabilities: MediaExtensionCapability[];
  requiredPermissions: RoomPermission[];
  compatibility: {
    noahRuntime: string;
    roomManifestSchema: number;
  };
  entry: string;
  enabled?: boolean;
}

export interface RegisteredMediaObjectDefinition extends MediaObjectDefinition {
  extensionId: string;
  extensionDisplayName: string;
  extensionEnabled: boolean;
  validationErrors: string[];
  missingCapabilities: MediaExtensionCapability[];
  missingPermissions: RoomPermission[];
}

export interface MediaExtensionDebugEntry {
  id: string;
  version: string;
  displayName: string;
  enabled: boolean;
  valid: boolean;
  validationErrors: string[];
  objectTypes: Array<{
    objectType: string;
    displayName: string;
    stateKind: MediaObjectStateKind;
    enabled: boolean;
    available: boolean;
    requiredCapabilities: MediaExtensionCapability[];
    requiredPermissions: RoomPermission[];
    missingCapabilities: MediaExtensionCapability[];
    missingPermissions: RoomPermission[];
  }>;
}

const NOAH_RUNTIME_EXTENSION_COMPATIBILITY = {
  noahRuntime: ">=0.1.0",
  roomManifestSchema: 1
};

export const BUILTIN_MEDIA_EXTENSION_MANIFESTS: NoahMediaExtensionManifest[] = [
  {
    id: "noah.surface-test-card",
    version: "0.1.0",
    displayName: "Surface Test Card",
    requiredCapabilities: ["surface.render", "surface.input.pointer", "room.state.read", "room.state.write"],
    requiredPermissions: ["surface.input"],
    compatibility: NOAH_RUNTIME_EXTENSION_COMPATIBILITY,
    entry: "internal:surface-test-card",
    objectTypes: [{
      objectType: SURFACE_TEST_CARD_TYPE,
      displayName: "Surface Test Card",
      stateKind: "surface-test-card",
      requiredCapabilities: ["surface.render", "surface.input.pointer", "room.state.read", "room.state.write"],
      requiredPermissions: ["surface.input"],
      supportedSurfaceKinds: ["wall", "table", "laptop", "floating", "custom"]
    }]
  },
  {
    id: "noah.screen-share",
    version: "0.1.0",
    displayName: "Screen Share",
    requiredCapabilities: ["surface.render", "room.state.read", "room.state.write", "media.publish", "media.subscribe"],
    requiredPermissions: ["screen-share.start", "screen-share.stop"],
    compatibility: NOAH_RUNTIME_EXTENSION_COMPATIBILITY,
    entry: "internal:screen-share",
    objectTypes: [{
      objectType: SCREEN_SHARE_OBJECT_TYPE,
      displayName: "Screen Share",
      stateKind: "screen-share",
      requiredCapabilities: ["surface.render", "room.state.read", "room.state.write", "media.publish", "media.subscribe"],
      requiredPermissions: ["screen-share.start", "screen-share.stop"],
      supportedSurfaceKinds: ["wall", "table", "laptop", "floating", "custom"]
    }]
  },
  {
    id: "noah.whiteboard",
    version: "0.1.0",
    displayName: "Interactive Whiteboard",
    requiredCapabilities: ["surface.render", "surface.input.pointer", "room.state.read", "room.state.write"],
    requiredPermissions: ["whiteboard.draw", "whiteboard.clear"],
    compatibility: NOAH_RUNTIME_EXTENSION_COMPATIBILITY,
    entry: "internal:whiteboard",
    objectTypes: [{
      objectType: WHITEBOARD_OBJECT_TYPE,
      displayName: "Interactive Whiteboard",
      stateKind: "whiteboard",
      requiredCapabilities: ["surface.render", "surface.input.pointer", "room.state.read", "room.state.write"],
      requiredPermissions: ["whiteboard.draw", "whiteboard.clear"],
      supportedSurfaceKinds: ["wall", "table", "laptop", "floating", "custom"]
    }]
  },
  {
    id: "noah.remote-browser",
    version: "0.1.0",
    displayName: "Remote Browser",
    requiredCapabilities: ["surface.render", "surface.input.pointer", "surface.input.keyboard", "room.state.read", "room.state.write", "media.subscribe", "remote.executor"],
    requiredPermissions: ["remote-browser.open-url", "remote-browser.input", "remote-browser.stop"],
    compatibility: NOAH_RUNTIME_EXTENSION_COMPATIBILITY,
    entry: "internal:remote-browser",
    objectTypes: [{
      objectType: REMOTE_BROWSER_OBJECT_TYPE,
      displayName: "Remote Browser",
      stateKind: "remote-browser",
      requiredCapabilities: ["surface.render", "surface.input.pointer", "surface.input.keyboard", "room.state.read", "room.state.write", "media.subscribe", "remote.executor"],
      requiredPermissions: ["remote-browser.open-url", "remote-browser.input", "remote-browser.stop"],
      supportedSurfaceKinds: ["wall", "table", "laptop", "floating", "custom"]
    }]
  },
  {
    id: "noah.extension-test-card",
    version: "0.1.0",
    displayName: "Extension Test Card",
    requiredCapabilities: ["surface.render", "surface.input.pointer", "room.state.read", "room.state.write"],
    requiredPermissions: ["surface.input"],
    compatibility: NOAH_RUNTIME_EXTENSION_COMPATIBILITY,
    entry: "internal:extension-test-card",
    objectTypes: [{
      objectType: EXTENSION_TEST_CARD_TYPE,
      displayName: "Extension Test Card",
      stateKind: "surface-test-card",
      requiredCapabilities: ["surface.render", "surface.input.pointer", "room.state.read", "room.state.write"],
      requiredPermissions: ["surface.input"],
      supportedSurfaceKinds: ["wall", "table", "laptop", "floating", "custom"]
    }]
  },
  {
    id: "noah.missing-capability-demo",
    version: "0.1.0",
    displayName: "Missing Capability Demo",
    requiredCapabilities: ["room.state.read"],
    requiredPermissions: ["surface.input"],
    compatibility: NOAH_RUNTIME_EXTENSION_COMPATIBILITY,
    entry: "internal:missing-capability-demo",
    objectTypes: [{
      objectType: MISSING_CAPABILITY_EXTENSION_CARD_TYPE,
      displayName: "Missing Capability Card",
      stateKind: "surface-test-card",
      requiredCapabilities: ["surface.render", "room.state.read"],
      requiredPermissions: ["surface.input"]
    }]
  },
  {
    id: "noah.disabled-demo",
    version: "0.1.0",
    displayName: "Disabled Demo Extension",
    enabled: false,
    requiredCapabilities: ["surface.render", "surface.input.pointer", "room.state.read", "room.state.write"],
    requiredPermissions: ["surface.input"],
    compatibility: NOAH_RUNTIME_EXTENSION_COMPATIBILITY,
    entry: "internal:disabled-demo",
    objectTypes: [{
      objectType: DISABLED_EXTENSION_CARD_TYPE,
      displayName: "Disabled Extension Card",
      stateKind: "surface-test-card",
      requiredCapabilities: ["surface.render", "surface.input.pointer", "room.state.read", "room.state.write"],
      requiredPermissions: ["surface.input"]
    }]
  }
];

function uniqueValues<T extends string>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

function listMissingValues<T extends string>(required: readonly T[], declared: readonly T[]): T[] {
  return uniqueValues(required.filter((item) => !declared.includes(item)));
}

export function validateMediaExtensionManifest(manifest: NoahMediaExtensionManifest): string[] {
  const errors: string[] = [];
  if (!manifest.id.trim()) {
    errors.push("missing-id");
  }
  if (!manifest.version.trim()) {
    errors.push("missing-version");
  }
  if (!manifest.displayName.trim()) {
    errors.push("missing-display-name");
  }
  if (!manifest.entry.trim()) {
    errors.push("missing-entry");
  }
  if (!Array.isArray(manifest.objectTypes) || manifest.objectTypes.length === 0) {
    errors.push("missing-object-types");
  }
  for (const objectType of manifest.objectTypes) {
    if (!String(objectType.objectType).trim()) {
      errors.push("missing-object-type");
    }
    for (const capability of listMissingValues(objectType.requiredCapabilities, manifest.requiredCapabilities)) {
      errors.push(`missing-capability:${String(objectType.objectType)}:${capability}`);
    }
    for (const permission of listMissingValues(objectType.requiredPermissions, manifest.requiredPermissions)) {
      errors.push(`missing-permission:${String(objectType.objectType)}:${permission}`);
    }
  }
  return uniqueValues(errors);
}

export function getMediaObjectDefinition(objectType: string, manifests: readonly NoahMediaExtensionManifest[] = BUILTIN_MEDIA_EXTENSION_MANIFESTS): RegisteredMediaObjectDefinition | null {
  for (const manifest of manifests) {
    for (const definition of manifest.objectTypes) {
      if (definition.objectType !== objectType) {
        continue;
      }
      return {
        ...definition,
        requiredCapabilities: [...definition.requiredCapabilities],
        requiredPermissions: [...definition.requiredPermissions],
        supportedSurfaceKinds: definition.supportedSurfaceKinds ? [...definition.supportedSurfaceKinds] : undefined,
        enabled: definition.enabled !== false,
        extensionId: manifest.id,
        extensionDisplayName: manifest.displayName,
        extensionEnabled: manifest.enabled !== false,
        validationErrors: validateMediaExtensionManifest(manifest),
        missingCapabilities: listMissingValues(definition.requiredCapabilities, manifest.requiredCapabilities),
        missingPermissions: listMissingValues(definition.requiredPermissions, manifest.requiredPermissions)
      };
    }
  }
  return null;
}

export function isMediaObjectDefinitionEnabled(definition: RegisteredMediaObjectDefinition): boolean {
  return definition.extensionEnabled && definition.enabled !== false;
}

export function isMediaObjectDefinitionAvailable(definition: RegisteredMediaObjectDefinition): boolean {
  return isMediaObjectDefinitionEnabled(definition)
    && definition.missingCapabilities.length === 0
    && definition.missingPermissions.length === 0
    && definition.validationErrors.length === 0;
}

export function isMediaObjectTypeAvailable(objectType: string): boolean {
  const definition = getMediaObjectDefinition(objectType);
  return Boolean(definition && isMediaObjectDefinitionAvailable(definition));
}

export function listAvailableMediaObjectTypes(manifests: readonly NoahMediaExtensionManifest[] = BUILTIN_MEDIA_EXTENSION_MANIFESTS): string[] {
  const types: string[] = [];
  for (const manifest of manifests) {
    for (const definition of manifest.objectTypes) {
      const registered = getMediaObjectDefinition(definition.objectType, manifests);
      if (registered && isMediaObjectDefinitionAvailable(registered)) {
        types.push(registered.objectType);
      }
    }
  }
  return uniqueValues(types);
}

export function getMediaExtensionDebugSnapshot(manifests: readonly NoahMediaExtensionManifest[] = BUILTIN_MEDIA_EXTENSION_MANIFESTS): MediaExtensionDebugEntry[] {
  return manifests.map((manifest) => {
    const validationErrors = validateMediaExtensionManifest(manifest);
    const extensionEnabled = manifest.enabled !== false;
    return {
      id: manifest.id,
      version: manifest.version,
      displayName: manifest.displayName,
      enabled: extensionEnabled,
      valid: validationErrors.length === 0,
      validationErrors,
      objectTypes: manifest.objectTypes.map((definition) => {
        const registered = getMediaObjectDefinition(definition.objectType, manifests)!;
        const enabled = isMediaObjectDefinitionEnabled(registered);
        const available = isMediaObjectDefinitionAvailable(registered);
        return {
          objectType: registered.objectType,
          displayName: registered.displayName,
          stateKind: registered.stateKind,
          enabled,
          available,
          requiredCapabilities: [...registered.requiredCapabilities],
          requiredPermissions: [...registered.requiredPermissions],
          missingCapabilities: [...registered.missingCapabilities],
          missingPermissions: [...registered.missingPermissions]
        };
      })
    };
  });
}

export type MediaObjectStatus = "active" | "stopped" | "failed";

export interface MediaSurface {
  surfaceId: string;
  roomId: string;
  label?: string;
  kind?: "wall" | "table" | "laptop" | "floating" | "custom";
  widthM?: number;
  heightM?: number;
  transform?: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    pitch: number;
    roll: number;
  };
  widthPx: number;
  heightPx: number;
  inputEnabled: boolean;
  mediaAudioEnabled: boolean;
  visible: boolean;
  allowedObjectTypes: string[];
  activeObjectId: string | null;
  lockedByParticipantId: string | null;
}

export interface MediaObjectInstance<State = unknown> {
  objectId: string;
  type: MediaObjectType;
  roomId: string;
  surfaceId: string;
  ownerParticipantId: string;
  state: State;
  status: MediaObjectStatus;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface RoomMediaObjectsState {
  surfaces: Record<string, MediaSurface>;
  objects: Record<string, MediaObjectInstance>;
}

export interface SurfaceTestCardState {
  clickCount: number;
  lastInputEventId: string | null;
}

export type ScreenShareObjectStatus = "idle" | "selecting" | "publishing" | "active" | "stopping" | "stopped" | "failed";

export type ScreenShareErrorCode =
  | "display_capture_unsupported"
  | "display_capture_denied"
  | "display_capture_failed"
  | "media_network_blocked"
  | "track_unpublished"
  | "unknown";

export interface ScreenShareObjectState {
  status: ScreenShareObjectStatus;
  ownerParticipantId: string;
  surfaceId: string;
  mediaTrackSid?: string;
  startedAtMs?: number;
  stoppedAtMs?: number;
  errorCode?: ScreenShareErrorCode;
}

export type WhiteboardStatus = "active" | "locked" | "failed";
export type WhiteboardTool = "pen";
export type WhiteboardColor = typeof WHITEBOARD_ALLOWED_COLORS[number];
export type WhiteboardWidth = typeof WHITEBOARD_ALLOWED_WIDTHS[number];

export interface WhiteboardPoint {
  u: number;
  v: number;
  t: number;
  pressure?: number;
}

export interface WhiteboardStroke {
  strokeId: string;
  participantId: string;
  tool: WhiteboardTool;
  color: WhiteboardColor;
  width: WhiteboardWidth;
  points: WhiteboardPoint[];
}

export interface WhiteboardState {
  status: WhiteboardStatus;
  strokes: WhiteboardStroke[];
  revision: number;
  lastInputEventId: string | null;
}

export type RemoteBrowserStatus = "idle" | "starting" | "loading" | "publishing" | "active" | "stopping" | "stopped" | "failed";

export type RemoteBrowserErrorCode =
  | "url_not_allowed"
  | "url_resolution_blocked"
  | "redirect_not_allowed"
  | "executor_unavailable"
  | "executor_crashed"
  | "executor_timeout"
  | "navigation_failed"
  | "viewport_capture_unsupported"
  | "viewport_capture_denied"
  | "viewport_capture_failed"
  | "audio_track_missing"
  | "video_track_missing"
  | "livekit_token_failed"
  | "livekit_publish_failed"
  | "input_rejected"
  | "stream_failed"
  | "unknown";

export interface RemoteBrowserObjectState {
  status: RemoteBrowserStatus;
  ownerParticipantId: string;
  surfaceId: string;
  controllerParticipantId?: string;
  executorSessionId?: string;
  frameStreamId?: string;
  mediaParticipantId?: string;
  mediaTrackSid?: string;
  audioTrackSid?: string;
  mediaSourceRect?: RemoteBrowserMediaSourceRect;
  currentUrl?: string;
  title?: string;
  loadedAtMs?: number;
  lastFrameAtMs?: number;
  streamStartedAtMs?: number;
  streamUpdatedAtMs?: number;
  stoppedAtMs?: number;
  streamErrorCode?: RemoteBrowserErrorCode;
  errorDetail?: string;
  lastInputSeq?: number;
  lastExecutorInput?: RemoteBrowserExecutorInputState;
  lastInputEventId: string | null;
  errorCode?: RemoteBrowserErrorCode;
}

export interface RemoteBrowserExecutorInputState {
  inputEventId: string;
  inputType: "pointer" | "scroll" | "keyboard";
  eventKind: SurfaceInputEvent["kind"];
  x: number;
  y: number;
  receivedAtMs: number;
  appliedAtMs: number;
  status: "applied" | "failed";
  pageUrl?: string;
  pageClosed: boolean;
  targetDetail?: string;
  errorDetail?: string;
}

export interface RemoteBrowserMediaSourceRect {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

export type SurfaceTestCardPatch = {
  type: "increment-click-count";
  inputEventId: string;
};

export type ScreenSharePatch =
  | { type: "mark-selecting" }
  | { type: "mark-publishing" }
  | { type: "mark-active"; mediaTrackSid: string }
  | { type: "mark-failed"; errorCode: ScreenShareErrorCode }
  | { type: "mark-stopped" };

export type WhiteboardPatch =
  | { type: "append-stroke"; stroke: WhiteboardStroke; inputEventId: string }
  | { type: "clear"; inputEventId: string };

export type RemoteBrowserPatch =
  | { type: "open-url"; url: string; inputEventId: string }
  | { type: "mark-publishing"; mediaParticipantId: string; inputEventId: string }
  | { type: "mark-active"; mediaParticipantId: string; mediaTrackSid: string; audioTrackSid: string; mediaSourceRect?: RemoteBrowserMediaSourceRect; inputEventId: string }
  | { type: "mark-source-rect"; mediaSourceRect: RemoteBrowserMediaSourceRect; inputEventId: string }
  | { type: "mark-input-applied"; input: RemoteBrowserExecutorInputState; inputEventId: string }
  | { type: "mark-stopped"; inputEventId: string }
  | { type: "pointer"; event: SurfaceInputEvent; inputEventId: string }
  | { type: "scroll"; event: SurfaceInputEvent; inputEventId: string }
  | { type: "keyboard"; event: SurfaceInputEvent; inputEventId: string }
  | { type: "take-control"; inputEventId: string }
  | { type: "release-control"; inputEventId: string }
  | { type: "mark-failed"; errorCode: RemoteBrowserErrorCode; errorDetail?: string; inputEventId: string };

export type MediaObjectCommandBlockedReason =
  | "missing-permission"
  | "missing-extension-capability"
  | "extension-disabled"
  | "missing-surface"
  | "missing-object"
  | "unknown-object-type"
  | "surface-occupied"
  | "object-surface-mismatch"
  | "revision-mismatch"
  | "invalid-patch"
  | "duplicate-input-event";

export interface MediaObjectCommandResult {
  accepted: boolean;
  commandId: string;
  role: RoomRole;
  permission: RoomPermission;
  blockedReason: MediaObjectCommandBlockedReason | null;
  surfaceId: string | null;
  objectId: string | null;
  objectType: string | null;
  revision: number | null;
}

export function createDefaultRoomMediaObjectsState(roomId: string): RoomMediaObjectsState {
  const commonObjectTypes = listAvailableMediaObjectTypes();
  return {
    surfaces: {
      [DEFAULT_MEDIA_SURFACE_ID]: {
        surfaceId: DEFAULT_MEDIA_SURFACE_ID,
        roomId,
        label: "Main screen",
        kind: "wall",
        widthM: 5.8,
        heightM: 3.3,
        transform: { x: 0, y: 2.2, z: -6.6, yaw: 0, pitch: 0, roll: 0 },
        widthPx: 1920,
        heightPx: 1080,
        inputEnabled: true,
        mediaAudioEnabled: false,
        visible: true,
        allowedObjectTypes: commonObjectTypes,
        activeObjectId: null,
        lockedByParticipantId: null
      },
      [WHITEBOARD_MEDIA_SURFACE_ID]: {
        surfaceId: WHITEBOARD_MEDIA_SURFACE_ID,
        roomId,
        label: "Whiteboard wall",
        kind: "wall",
        widthM: 3.2,
        heightM: 2.0,
        transform: { x: -4.6, y: 2.0, z: -5.8, yaw: 0.18, pitch: 0, roll: 0 },
        widthPx: 1920,
        heightPx: 1080,
        inputEnabled: true,
        mediaAudioEnabled: false,
        visible: true,
        allowedObjectTypes: commonObjectTypes,
        activeObjectId: null,
        lockedByParticipantId: null
      },
      [LAPTOP_MEDIA_SURFACE_ID]: {
        surfaceId: LAPTOP_MEDIA_SURFACE_ID,
        roomId,
        label: "Laptop screen",
        kind: "laptop",
        widthM: 1.9,
        heightM: 1.1,
        transform: { x: 3.7, y: 1.45, z: -4.2, yaw: -0.28, pitch: 0, roll: 0 },
        widthPx: 1280,
        heightPx: 720,
        inputEnabled: true,
        mediaAudioEnabled: false,
        visible: true,
        allowedObjectTypes: commonObjectTypes,
        activeObjectId: null,
        lockedByParticipantId: null
      }
    },
    objects: {}
  };
}
