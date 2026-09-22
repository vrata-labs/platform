import type { RoomTemplateSettings } from "@vrata/shared-types";

export function createRoomTemplatePreferences(roomId: string, storage: {
  read(key: string, legacyKey: string): string | null;
  write(key: string, value: string): void;
}) {
  let settings: RoomTemplateSettings | undefined;
  let sessionMuted: boolean | undefined;
  const key = (name: string) => `vrata.${name}${settings ? `.${roomId}` : ""}`;
  const read = (name: string) => storage.read(key(name), key(name).replace(/^vrata\./, "noah."));
  return {
    setTemplate(value?: RoomTemplateSettings) {
      settings = value;
      if (sessionMuted !== undefined) storage.write(key("audio.joinMuted"), String(sessionMuted));
    },
    joinMuted(legacyDefault = false): boolean {
      if (sessionMuted !== undefined) return sessionMuted;
      const stored = read("audio.joinMuted");
      return stored === null ? settings?.audio.joinMutedByDefault ?? legacyDefault : stored === "true";
    },
    setJoinMuted(value: boolean) {
      sessionMuted = value;
      storage.write(key("audio.joinMuted"), String(value));
    },
    notesScope(): "private" | "shared" {
      const stored = read("notes.scope");
      return stored === null ? settings?.notes.defaultScope ?? "shared" : stored === "private" ? "private" : "shared";
    },
    setNotesScope(value: "private" | "shared") { storage.write(key("notes.scope"), value); }
  };
}

// Public rooms can apply their declared defaults before showing pre-join controls.
// Private-room authorization still happens through the normal token/boot flow.
export async function fetchPublicTemplateSettings(apiBaseUrl: string, roomId: string): Promise<RoomTemplateSettings | undefined> {
  try {
    const response = await fetch(new URL(`/api/rooms/${encodeURIComponent(roomId)}/manifest`, apiBaseUrl), { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return undefined;
    return (await response.json()).templateSnapshot?.defaults?.settings;
  } catch { return undefined; }
}
