import assert from "node:assert/strict";
import test from "node:test";
import { validateRoomPluginData } from "@vrata/room-plugin-sdk";
import { RoomPluginStorageError } from "./contracts.js";
import { assertRoomPluginPersistedText } from "./storage.js";

test("server persistence boundary rejects NUL keys and nested string values after SDK JSON validation", () => {
  for (const input of [{ "nul\0key": "normal" }, { nested: ["normal", { value: "invalid\0text" }] }]) {
    const validated = validateRoomPluginData(input), before = validateRoomPluginData(validated);
    assert.throws(() => assertRoomPluginPersistedText(validated), error => {
      assert.ok(error instanceof RoomPluginStorageError);
      assert.equal(error.code, "plugin_invalid_persisted_text"); return true;
    });
    assert.deepEqual(validated, before);
  }
});

test("server persistence boundary preserves newline, other PostgreSQL-compatible controls and JS escape text", () => {
  const validated = validateRoomPluginData({ "line\nkey\u001f": ["line\nbreak\t\r\u001f", "\\u0000", false, 0, null] });
  const before = validateRoomPluginData(validated);
  assert.doesNotThrow(() => assertRoomPluginPersistedText(validated));
  assert.deepEqual(validated, before);
});
