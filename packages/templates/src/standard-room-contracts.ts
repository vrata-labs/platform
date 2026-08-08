import {
  DEFAULT_MEDIA_SURFACE_ID,
  IMAGE_VIEWER_OBJECT_TYPE,
  MARKDOWN_BOARD_OBJECT_TYPE,
  PDF_PRESENTATION_OBJECT_TYPE,
  REMOTE_BROWSER_OBJECT_TYPE,
  SCREEN_SHARE_OBJECT_TYPE,
  VIDEO_PLAYER_OBJECT_TYPE,
  WHITEBOARD_MEDIA_SURFACE_ID,
  WHITEBOARD_OBJECT_TYPE,
  type RoomTemplateSceneContract
} from "@vrata/shared-types";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

const standardRoomTemplateSceneContracts = deepFreeze([
  {
    schemaVersion: 1,
    templateId: "personal-room-basic",
    templateVersion: "1.0.0",
    sceneId: "personal-workspace-v1",
    sceneVersion: "1.0.0",
    surfaces: [{
      surfaceId: DEFAULT_MEDIA_SURFACE_ID,
      label: "Personal workspace",
      purpose: "workspace",
      allowedObjectTypes: [MARKDOWN_BOARD_OBJECT_TYPE, IMAGE_VIEWER_OBJECT_TYPE, VIDEO_PLAYER_OBJECT_TYPE],
      aspectRatio: { width: 2, height: 1, maxRelativeError: 0.02 }
    }],
    seats: { minimum: 2, maximum: 2 }
  },
  {
    schemaVersion: 1,
    templateId: "meeting-room-basic",
    templateVersion: "1.0.0",
    sceneId: "meeting-room-v1",
    sceneVersion: "1.0.0",
    surfaces: [
      {
        surfaceId: DEFAULT_MEDIA_SURFACE_ID,
        label: "Meeting display",
        purpose: "collaboration",
        allowedObjectTypes: [SCREEN_SHARE_OBJECT_TYPE, PDF_PRESENTATION_OBJECT_TYPE, IMAGE_VIEWER_OBJECT_TYPE, VIDEO_PLAYER_OBJECT_TYPE, REMOTE_BROWSER_OBJECT_TYPE],
        aspectRatio: { width: 16, height: 9, maxRelativeError: 0.02 }
      },
      {
        surfaceId: WHITEBOARD_MEDIA_SURFACE_ID,
        label: "Collaboration wall",
        purpose: "collaboration",
        allowedObjectTypes: [WHITEBOARD_OBJECT_TYPE, MARKDOWN_BOARD_OBJECT_TYPE],
        aspectRatio: { width: 48, height: 25, maxRelativeError: 0.02 }
      }
    ],
    seats: { minimum: 4, maximum: 4 }
  },
  {
    schemaVersion: 1,
    templateId: "presentation-room-basic",
    templateVersion: "1.0.0",
    sceneId: "presentation-room-v1",
    sceneVersion: "1.0.0",
    surfaces: [{
      surfaceId: DEFAULT_MEDIA_SURFACE_ID,
      label: "Presentation screen",
      purpose: "presentation",
      allowedObjectTypes: [PDF_PRESENTATION_OBJECT_TYPE, SCREEN_SHARE_OBJECT_TYPE, IMAGE_VIEWER_OBJECT_TYPE, VIDEO_PLAYER_OBJECT_TYPE, REMOTE_BROWSER_OBJECT_TYPE],
      aspectRatio: { width: 16, height: 9, maxRelativeError: 0.02 }
    }],
    seats: { minimum: 6, maximum: 24 }
  }
] satisfies RoomTemplateSceneContract[]);

export function listStandardRoomTemplateSceneContracts(): RoomTemplateSceneContract[] {
  return structuredClone(standardRoomTemplateSceneContracts);
}

export function getStandardRoomTemplateSceneContract(templateId: string, templateVersion: string): RoomTemplateSceneContract | undefined {
  const contract = standardRoomTemplateSceneContracts.find((candidate) => candidate.templateId === templateId && candidate.templateVersion === templateVersion);
  return contract ? structuredClone(contract) : undefined;
}
