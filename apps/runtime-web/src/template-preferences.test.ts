import assert from "node:assert/strict";
import test from "node:test";
import type { RoomTemplateSettings } from "@vrata/shared-types";
import { createRoomTemplatePreferences, fetchPublicTemplateSettings } from "./template-preferences.js";

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

const presentation: RoomTemplateSettings = { ...settings, layout: "presentation", audio: { ...settings.audio, joinMutedByDefault: true } };

async function withApi(floor: 1 | 2, routes: Record<string, () => Response>, run: (requested: string[]) => Promise<void>) {
  const original = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    requested.push(path);
    if (path === "/health") return Response.json({ status: "ok", features: floor === 2 ? { identityProtocolVersion: 2 } : {} });
    return routes[path]?.() ?? Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof fetch;
  try { await run(requested); } finally { globalThis.fetch = original; }
}

test("floor 1 keeps reading the room manifest before entry", async () => {
  await withApi(1, {
    "/api/rooms/talk/manifest": () => Response.json({ roomId: "talk", templateSnapshot: { defaults: { settings: presentation } } }),
    "/api/rooms/legacy/manifest": () => Response.json({ roomId: "legacy" })
  }, async (requested) => {
    assert.deepEqual(await fetchPublicTemplateSettings("http://api.test", "talk"), presentation);
    assert.deepEqual(requested, ["/health", "/api/rooms/talk/manifest"]);
    assert.equal(await fetchPublicTemplateSettings("http://api.test", "legacy"), undefined, "a room without a template keeps the legacy defaults");
    assert.equal(await fetchPublicTemplateSettings("http://api.test", "private"), "unavailable");
  });
});

test("floor 2 reads the public pre-join settings, not the manifest the boundary refuses", async () => {
  await withApi(2, {
    "/api/rooms/meeting/prejoin-settings": () => Response.json({ roomId: "meeting", settings }),
    "/api/rooms/meeting/manifest": () => Response.json({ reason: "identity_upgrade_required" }, { status: 409 }),
    "/api/rooms/private/prejoin-settings": () => Response.json({ reason: "identity_upgrade_required" }, { status: 409 }),
    "/api/rooms/legacy/prejoin-settings": () => Response.json({ roomId: "legacy", settings: null })
  }, async (requested) => {
    const meeting = await fetchPublicTemplateSettings("http://api.test", "meeting");
    assert.deepEqual(meeting, settings);
    assert.deepEqual(requested, ["/health", "/api/rooms/meeting/prejoin-settings"]);
    const preferences = createRoomTemplatePreferences("meeting", storage());
    preferences.setTemplate(meeting);
    assert.equal(preferences.joinMuted(true), false, "the guest checkbox follows a template that opens the microphone");
    assert.equal(await fetchPublicTemplateSettings("http://api.test", "private"), "unavailable");
    assert.equal(await fetchPublicTemplateSettings("http://api.test", "legacy"), undefined, "a room without a template keeps the shared defaults");
  });
});

test("a failed pre-join read keeps the guest joining muted unless they chose otherwise in this room", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError("network down"); }) as typeof fetch;
  try { assert.equal(await fetchPublicTemplateSettings("http://api.test", "meeting"), "unavailable"); } finally { globalThis.fetch = original; }
  await withApi(2, { "/api/rooms/meeting/prejoin-settings": () => new Response("bad gateway", { status: 502 }) }, async () => {
    assert.equal(await fetchPublicTemplateSettings("http://api.test", "meeting"), "unavailable");
  });

  const persisted = storage(); persisted.values.set("vrata.audio.joinMuted", "false");
  const failed = createRoomTemplatePreferences("meeting", persisted); failed.setTemplate("unavailable");
  assert.equal(failed.joinMuted(), true, "a shared choice from another room does not open the microphone");
  assert.equal(failed.joinMuted(true), true);
  assert.equal(failed.notesScope(), "shared");

  const chosen = createRoomTemplatePreferences("meeting", persisted); chosen.setTemplate(settings); chosen.setJoinMuted(false);
  const reloaded = createRoomTemplatePreferences("meeting", persisted); reloaded.setTemplate("unavailable");
  assert.equal(reloaded.joinMuted(true), false, "the user's own choice in this room wins");
  reloaded.setTemplate(presentation);
  assert.equal(reloaded.joinMuted(true), false, "and still wins over the template learned after entry");
});

test("the user's saved choice in a room wins over the template read before entry", () => {
  const persisted = storage(); persisted.values.set("vrata.audio.joinMuted.talk", "false");
  const preferences = createRoomTemplatePreferences("talk", persisted); preferences.setTemplate(presentation);
  assert.equal(preferences.joinMuted(true), false);
  const untouched = createRoomTemplatePreferences("other", persisted); untouched.setTemplate(presentation);
  assert.equal(untouched.joinMuted(true), true, "a room the user has not chosen in follows its template");
});

test("a choice made while the template was unknown stays with that room when it turns out to have none", () => {
  const persisted = storage(); persisted.values.set("vrata.audio.joinMuted", "false");
  const prejoin = createRoomTemplatePreferences("private", persisted); prejoin.setTemplate("unavailable");
  prejoin.setJoinMuted(prejoin.joinMuted(true));
  prejoin.setTemplate(undefined);
  assert.equal(persisted.values.get("vrata.audio.joinMuted"), "false", "the shared choice of other rooms is untouched");
  assert.equal(persisted.values.get("vrata.audio.joinMuted.private"), "true");
  const learned = createRoomTemplatePreferences("talk", persisted); learned.setTemplate("unavailable");
  learned.setJoinMuted(false);
  learned.setTemplate(presentation);
  assert.equal(persisted.values.get("vrata.audio.joinMuted.talk"), "false", "a template learned at boot keeps the room's choice");
});

test("a choice made while the template was unknown survives a reload that finds the room without one", () => {
  const persisted = storage(); persisted.values.set("vrata.audio.joinMuted", "false"); persisted.values.set("vrata.notes.scope", "shared");
  const failed = createRoomTemplatePreferences("plain", persisted); failed.setTemplate("unavailable");
  failed.setJoinMuted(true); failed.setNotesScope("private");
  failed.setTemplate(undefined);
  assert.equal(failed.joinMuted(true), true);

  const reloaded = createRoomTemplatePreferences("plain", persisted); reloaded.setTemplate(undefined);
  assert.equal(reloaded.joinMuted(), true, "the room's own choice wins over the shared one");
  assert.equal(reloaded.notesScope(), "private");
  reloaded.setJoinMuted(false);
  assert.equal(persisted.values.get("vrata.audio.joinMuted.plain"), "false", "a later change updates the room's choice");
  assert.equal(createRoomTemplatePreferences("plain", persisted).joinMuted(true), false);

  const other = createRoomTemplatePreferences("other", persisted); other.setTemplate(undefined);
  assert.equal(other.joinMuted(true), false, "rooms without a template keep the shared choice");
  assert.equal(other.notesScope(), "shared");
});
