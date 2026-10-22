import { isRoomPluginPlainText, roomPluginUtf8ByteLength, ROOM_PLUGIN_LIMITS } from "@vrata/room-plugin-sdk";

export interface RoomPluginStatusRow {
  name: string | null;
  state: "loading" | "running" | "suspended" | "failed";
  text: string;
  seatingUnavailable?: boolean;
  /** A seating-capable behavior runs and the server supports correlated claims. */
  seatingOffered?: boolean;
}
function text(row: RoomPluginStatusRow): string | null {
  try {
    const name = row.name && isRoomPluginPlainText(row.name) && roomPluginUtf8ByteLength(row.name) <= 128 ? row.name : null;
    const prefix = name ? `Плагин «${name}»: ` : "Room behavior: ";
    if (row.state === "loading") return prefix + "Loading…";
    if (row.state === "suspended") return prefix + "Paused until room access and connection are revalidated.";
    if (row.state === "failed") return prefix + "Stopped. Re-enable this behavior or reload the room to try again.";
    if (!isRoomPluginPlainText(row.text) || roomPluginUtf8ByteLength(row.text) > ROOM_PLUGIN_LIMITS.statusTextBytes) return prefix + "Status unavailable.";
    if (row.seatingUnavailable) return prefix + (row.text ? row.text + " — " : "") + "Automatic seating is not available on this server; choose a seat yourself.";
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

/** The participant's own choice. Refusing vetoes any pending automatic claim at once;
 * accepting again applies to a later entry, never reopening this session's grant. */
export function createRoomPluginSeatChoiceView(input: {
  root: Pick<HTMLElement, "hidden">;
  checkbox: Pick<HTMLInputElement, "checked" | "addEventListener">;
  optOut: { get(): boolean; set(value: boolean): void };
  veto(): void;
}) {
  input.checkbox.addEventListener("change", () => {
    const optedOut = !input.checkbox.checked;
    input.optOut.set(optedOut);
    if (optedOut) { try { input.veto(); } catch { /* The stored refusal still applies. */ } }
  });
  return {
    render(rows: readonly RoomPluginStatusRow[]): void {
      input.root.hidden = !rows.some(row => row.seatingOffered);
      input.checkbox.checked = !input.optOut.get();
    }
  };
}
