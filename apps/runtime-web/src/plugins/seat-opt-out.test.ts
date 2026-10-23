import test from "node:test";
import assert from "node:assert/strict";
import { createRoomPluginSeatOptOut } from "./seat-opt-out.js";

test("automatic seating refusal is per room, survives a reload of the tab and degrades to memory", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
  const first = createRoomPluginSeatOptOut(storage, "room-a");
  assert.equal(first.get(), false); first.set(true);
  assert.equal(createRoomPluginSeatOptOut(storage, "room-a").get(), true, "a reload reads the stored refusal");
  assert.equal(createRoomPluginSeatOptOut(storage, "room-b").get(), false);
  first.set(false); assert.equal(createRoomPluginSeatOptOut(storage, "room-a").get(), false);
  const broken = createRoomPluginSeatOptOut({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => undefined }, "room-a");
  assert.equal(broken.get(), false); broken.set(true); assert.equal(broken.get(), true);
});
