import type { RoomTemplateSettings } from "@vrata/shared-types";

/** Template settings known before entry: the settings, undefined for a readable room without a template,
 * or "unavailable" when the read failed or was refused and the room may still have a template. */
export type PrejoinTemplateSettings = RoomTemplateSettings | "unavailable" | undefined;

export function createRoomTemplatePreferences(roomId: string, storage: {
  read(key: string, legacyKey: string): string | null;
  write(key: string, value: string): void;
}) {
  let settings: PrejoinTemplateSettings;
  let sessionMuted: boolean | undefined;
  const readKey = (name: string) => storage.read(name, name.replace(/^vrata\./, "noah."));
  // A room with a template keeps its own choices. A room without one shares them with other rooms, unless the user already
  // chose in this room while its template was unknown: that choice stays with the room and does not become the shared one.
  const key = (name: string) => settings || readKey(`vrata.${name}.${roomId}`) !== null ? `vrata.${name}.${roomId}` : `vrata.${name}`;
  const read = (name: string) => readKey(key(name));
  const templateSettings = () => settings === "unavailable" ? undefined : settings;
  return {
    setTemplate(value?: PrejoinTemplateSettings) {
      settings = value;
      if (sessionMuted !== undefined) storage.write(key("audio.joinMuted"), String(sessionMuted));
    },
    joinMuted(legacyDefault = false): boolean {
      if (sessionMuted !== undefined) return sessionMuted;
      const stored = read("audio.joinMuted");
      // An unknown template must not open the microphone: only the user's own choice for this room does.
      if (settings === "unavailable") return stored !== "false";
      return stored === null ? settings?.audio.joinMutedByDefault ?? legacyDefault : stored === "true";
    },
    setJoinMuted(value: boolean) {
      sessionMuted = value;
      storage.write(key("audio.joinMuted"), String(value));
    },
    notesScope(): "private" | "shared" {
      const stored = read("notes.scope");
      return stored === null ? templateSettings()?.notes.defaultScope ?? "shared" : stored === "private" ? "private" : "shared";
    },
    setNotesScope(value: "private" | "shared") { storage.write(key("notes.scope"), value); }
  };
}

// Rooms open to anonymous guests can apply their declared defaults before showing pre-join controls. At identity floor 2
// the boundary refuses an anonymous manifest read, so the API's pre-join answer gives only such a room's template settings.
// Private-room authorization still happens through the normal token/boot flow.
export async function fetchPublicTemplateSettings(apiBaseUrl: string, roomId: string): Promise<PrejoinTemplateSettings> {
  try {
    const signal = AbortSignal.timeout(3000);
    const health = await fetch(new URL("/health", apiBaseUrl), { signal });
    const floorTwo = health.ok && (await health.json() as { features?: { identityProtocolVersion?: unknown } }).features?.identityProtocolVersion === 2;
    const room = encodeURIComponent(roomId);
    if (floorTwo) {
      const response = await fetch(new URL(`/api/rooms/${room}/prejoin-settings`, apiBaseUrl), { signal });
      if (!response.ok) return "unavailable";
      return (await response.json() as { settings: RoomTemplateSettings | null }).settings ?? undefined;
    }
    const response = await fetch(new URL(`/api/rooms/${room}/manifest`, apiBaseUrl), { signal });
    if (!response.ok) return "unavailable";
    return (await response.json() as { templateSnapshot?: { defaults?: { settings?: RoomTemplateSettings } } }).templateSnapshot?.defaults?.settings;
  } catch { return "unavailable"; }
}
