import test from "node:test";
import assert from "node:assert/strict";

import { describeManifest, fetchMediaToken, planVoiceSession, fetchRuntimeSpaces, fetchStateToken, formatSpaceOptions, listPresence, resolveCurrentSpace, resolveJoinMode, transferRoomOwner } from "./index.js";
import { MediaTokenRequestError, planBaseMedia } from "./media/media-token-error.js";

test("optional base share refusal makes one real mic-only HTTP request with unchanged proof and no state renewal", async () => {
  const previous = globalThis.fetch, sent: boolean[] = []; let renewals = 0;
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/health") return Response.json({ features: {} });
    if (path.endsWith("/manifest")) return Response.json({ features: { spatialAudio: false } });
    if (path === "/api/tokens/state") renewals++;
    assert.equal(path, "/api/tokens/media");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer original-proof");
    const body = JSON.parse(String(init?.body)); sent.push(body.canPublishVideo);
    if (body.canPublishVideo) return Response.json({ reason: "media_publish_not_allowed" }, { status: 403 });
    return Response.json({ token: "mic", livekitUrl: "ws://media.example.test" });
  };
  try {
    const result = await planBaseMedia({ optionalShare: true, proofStillCurrent: () => true,
      plan: screenShare => planVoiceSession("https://example.test", "room", "participant", "original-proof",
        { canPublishAudio: true, canPublishVideo: screenShare }) });
    assert.equal(result.token, "mic"); assert.deepEqual(sent, [true, false]); assert.equal(renewals, 0);
  } finally { globalThis.fetch = previous; }
});

test("media request intent explicitly scopes microphone and screen share while preserving the session proof", async () => {
  const previous = globalThis.fetch; const sent: unknown[] = [];
  globalThis.fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer original-proof");
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ token: "media", expiresInSeconds: 7, livekitUrl: "ws://media.example.test" });
  };
  try {
    await fetchMediaToken("https://example.test", "room", "participant", "original-proof");
    await fetchMediaToken("https://example.test", "room", "participant", "original-proof", { canPublishAudio: true, canPublishVideo: true });
    assert.deepEqual(sent, [
      { roomId: "room", participantId: "participant", canPublishAudio: true, canPublishVideo: false },
      { roomId: "room", participantId: "participant", canPublishAudio: true, canPublishVideo: true }
    ]);
  } finally { globalThis.fetch = previous; }
});

for (const [status, reason, retry] of [[409, "room_state_changed", true], [503, "media_credential_preparation_expired", true],
  [401, "identity_session_expired", false], [403, "media_publish_not_allowed", false], [409, "identity_recovery_required", false],
  [503, "identity_authority_unavailable", false]] as const) {
  test(`media plan retry is bounded and does not renew proof: ${status}/${reason}`, async () => {
    const previous = globalThis.fetch; let mediaCalls = 0, stateCalls = 0;
    globalThis.fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/tokens/state") stateCalls++;
      if (path === "/health") return Response.json({ features: {} });
      if (path.endsWith("/manifest")) return Response.json({ features: { spatialAudio: true } });
      assert.equal(path, "/api/tokens/media"); mediaCalls++;
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer original-proof");
      if (mediaCalls === 1) return Response.json({ reason }, { status });
      return Response.json({ token: "prepared", livekitUrl: "ws://media.example.test" });
    };
    try {
      const run = () => planVoiceSession("https://example.test", "room", "participant", "original-proof");
      if (retry) assert.equal((await run()).token, "prepared");
      else await assert.rejects(run(), error => error instanceof MediaTokenRequestError && error.status === status);
      assert.equal(mediaCalls, retry ? 2 : 1); assert.equal(stateCalls, 0);
    } finally { globalThis.fetch = previous; }
  });
}

test("a second media conflict stops at two attempts with a fixed error and no credential renewal", async () => {
  const previous = globalThis.fetch; let count = 0;
  globalThis.fetch = async url => {
    if (String(url).endsWith("/health")) return Response.json({ features: {} });
    if (String(url).endsWith("/manifest")) return Response.json({ features: { spatialAudio: false } });
    count++; return Response.json({ reason: "room_state_changed" }, { status: 409 });
  };
  try {
    await assert.rejects(planVoiceSession("https://example.test", "room", "participant", "proof"), /failed_to_load_media_token:409/);
    assert.equal(count, 2);
  } finally { globalThis.fetch = previous; }
});

test("ownership handoff sends the admitted session and exact authority revision", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), "https://example.test/api/rooms/personal-room/owner/transfer");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer room-session");
    assert.deepEqual(JSON.parse(String(init?.body)), { participantId: "recipient", expectedRevision: 7 });
    return Response.json({ revision: 8, ownerParticipantId: "recipient", state: {} });
  };
  try {
    const result = await transferRoomOwner("https://example.test", "personal-room", "room-session", "recipient", 7);
    assert.equal(result.revision, 8);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});

test("v2 admission omits absent proofs but preserves an explicitly invalid proof for server rejection", async () => {
  const previous = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ token: "session" }), { status: 200 });
  };
  try {
    const access = { identityProtocolVersion: 2 as const, participantId: "untrusted", displayName: "Guest",
      identityCredential: null, waitingCredential: null, inviteToken: null };
    await fetchStateToken("http://127.0.0.1:4000", "demo-room", access);
    await fetchStateToken("http://127.0.0.1:4000", "demo-room", { ...access, identityCredential: "" });
    assert.deepEqual(requests[0], { roomId: "demo-room", identityProtocolVersion: 2, displayName: "Guest" });
    assert.deepEqual(requests[1], { roomId: "demo-room", identityProtocolVersion: 2, identityCredential: "", displayName: "Guest" });
  } finally { globalThis.fetch = previous; }
});

test("v2 room listings and fallback presence forward the admitted session", async () => {
  const previous = globalThis.fetch;
  const calls: Array<{ url: string; authorization: string | undefined }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") ?? undefined });
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  };
  try {
    await fetchRuntimeSpaces("http://127.0.0.1:4000", "demo-room", "", "session-v2");
    await listPresence("http://127.0.0.1:4000", "demo-room", "session-v2");
    assert.deepEqual(calls, [
      { url: "http://127.0.0.1:4000/api/rooms/demo-room/spaces", authorization: "Bearer session-v2" },
      { url: "http://127.0.0.1:4000/api/rooms/demo-room/presence", authorization: "Bearer session-v2" }
    ]);
  } finally { globalThis.fetch = previous; }
});

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
        guestAllowed: true,
        roleQueryAllowed: true,
        visibility: "public"
      },
      assets: [],
      features: { voice: true, spatialAudio: true, screenShare: false },
      avatars: {
        avatarsEnabled: false,
        avatarCatalogUrl: "/assets/avatars/catalog.v1.json",
        avatarQualityProfile: "desktop-standard",
        avatarPoseBinaryEnabled: false,
        avatarLipsyncEnabled: false,
        avatarLegIkEnabled: false,
        avatarFallbackCapsulesEnabled: true,
        avatarSeatsEnabled: false,
        avatarCustomizationEnabled: false
      }
    }),
    "demo-room:meeting-room-basic"
  );
});

test("bootRuntime maps reserved avatar flags and accepts additive template metadata", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({
        features: {
          xrEnabled: true,
          voiceEnabled: true,
          screenShareEnabled: true,
          spatialAudioEnabled: false,
          roomStateRealtimeEnabled: true,
          remoteDiagnosticsEnabled: true,
          sceneBundlesEnabled: true,
          avatarsEnabled: true,
          avatarPoseBinaryEnabled: true,
          avatarLipsyncEnabled: false,
          avatarLegIkEnabled: true,
          avatarSeatingEnabled: false,
          avatarCustomizationEnabled: true,
          avatarFallbackCapsulesEnabled: true,
          remoteBrowserEnabled: true,
          remoteBrowserExperimental: true
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (url.endsWith("/api/tokens/state")) {
      return new Response(JSON.stringify({
        token: "test-token",
        expiresInSeconds: 900,
        role: "guest",
        permissions: ["room.join", "audio.join", "surface.view"],
        access: {
          role: "guest",
          permissions: ["room.join", "audio.join", "surface.view"],
          canStartScreenShare: false,
          canCreateWhiteboard: false,
          canCreateMarkdownBoard: false,
          canEditMarkdownBoard: false,
          canControlSurface: false
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    return new Response(JSON.stringify({
      roomId: "demo-room",
      template: "meeting-room-basic",
      templateVersion: "0.1.0",
      templateSnapshot: {
        schemaVersion: 1,
        templateId: "meeting-room-basic",
        version: "0.1.0",
        label: "Meeting Room Basic",
        assetSlots: ["logo", "hero-screen"],
        roomConfig: {
          roomType: "standard",
          visibility: "public",
          guestAllowed: true,
          sceneBundleUrl: null,
          features: { voice: true, spatialAudio: true, screenShare: false },
          theme: { primaryColor: "#5fc8ff", accentColor: "#163354" },
          avatarConfig: {
            avatarsEnabled: true,
            avatarQualityProfile: "xr",
            avatarFallbackCapsulesEnabled: true
          }
        }
      },
      realtime: { roomStateUrl: "ws://127.0.0.1:2567" },
      theme: { primaryColor: "#5fc8ff", accentColor: "#163354" },
      assets: [],
      features: { voice: true, spatialAudio: true, screenShare: false },
      avatars: {
        avatarsEnabled: true,
        avatarCatalogUrl: "/assets/avatars/catalog.v1.json",
        avatarQualityProfile: "xr",
        avatarPoseBinaryEnabled: false,
        avatarLipsyncEnabled: false,
        avatarLegIkEnabled: false,
        avatarFallbackCapsulesEnabled: true,
        avatarSeatsEnabled: false,
        avatarCustomizationEnabled: false
      },
      access: { joinMode: "link", guestAllowed: true, roleQueryAllowed: true, visibility: "public" }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const { bootRuntime } = await import("./index.js");
    const boot = await bootRuntime("http://127.0.0.1:4000", "demo-room", "Mozilla/5.0");
    assert.equal(boot.template, "meeting-room-basic");
    assert.equal(boot.spatialAudioEnabled, true);
    assert.equal(boot.envFlags.spatialAudio, false);
    assert.equal(boot.envFlags.avatarPoseBinaryEnabled, true);
    assert.equal(boot.envFlags.avatarLegIkEnabled, true);
    assert.equal(boot.envFlags.avatarCustomizationEnabled, true);
    assert.equal(boot.envFlags.remoteBrowserEnabled, true);
    assert.equal(boot.envFlags.remoteBrowserExperimental, true);
    assert.equal(boot.avatarConfig.avatarQualityProfile, "xr");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function minimalBootManifest() {
  return {
    roomId: "demo-room",
    template: "meeting-room-basic",
    realtime: { roomStateUrl: "ws://127.0.0.1:2567" },
    theme: { primaryColor: "#5fc8ff", accentColor: "#163354" },
    assets: [],
    features: { voice: true, spatialAudio: true, screenShare: false },
    avatars: { avatarsEnabled: false },
    access: { joinMode: "link", guestAllowed: true, roleQueryAllowed: false, visibility: "public" }
  };
}

async function bootWithHealth(health: Response) {
  const previous = globalThis.fetch;
  const paths: string[] = []; const admissions: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname; paths.push(path);
    if (path === "/health") return health;
    if (path === "/api/tokens/state") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>; admissions.push(body);
      return Response.json(body.identityProtocolVersion === 2
        ? { token: "session", expiresInSeconds: 900, identityProtocolVersion: 2, participantId: "issued-id", identityCredential: "issued-credential" }
        : { token: "session", expiresInSeconds: 900 });
    }
    return Response.json(minimalBootManifest());
  };
  const { bootRuntime } = await import("./index.js");
  try {
    const boot = await bootRuntime("http://127.0.0.1:4000", "demo-room", "Mozilla/5.0",
      { participantId: "untrusted-id", displayName: "Guest", requestedRole: "host" });
    return { boot, paths, admissions };
  } catch (error) {
    return { error, paths, admissions };
  } finally { globalThis.fetch = previous; }
}

for (const [status, body] of [[503, { error: "identity_authority_unavailable" }], [502, null]] as const) {
  test(`bootRuntime refuses admission when /health answers ${status}`, async () => {
    const result = await bootWithHealth(body ? Response.json(body, { status }) : new Response("bad gateway", { status }));
    assert.match(String(result.error), new RegExp(`runtime_health_unavailable:${status}`));
    assert.deepEqual(result.paths, ["/health"]);
    assert.equal(result.admissions.length, 0);
  });
}

test("bootRuntime keeps the legacy admission body when /health does not announce identity v2", async () => {
  const result = await bootWithHealth(Response.json({ features: {} }));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.admissions, [{ roomId: "demo-room", participantId: "untrusted-id", requestedRole: "host", displayName: "Guest" }]);
  assert.equal(result.boot?.identityProtocolVersion, undefined);
});

test("bootRuntime sends the v2 admission body without the local participant ID when /health announces identity v2", async () => {
  const result = await bootWithHealth(Response.json({ features: { identityProtocolVersion: 2 } }));
  assert.equal(result.error, undefined);
  assert.deepEqual(result.admissions, [{ roomId: "demo-room", identityProtocolVersion: 2, displayName: "Guest" }]);
  assert.equal(result.boot?.identityProtocolVersion, 2);
  assert.equal(result.boot?.participantId, "issued-id");
});

test("voice planning tolerates an unavailable /health and keeps the spatial-audio default", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/health") return Response.json({ error: "identity_authority_unavailable" }, { status: 503 });
    if (path.endsWith("/manifest")) return Response.json(minimalBootManifest());
    return Response.json({ token: "media", expiresInSeconds: 60, livekitUrl: "ws://media.example.test" });
  };
  try {
    const plan = await planVoiceSession("http://127.0.0.1:4000", "demo-room", "participant", "proof");
    assert.equal(plan.token, "media");
    assert.equal(plan.spatialAudioEnabled, true);
  } finally { globalThis.fetch = previous; }
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
