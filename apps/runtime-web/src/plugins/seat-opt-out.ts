type FlagStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Tab-scoped refusal of automatic seating for one room: it survives a reload of
 * this tab, while a new entry in another tab may start a new attempt. */
export function createRoomPluginSeatOptOut(storage: FlagStorage | null, roomId: string) {
  const key = `vrata.autoSeatOptOut.${roomId}`;
  let cached: boolean | null = null;
  return {
    get(): boolean {
      if (cached === null) { try { cached = storage?.getItem(key) === "1"; } catch { cached = false; } }
      return cached;
    },
    set(value: boolean): void {
      cached = value;
      try { if (value) storage?.setItem(key, "1"); else storage?.removeItem(key); } catch { /* The in-memory refusal still applies. */ }
    }
  };
}
