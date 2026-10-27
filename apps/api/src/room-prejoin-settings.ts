import type { RoomTemplateSettings } from "@vrata/shared-types";
import type { RoomRecord, Storage } from "./storage.js";

import { sanitizeRoomVisibility } from "./room-input.js";
import { isRoomDisabled } from "./room-session-control.js";

export const PREJOIN_SETTINGS_ROUTE = /^\/api\/rooms\/([^/]+)\/prejoin-settings$/;

export type PrejoinSettingsResponse =
  | { status: 200; body: { roomId: string; settings: RoomTemplateSettings | null } }
  | { status: 404; body: { error: "room_not_found" } };

/** A room an anonymous guest enters by its link: public or unlisted, open to guests and not disabled. A portal-managed
 * room is entered only through a grant, so it is not one of them. */
export function openToAnonymousGuests(room: RoomRecord | null): room is RoomRecord {
  return Boolean(room) && !isRoomDisabled(room) && !room!.managed && room!.guestAllowed !== false
    && sanitizeRoomVisibility(room!.visibility) !== "private";
}

/** The template settings a guest sees after entry anyway; null for a room without them.
 * Copied field by field so nothing else stored in the snapshot reaches an anonymous reader. */
export function publicPrejoinSettings(room: RoomRecord): RoomTemplateSettings | null {
  const settings = room.templateSnapshot?.defaults?.settings;
  if (!settings) return null;
  const { notes, audio, presentation } = settings;
  return {
    layout: settings.layout,
    notes: { enabled: notes.enabled, defaultScope: notes.defaultScope },
    audio: { enabled: audio.enabled, spatial: audio.spatial, joinMutedByDefault: audio.joinMutedByDefault, participantLayout: audio.participantLayout },
    presentation: { enabled: presentation.enabled, ...(presentation.surfaceId ? { surfaceId: presentation.surfaceId } : {}) }
  };
}

/** Anonymous pre-join read. It is exempt from the identity boundary only for a room open to anonymous guests; every other
 * room, including a missing one, keeps the refusal an anonymous manifest read gets: the boundary's 409 once bound or at floor 2. */
export async function readPrejoinSettings(storage: Pick<Storage, "getRoom">, boundary: { assertCompatible(roomId?: string): Promise<void> },
  roomId: string): Promise<PrejoinSettingsResponse> {
  const room = await storage.getRoom(roomId);
  if (openToAnonymousGuests(room)) return { status: 200, body: { roomId, settings: publicPrejoinSettings(room) } };
  await boundary.assertCompatible(roomId);
  return { status: 404, body: { error: "room_not_found" } };
}
