import test from "node:test";
import assert from "node:assert/strict";

import { describeManifest, fetchRuntimeSpaces, formatSpaceOptions, resolveCurrentSpace, resolveJoinMode } from "./index.js";

test("resolveJoinMode detects mobile agents", () => {
  assert.equal(resolveJoinMode("Mozilla/5.0 (iPhone)"), "mobile");
});

test("describeManifest returns room and template", () => {
  assert.equal(
    describeManifest({
      roomId: "demo-room",
      template: "meeting-room-basic",
      theme: {
        primaryColor: "#5fc8ff",
        accentColor: "#163354"
      },
      realtime: {
        roomStateUrl: "ws://127.0.0.1:2567"
      },
      access: {
        joinMode: "link",
        guestAllowed: true
      },
      assets: [],
      features: { voice: true, spatialAudio: true, screenShare: false }
    }),
    "demo-room:meeting-room-basic"
  );
});

test("formatSpaceOptions appends short room id for duplicate names", () => {
  const options = formatSpaceOptions([
    {
      roomId: "demo-room",
      tenantId: "demo-tenant",
      name: "Shared Space",
      templateId: "meeting-room-basic",
      roomLink: "http://127.0.0.1:4000/rooms/demo-room"
    },
    {
      roomId: "alt-room-1234",
      tenantId: "demo-tenant",
      name: "Shared Space",
      templateId: "showroom-basic",
      roomLink: "http://127.0.0.1:4000/rooms/alt-room-1234"
    }
  ]);

  assert.equal(options[0]?.label, "Shared Space (demo-roo)");
  assert.equal(options[1]?.label, "Shared Space (alt-room)");
});

test("resolveCurrentSpace returns the matching room", () => {
  const current = resolveCurrentSpace([
    {
      roomId: "demo-room",
      tenantId: "demo-tenant",
      name: "Demo Room",
      templateId: "meeting-room-basic",
      roomLink: "http://127.0.0.1:4000/rooms/demo-room"
    }
  ], "demo-room");

  assert.equal(current?.roomId, "demo-room");
});

test("fetchRuntimeSpaces maps runtime spaces into labeled options", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    items: [{
      roomId: "demo-room",
      tenantId: "demo-tenant",
      name: "Demo Room",
      templateId: "meeting-room-basic",
      roomLink: "http://127.0.0.1:4000/rooms/demo-room"
    }]
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });

  try {
    const spaces = await fetchRuntimeSpaces("http://127.0.0.1:4000", "demo-room");
    assert.equal(spaces[0]?.label, "Demo Room");
    assert.equal(spaces[0]?.roomId, "demo-room");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchRuntimeSpaces throws on http error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "spaces_unavailable" }), {
    status: 503,
    headers: { "content-type": "application/json" }
  });

  try {
    await assert.rejects(() => fetchRuntimeSpaces("http://127.0.0.1:4000", "demo-room"), /failed_to_list_runtime_spaces:503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
