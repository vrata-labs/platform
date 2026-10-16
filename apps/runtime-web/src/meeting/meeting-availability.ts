import { hasRoomPermission, type MediaObjectInstance, type MediaSurface, type RoomPermission } from "@vrata/shared-types";

export interface MeetingAvailabilityContext {
  admitted: boolean;
  blocked: boolean;
  connected: boolean;
  permissions: readonly RoomPermission[];
  features: { audio: boolean; screenShare: boolean; documents: boolean; notes: boolean; hostControls: boolean };
  capabilities: { microphone: boolean; screenCapture: boolean; speakerSelection: boolean };
  audioJoined: boolean;
  audioBusy: boolean;
  documentSelected: boolean;
  documentDisplayable: boolean;
  canManagePeople: boolean;
  participantSelected: boolean;
  selectedSurfaceId: string;
  localParticipantId: string;
  physicalSurfaceIds: ReadonlySet<string>;
  surfaces: Readonly<Record<string, MediaSurface>> | null;
  objects: Readonly<Record<string, MediaObjectInstance>>;
}

const actions = {
  "join-audio": { permission: "audio.join", feature: "audio", capability: "microphone" },
  "toggle-mute": { permission: "audio.join", feature: "audio", joined: true },
  "speaker-select": { feature: "audio", capability: "speakerSelection" },
  "document-upload-button": { permission: "document.upload", feature: "documents" },
  "document-download-button": { permission: "document.download", feature: "documents", document: "any" },
  "document-surface-button": { permission: "document.present", feature: "documents", document: "display", realtime: true },
  "document-delete-button": { permission: "document.delete", feature: "documents", document: "any" },
  "start-share": { permission: "screen-share.start", feature: "screenShare", capability: "screenCapture", realtime: true, empty: "screen-share" },
  "stop-share": { permission: "screen-share.stop", realtime: true, active: "screen-share", own: true },
  "start-whiteboard": { permission: "surface.create-object", realtime: true, empty: "whiteboard" },
  "draw-whiteboard": { permission: "whiteboard.draw", realtime: true, active: "whiteboard" },
  "clear-whiteboard": { permission: "whiteboard.clear", realtime: true, active: "whiteboard" },
  "stop-whiteboard": { permission: "surface.stop-object", realtime: true, active: "whiteboard" },
  "start-markdown-board": { permission: "surface.create-object", realtime: true, empty: "markdown-board" },
  "notes-editor": { permission: "notes.edit", feature: "notes" },
  "grant-presenter": { feature: "hostControls", manager: true, participant: true },
  "revoke-presenter": { feature: "hostControls", manager: true, participant: true },
  "remove-participant": { feature: "hostControls", manager: true, participant: true },
  "transfer-host": { feature: "hostControls", manager: true, participant: true }
} as const;
export type MeetingAction = keyof typeof actions;
export const MEETING_ACTIONS = Object.freeze(Object.keys(actions) as MeetingAction[]);
type Definition = {
  permission?: RoomPermission;
  feature?: keyof MeetingAvailabilityContext["features"];
  capability?: keyof MeetingAvailabilityContext["capabilities"];
  joined?: boolean; document?: "any" | "display"; realtime?: boolean;
  empty?: string; active?: string; own?: boolean; manager?: boolean; participant?: boolean;
};

/** The existing action producer owns hidden/disabled. This is an explanation, never a permission grant. */
export function meetingActionReason(action: MeetingAction, producer: { disabled: boolean; hidden: boolean }, context: MeetingAvailabilityContext): string | null {
  if (!producer.disabled && !producer.hidden) return null;
  if (context.blocked) return "This session is unavailable. Update or rejoin the room.";
  if (!context.admitted) return "Join the room to use this tool.";
  const definition: Definition = actions[action];
  if (definition.feature && !context.features[definition.feature]) return "This tool is disabled for this room.";
  if (definition.manager && !context.canManagePeople) return "Only the Host or personal-room Owner can manage participants.";
  if (definition.permission && !hasRoomPermission(context.permissions, definition.permission)) {
    if (action === "notes-editor") return "View only: your role cannot edit notes.";
    if (action === "draw-whiteboard") return "View only: Members and Presenters can draw on an open board.";
    if (action === "document-download-button") return "Your role can view the room presentation but cannot download library files.";
    if (action === "document-delete-button") return "Only the Host can delete room files.";
    return "A Host or Presenter is required. Ask the Host for presenting rights.";
  }
  if (definition.capability && !context.capabilities[definition.capability]) {
    return definition.capability === "screenCapture" ? "Screen sharing is unsupported on this device. You can still view presentations."
      : definition.capability === "speakerSelection" ? "Speaker selection is unsupported here; the system default is used."
        : "Microphone input is unavailable in this browser or device.";
  }
  if (definition.realtime && !context.connected) return "Room connection unavailable. Reconnect to use this tool.";
  if (definition.joined && !context.audioJoined) return "Join Audio before using Mute or Unmute.";
  if (definition.document && !context.documentSelected) return "Upload or select a room document first.";
  if (definition.document === "display" && !context.documentDisplayable) return "Select a PDF, image or video to present.";
  if (definition.empty || definition.active) {
    const surface = context.surfaces?.[context.selectedSurfaceId];
    if (!surface || !context.physicalSurfaceIds.has(context.selectedSurfaceId)) return "Room surfaces are still loading or unavailable.";
    if (surface.visible === false) return "The selected surface is unavailable.";
    if (definition.empty && !surface.allowedObjectTypes.includes(definition.empty)) return "Choose a compatible surface for this tool.";
    if (definition.empty && surface.lockedByParticipantId && surface.lockedByParticipantId !== context.localParticipantId) return "The selected surface is locked by another participant.";
    if (definition.empty && surface.activeObjectId) return "This surface is in use. Stop its current content or choose another surface.";
    const object = surface.activeObjectId ? context.objects[surface.activeObjectId] : null;
    if (definition.active && object?.type !== definition.active) return definition.active === "whiteboard" ? "No whiteboard is open on the selected surface." : "No screen share is active on the selected surface.";
    if (definition.own && object?.ownerParticipantId !== context.localParticipantId) return "No local screen share is active on this surface.";
  }
  if (definition.participant && !context.participantSelected) return "Select a participant first.";
  if ((definition.feature === "audio" || definition.joined) && context.audioBusy) return "Audio is connecting or changing. Please wait.";
  return "This action is not ready yet. Wait for the current operation or room update.";
}
