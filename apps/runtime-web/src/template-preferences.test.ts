import assert from "node:assert/strict";
import test from "node:test";
import type { RoomTemplateSettings } from "@vrata/shared-types";
import { createRoomTemplatePreferences } from "./template-preferences.js";

const settings: RoomTemplateSettings = { layout: "personal-workspace", notes: { enabled: true, defaultScope: "private" }, audio: { enabled: true, spatial: true, joinMutedByDefault: false, participantLayout: "owner-focused" }, presentation: { enabled: false } };
function storage() {
  const values = new Map<string, string>();
  return { values, read: (key: string, legacy: string) => values.get(key) ?? values.get(legacy) ?? null, write: (key: string, value: string) => { values.set(key, value); } };
}

test("reference defaults are room-specific and do not inherit shared-note scope from a different room", () => {
  const persisted = storage(); persisted.values.set("vrata.notes.scope", "shared");
  const personal = createRoomTemplatePreferences("personal", persisted);
  personal.setTemplate(settings);
  assert.equal(personal.notesScope(), "private");
  assert.equal(personal.joinMuted(), false);
  personal.setNotesScope("shared");
  const reloaded = createRoomTemplatePreferences("personal", persisted); reloaded.setTemplate(settings);
  assert.equal(reloaded.notesScope(), "shared");
  const another = createRoomTemplatePreferences("another", persisted); another.setTemplate(settings);
  assert.equal(another.notesScope(), "private");
});

test("presentation defaults muted, while an explicit choice survives reload and late template discovery", () => {
  const persisted = storage();
  const presentationSettings = { ...settings, audio: { ...settings.audio, joinMutedByDefault: true } };
  const preferences = createRoomTemplatePreferences("presentation", persisted); preferences.setTemplate(presentationSettings);
  assert.equal(preferences.joinMuted(), true);
  preferences.setJoinMuted(false);
  const reloaded = createRoomTemplatePreferences("presentation", persisted); reloaded.setTemplate(presentationSettings);
  assert.equal(reloaded.joinMuted(), false);
  const late = createRoomTemplatePreferences("private", persisted); late.setJoinMuted(true); late.setTemplate(settings);
  assert.equal(late.joinMuted(), true);
  const legacy = createRoomTemplatePreferences("legacy", storage());
  assert.equal(legacy.joinMuted(), false);
  assert.equal(legacy.joinMuted(true), true);
  assert.equal(legacy.notesScope(), "shared");
});
