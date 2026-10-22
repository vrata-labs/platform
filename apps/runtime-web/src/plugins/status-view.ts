import { isRoomPluginPlainText, roomPluginUtf8ByteLength, ROOM_PLUGIN_LIMITS } from "@vrata/room-plugin-sdk";

export interface RoomPluginStatusRow {
  name: string | null;
  state: "loading" | "running" | "suspended" | "failed";
  text: string;
  seatingUnavailable?: boolean;
}
function text(row: RoomPluginStatusRow): string | null {
  try {
    const name = row.name && isRoomPluginPlainText(row.name) && roomPluginUtf8ByteLength(row.name) <= 128 ? row.name : null;
    const prefix = name ? `Плагин «${name}»: ` : "Room behavior: ";
    if (row.state === "loading") return prefix + "Loading…";
    if (row.state === "suspended") return prefix + "Paused until room access and connection are revalidated.";
    if (row.state === "failed") return prefix + "Stopped. Re-enable this behavior or reload the room to try again.";
    if (!isRoomPluginPlainText(row.text) || roomPluginUtf8ByteLength(row.text) > ROOM_PLUGIN_LIMITS.statusTextBytes) return prefix + "Status unavailable.";
    if (row.seatingUnavailable) return prefix + (row.text ? row.text + " — " : "") + "Automatic seating is not available in this runtime yet.";
    return row.text ? prefix + row.text : null;
  } catch { return "Room behavior: Status unavailable."; }
}

/** A separate labelled text-only sink, never the platform's system warning line. */
export function createRoomPluginStatusView(input: {
  root: Pick<HTMLElement, "hidden">;
  list: Pick<HTMLElement, "replaceChildren">;
  document: Pick<Document, "createElement">;
}) {
  let previous = "";
  return {
    render(rows: readonly RoomPluginStatusRow[]): void {
      const messages = rows.slice(0, ROOM_PLUGIN_LIMITS.enabledPluginsPerRoom).map(text).filter((value): value is string => value !== null);
      const next = JSON.stringify(messages); if (next === previous) return;
      previous = next; input.root.hidden = !messages.length;
      const nodes = messages.map(message => {
        const node = input.document.createElement("p"); node.className = "audio-device-status"; node.textContent = message; return node;
      });
      input.list.replaceChildren(...nodes);
    }
  };
}
