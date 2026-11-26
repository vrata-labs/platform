import { DEFAULT_PRIVATE_ROOM_MEDIA_MODES, type RoomMediaModes, type RoomMediaPolicy } from "@vrata/shared-types";

import { isDocumentsFeatureEnabled, isPortalManagedDeployment, isRemoteBrowserFeatureEnabled } from "./feature-flags.js";
import type { RoomRecord } from "./storage.js";

export function configuredRoomMediaModes(room: RoomRecord): Readonly<RoomMediaModes> | undefined {
  if (room.managed?.kind === "custom") return room.managed.mediaModes ?? DEFAULT_PRIVATE_ROOM_MEDIA_MODES;
  // Enabling the infrastructure for private scenes must not enable it in Portal demos or reference rooms.
  return isPortalManagedDeployment() ? DEFAULT_PRIVATE_ROOM_MEDIA_MODES : undefined;
}

export function effectiveRoomMediaPolicy(room: RoomRecord): RoomMediaPolicy | undefined {
  const modes = configuredRoomMediaModes(room);
  if (!modes) return undefined;
  return {
    revision: room.managed?.revision ?? 0,
    modes: {
      whiteboard: modes.whiteboard,
      remoteBrowser: modes.remoteBrowser && isRemoteBrowserFeatureEnabled(),
      pdf: modes.pdf && isDocumentsFeatureEnabled(),
      video: modes.video && isDocumentsFeatureEnabled()
    }
  };
}

export function roomAllowsDocument(room: RoomRecord, contentType: string): boolean {
  const modes = configuredRoomMediaModes(room);
  if (!modes) return true;
  if (contentType === "application/pdf") return modes.pdf;
  return contentType.startsWith("video/") && modes.video;
}
