import test from "node:test";
import assert from "node:assert/strict";

import { getRoomPermissions, type RoomRole } from "@vrata/shared-types";
import { signRoomSessionToken, verifyRoomSessionToken } from "@vrata/shared-types/session-token";

test("api module exports server starter", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  const module = await import("./index.js");
  assert.equal(typeof module.startApiServer, "function");
  assert.equal(typeof module.getMissingRequiredApiEnvVars, "function");
  delete process.env.VRATA_DISABLE_AUTOSTART;
});

test("api production env validator reports missing required vars", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  const module = await import("./index.js");

  assert.deepEqual(
    module.getMissingRequiredApiEnvVars({
      NODE_ENV: "production",
      API_PORT: "4000",
      CONTROL_PLANE_ADMIN_TOKEN: "",
      ROOM_STATE_PUBLIC_URL: "ws://127.0.0.1:2567",
      RUNTIME_BASE_URL: "",
      STATE_TOKEN_SECRET: ""
    }),
    ["CONTROL_PLANE_ADMIN_TOKEN", "RUNTIME_BASE_URL", "STATE_TOKEN_SECRET"]
  );

  delete process.env.VRATA_DISABLE_AUTOSTART;
});

test("api health exposes env timestamp and dependencies", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4011";
  const module = await import("./index.js");
  const server = module.startApiServer(4011);

  try {
    const response = await fetch("http://127.0.0.1:4011/health", {
      headers: { "x-request-id": "health-request-id" }
    });
    assert.equal(response.ok, true);
    assert.equal(response.headers.get("x-request-id"), "health-request-id");
    const payload = (await response.json()) as {
      env?: string;
      timestamp?: string;
      dependencies?: { livekit?: boolean };
      features?: {
        avatarsEnabled?: boolean;
        avatarPoseBinaryEnabled?: boolean;
        avatarLipsyncEnabled?: boolean;
        avatarLegIkEnabled?: boolean;
        avatarSeatingEnabled?: boolean;
        avatarCustomizationEnabled?: boolean;
        avatarFallbackCapsulesEnabled?: boolean;
      };
    };
    assert.equal(typeof payload.env, "string");
    assert.equal(typeof payload.timestamp, "string");
    assert.equal(typeof payload.dependencies?.livekit, "boolean");
    assert.equal(typeof payload.features?.avatarsEnabled, "boolean");
    assert.equal(typeof payload.features?.avatarPoseBinaryEnabled, "boolean");
    assert.equal(typeof payload.features?.avatarLipsyncEnabled, "boolean");
    assert.equal(typeof payload.features?.avatarLegIkEnabled, "boolean");
    assert.equal(typeof payload.features?.avatarSeatingEnabled, "boolean");
    assert.equal(typeof payload.features?.avatarCustomizationEnabled, "boolean");
    assert.equal(typeof payload.features?.avatarFallbackCapsulesEnabled, "boolean");

    const readyResponse = await fetch("http://127.0.0.1:4011/health/ready");
    assert.equal(readyResponse.ok, true);
    const readyPayload = (await readyResponse.json()) as { status?: string; service?: string };
    assert.equal(readyPayload.status, "ready");
    assert.equal(readyPayload.service, "api");

    const liveResponse = await fetch("http://127.0.0.1:4011/health/live");
    assert.equal(liveResponse.ok, true);
    const livePayload = (await liveResponse.json()) as { status?: string; service?: string };
    assert.equal(livePayload.status, "live");
    assert.equal(livePayload.service, "api");

    const metricsResponse = await fetch("http://127.0.0.1:4011/metrics");
    assert.equal(metricsResponse.ok, true);
    const metricsText = await metricsResponse.text();
    assert.match(metricsText, /vrata_rooms_total \d+/);
    assert.match(metricsText, /vrata_active_participants \d+/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
  }
});

test("api diagnostics attach report id, redact secrets, and update metrics", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4029";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  process.env.STATE_TOKEN_SECRET = "diagnostics-report-secret";
  const module = await import("./index.js");
  const server = module.startApiServer(4029);
  const baseUrl = "http://127.0.0.1:4029";

  try {
    const stateResponse = await fetch(`${baseUrl}/api/tokens/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "demo-room", participantId: "p-diagnostics", displayName: "Diagnostics" })
    });
    assert.equal(stateResponse.ok, true);
    const statePayload = (await stateResponse.json()) as { token?: string };
    assert.equal(typeof statePayload.token, "string");

    const reportResponse = await fetch(`${baseUrl}/api/rooms/demo-room/diagnostics`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${statePayload.token}`,
        "x-request-id": "diagnostics-request-id"
      },
      body: JSON.stringify({
        participantId: "p-diagnostics",
        displayName: "Diagnostics",
        mode: "desktop",
        userAgent: "test",
        locomotionMode: "desktop",
        audioState: "failed",
        localPosition: { x: 0, z: 0 },
        xrAxes: { moveX: 0, moveY: 0, turnX: 0 },
        remoteAvatarCount: 0,
        remoteTargets: [],
        lastPresenceSyncAt: 0,
        lastPresenceRefreshAt: 0,
        issueCode: "media_network_blocked",
        access: {
          token: "secret-token-value",
          frameStreamUrl: "https://example.test/frames?token=secret-frame-token"
        },
        sceneDebug: {
          screenshot: {
            width: 1,
            height: 1,
            centerPixel: { r: 0, g: 0, b: 0, a: 255 },
            averageColor: { r: 0, g: 0, b: 0, a: 255 },
            darkPixelRatio: 1,
            pixelSamples: [],
            dataUrl: "data:image/jpeg;base64,secret"
          }
        },
        createdAt: new Date(0).toISOString()
      })
    });
    assert.equal(reportResponse.status, 201);
    assert.equal(reportResponse.headers.get("x-request-id"), "diagnostics-request-id");
    const reportPayload = (await reportResponse.json()) as { reportId?: string; requestId?: string };
    assert.match(reportPayload.reportId ?? "", /^rpt_/);
    assert.equal(reportPayload.requestId, "diagnostics-request-id");

    const publicDiagnosticsResponse = await fetch(`${baseUrl}/api/rooms/demo-room/diagnostics`);
    assert.equal(publicDiagnosticsResponse.status, 401);

    const diagnosticsResponse = await fetch(`${baseUrl}/api/rooms/demo-room/diagnostics`, {
      headers: { "x-vrata-admin-token": "test-admin-token" }
    });
    assert.equal(diagnosticsResponse.ok, true);
    const diagnostics = (await diagnosticsResponse.json()) as { items: Array<{ reportId?: string; requestId?: string; access?: { token?: string; frameStreamUrl?: string }; sceneDebug?: { screenshot?: { dataUrl?: string } } }> };
    const item = diagnostics.items.find((entry) => entry.reportId === reportPayload.reportId);
    assert.equal(item?.requestId, "diagnostics-request-id");
    assert.equal(item?.access?.token, "[redacted]");
    assert.equal(item?.access?.frameStreamUrl?.includes("secret-frame-token"), false);
    assert.match(item?.access?.frameStreamUrl ?? "", /token=/);
    assert.equal(item?.sceneDebug?.screenshot?.dataUrl, undefined);

    const metricsResponse = await fetch(`${baseUrl}/metrics`);
    assert.equal(metricsResponse.ok, true);
    const metricsText = await metricsResponse.text();
    assert.match(metricsText, /vrata_diagnostic_reports_created_total \d+/);
    assert.match(metricsText, /vrata_room_join_failures_total\{reason="media_network_blocked"\} \d+/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.API_PORT;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
    delete process.env.STATE_TOKEN_SECRET;
  }
});

test("state token resolves dev host role and falls back to guest when gated off", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4025";
  process.env.VRATA_DEV_ROLE_QUERY = "true";
  process.env.STATE_TOKEN_SECRET = "test-secret";
  const module = await import("./index.js");
  const server = module.startApiServer(4025);

  try {
    const hostResponse = await fetch("http://127.0.0.1:4025/api/tokens/state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "demo-room", participantId: "p-host", displayName: "Host", requestedRole: "host" })
    });
    assert.equal(hostResponse.ok, true);
    const hostPayload = (await hostResponse.json()) as { token?: string; role?: string; sessionId?: string; access?: { canStartScreenShare?: boolean } };
    assert.equal(typeof hostPayload.token, "string");
    assert.equal(typeof hostPayload.sessionId, "string");
    assert.equal(hostPayload.role, "host");
    assert.equal(hostPayload.access?.canStartScreenShare, true);
    const verified = verifyRoomSessionToken(hostPayload.token, "test-secret", {
      tenantId: "demo-tenant",
      roomId: "demo-room",
      participantId: "p-host"
    });
    assert.equal(verified.ok, true);
    assert.equal(verified.ok ? verified.payload.role : null, "host");

    process.env.VRATA_DEV_ROLE_QUERY = "false";
    const guestResponse = await fetch("http://127.0.0.1:4025/api/tokens/state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "demo-room", participantId: "p-guest", displayName: "Guest", requestedRole: "host" })
    });
    assert.equal(guestResponse.ok, true);
    const guestPayload = (await guestResponse.json()) as { role?: string; access?: { canStartScreenShare?: boolean } };
    assert.equal(guestPayload.role, "guest");
    assert.equal(guestPayload.access?.canStartScreenShare, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.API_PORT;
    delete process.env.VRATA_DEV_ROLE_QUERY;
    delete process.env.STATE_TOKEN_SECRET;
  }
});

test("runtime mutating endpoints require matching room session token", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4033";
  process.env.STATE_TOKEN_SECRET = "runtime-boundary-state-secret";
  const module = await import("./index.js");
  const server = module.startApiServer(4033);

  try {
    const stateResponse = await fetch("http://127.0.0.1:4033/api/tokens/state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "demo-room", participantId: "p-runtime", displayName: "Runtime" })
    });
    assert.equal(stateResponse.ok, true);
    const statePayload = (await stateResponse.json()) as { token?: string };
    const presencePayload = {
      participantId: "p-runtime",
      displayName: "Runtime",
      mode: "desktop",
      rootTransform: { x: 0, y: 0, z: 0 },
      muted: false,
      activeMedia: { audio: false, screenShare: false },
      updatedAt: new Date(0).toISOString()
    };

    const missingToken = await fetch("http://127.0.0.1:4033/api/rooms/demo-room/presence/p-runtime", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(presencePayload)
    });
    assert.equal(missingToken.status, 401);

    const wrongParticipant = await fetch("http://127.0.0.1:4033/api/rooms/demo-room/presence/other-participant", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${statePayload.token}`
      },
      body: JSON.stringify({ ...presencePayload, participantId: "other-participant" })
    });
    assert.equal(wrongParticipant.status, 403);

    const allowed = await fetch("http://127.0.0.1:4033/api/rooms/demo-room/presence/p-runtime", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${statePayload.token}`
      },
      body: JSON.stringify(presencePayload)
    });
    assert.equal(allowed.ok, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.API_PORT;
    delete process.env.STATE_TOKEN_SECRET;
  }
});

test("control-plane authz enforces role matrix and writes audit log", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4035";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  process.env.STATE_TOKEN_SECRET = "control-plane-state-secret";
  process.env.VRATA_DEV_ROLE_QUERY = "true";
  process.env.MINIO_PUBLIC_BASE_URL = "http://127.0.0.1:9000";
  process.env.MINIO_BUCKET = "vrata-scene-bundles";
  const module = await import("./index.js");
  const server = module.startApiServer(4035);
  const baseUrl = "http://127.0.0.1:4035";
  const jsonHeaders = { "content-type": "application/json" };
  const adminHeaders = { ...jsonHeaders, "x-vrata-admin-token": "test-admin-token" };

  const issueToken = async (role: "guest" | "host" | "admin", participantId: string, roomId = "demo-room") => {
    const response = await fetch(`${baseUrl}/api/tokens/state`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ roomId, participantId, displayName: participantId, requestedRole: role })
    });
    assert.equal(response.ok, true);
    return (await response.json()) as { token: string };
  };
  const trustedToken = (role: RoomRole, participantId: string, roomId = "demo-room") => signRoomSessionToken({
    tenantId: "demo-tenant",
    roomId,
    participantId,
    displayName: participantId,
    role,
    roleSource: "trusted",
    permissions: getRoomPermissions(role),
    sessionId: `${participantId}-session`,
    iat: 100,
    exp: 4_102_444_800,
    jti: `${participantId}-jti`
  }, "control-plane-state-secret");

  try {
    const protectedRequests: Array<{ method: string; path: string; body?: unknown }> = [
      { method: "POST", path: "/api/tenants", body: { name: "Tenant" } },
      { method: "PATCH", path: "/api/tenants/demo-tenant", body: { name: "Tenant" } },
      { method: "DELETE", path: "/api/tenants/demo-tenant" },
      { method: "POST", path: "/api/assets", body: { tenantId: "demo-tenant", kind: "logo", url: "logo.glb" } },
      { method: "PATCH", path: "/api/assets/asset-1", body: { validationStatus: "validated" } },
      { method: "DELETE", path: "/api/assets/asset-1" },
      { method: "POST", path: "/api/scene-bundles", body: { bundleId: "bundle-1", storageKey: "scenes/bundle-1/v1/scene.json", version: "v1" } },
      { method: "POST", path: "/api/scene-bundles/bundle-1/versions", body: { storageKey: "scenes/bundle-1/v2/scene.json", version: "v2" } },
      { method: "POST", path: "/api/scene-bundles/bundle-1/current", body: { version: "v1" } },
      { method: "POST", path: "/api/scene-bundles/bundle-1/versions/v1/status", body: { status: "obsolete" } },
      { method: "GET", path: "/api/rooms/demo-room/diagnostics" },
      { method: "POST", path: "/api/rooms", body: { tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Protected Room" } },
      { method: "PATCH", path: "/api/rooms/demo-room", body: { name: "Protected Room" } },
      { method: "POST", path: "/api/rooms/demo-room/bind-scene-bundle", body: { bundleId: "bundle-1" } },
      { method: "DELETE", path: "/api/rooms/demo-room" },
      { method: "GET", path: "/api/rooms/demo-room/xr-telemetry" },
      { method: "GET", path: "/api/audit/control-plane" }
    ];

    for (const item of protectedRequests) {
      const response = await fetch(`${baseUrl}${item.path}`, {
        method: item.method,
        headers: item.body ? jsonHeaders : undefined,
        body: item.body ? JSON.stringify(item.body) : undefined
      });
      assert.equal(response.status, 401, `${item.method} ${item.path}`);
      const payload = (await response.json()) as { reason?: string };
      assert.equal(payload.reason, "missing_identity", `${item.method} ${item.path}`);
    }

    const bundleResponse = await fetch(`${baseUrl}/api/scene-bundles`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ bundleId: "host-bind-bundle", storageKey: "scenes/host-bind/v1/scene.json", version: "v1" })
    });
    assert.equal(bundleResponse.status, 201);

    const adminRoomResponse = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: { ...adminHeaders, "x-request-id": "cp-admin-room-create" },
      body: JSON.stringify({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Admin Matrix Room" })
    });
    assert.equal(adminRoomResponse.status, 201);

    const adminAssetResponse = await fetch(`${baseUrl}/api/assets`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ tenantId: "demo-tenant", kind: "logo", url: "logo.glb" })
    });
    assert.equal(adminAssetResponse.status, 201);

    const guestToken = (await issueToken("guest", "cp-guest")).token;
    const guestCreateRoom = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: { ...jsonHeaders, "authorization": `Bearer ${guestToken}`, "x-request-id": "cp-guest-room-create" },
      body: JSON.stringify({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Guest Matrix Room" })
    });
    assert.equal(guestCreateRoom.status, 403);
    assert.equal((await guestCreateRoom.json() as { permission?: string }).permission, "room.create");

    const hostToken = (await issueToken("host", "cp-host", "demo-room")).token;
    const hostTenantWrite = await fetch(`${baseUrl}/api/tenants`, {
      method: "POST",
      headers: { ...jsonHeaders, "authorization": `Bearer ${hostToken}`, "x-request-id": "cp-host-tenant-create" },
      body: JSON.stringify({ name: "Host Tenant" })
    });
    assert.equal(hostTenantWrite.status, 403);

    const hostOwnBind = await fetch(`${baseUrl}/api/rooms/demo-room/bind-scene-bundle`, {
      method: "POST",
      headers: { ...jsonHeaders, "authorization": `Bearer ${hostToken}`, "x-request-id": "cp-host-own-bind" },
      body: JSON.stringify({ bundleId: "host-bind-bundle" })
    });
    assert.equal(hostOwnBind.status, 403);

    const trustedHostToken = trustedToken("host", "cp-trusted-host", "demo-room");
    const trustedHostOwnBind = await fetch(`${baseUrl}/api/rooms/demo-room/bind-scene-bundle`, {
      method: "POST",
      headers: { ...jsonHeaders, "authorization": `Bearer ${trustedHostToken}`, "x-request-id": "cp-trusted-host-own-bind" },
      body: JSON.stringify({ bundleId: "host-bind-bundle" })
    });
    assert.equal(trustedHostOwnBind.status, 200);

    const trustedHostOwnTelemetry = await fetch(`${baseUrl}/api/rooms/demo-room/xr-telemetry`, {
      headers: { "authorization": `Bearer ${trustedHostToken}` }
    });
    assert.equal(trustedHostOwnTelemetry.status, 200);

    const otherRoomResponse = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Other Matrix Room" })
    });
    const otherRoom = (await otherRoomResponse.json()) as { roomId: string };
    const hostOtherBind = await fetch(`${baseUrl}/api/rooms/${otherRoom.roomId}/bind-scene-bundle`, {
      method: "POST",
      headers: { ...jsonHeaders, "authorization": `Bearer ${trustedHostToken}`, "x-request-id": "cp-host-other-bind" },
      body: JSON.stringify({ bundleId: "host-bind-bundle" })
    });
    assert.equal(hostOtherBind.status, 403);

    const hostOtherTelemetry = await fetch(`${baseUrl}/api/rooms/${otherRoom.roomId}/xr-telemetry`, {
      headers: { "authorization": `Bearer ${trustedHostToken}` }
    });
    assert.equal(hostOtherTelemetry.status, 403);

    const sessionAdminToken = (await issueToken("admin", "cp-session-admin", "demo-room")).token;
    const sessionAdminTenantWrite = await fetch(`${baseUrl}/api/tenants`, {
      method: "POST",
      headers: { ...jsonHeaders, "authorization": `Bearer ${sessionAdminToken}`, "x-request-id": "cp-session-admin-tenant-create" },
      body: JSON.stringify({ name: "Session Admin Tenant" })
    });
    assert.equal(sessionAdminTenantWrite.status, 403);
    assert.equal((await sessionAdminTenantWrite.json() as { reason?: string; permission?: string }).permission, "tenant.write");

    const tokenBody = guestToken.split(".")[0] ?? "";
    assert.notEqual(tokenBody, "");
    const forgedPayload = JSON.parse(Buffer.from(tokenBody, "base64url").toString("utf8")) as { role: string };
    forgedPayload.role = "admin";
    const forgedBody = Buffer.from(JSON.stringify(forgedPayload), "utf8").toString("base64url");
    const forgedToken = guestToken.replace(tokenBody, forgedBody);
    const forgedResponse = await fetch(`${baseUrl}/api/tenants`, {
      method: "POST",
      headers: { ...jsonHeaders, "authorization": `Bearer ${forgedToken}` },
      body: JSON.stringify({ name: "Forged Tenant" })
    });
    assert.equal(forgedResponse.status, 401);
    assert.equal((await forgedResponse.json() as { reason?: string }).reason, "invalid_signature");

    const auditResponse = await fetch(`${baseUrl}/api/audit/control-plane`, {
      headers: { "x-vrata-admin-token": "test-admin-token" }
    });
    assert.equal(auditResponse.ok, true);
    const auditPayload = (await auditResponse.json()) as {
      items: Array<{ requestId?: string; action?: string; permission?: string; object?: { type?: string; id?: string }; result?: string; reason?: string; actor?: { role?: string; actorId?: string } }>;
    };
    assert.equal(auditPayload.items.some((item) => item.requestId === "cp-guest-room-create" && item.action === "room.create" && item.result === "denied" && item.actor?.role === "guest"), true);
    assert.equal(auditPayload.items.some((item) => item.requestId === "cp-host-own-bind" && item.action === "room.bind-scene-bundle" && item.result === "denied" && item.actor?.role === "host"), true);
    assert.equal(auditPayload.items.some((item) => item.requestId === "cp-trusted-host-own-bind" && item.action === "room.bind-scene-bundle" && item.result === "allowed" && item.actor?.role === "host"), true);
    assert.equal(auditPayload.items.some((item) => item.requestId === "cp-session-admin-tenant-create" && item.action === "tenant.create" && item.result === "denied" && item.actor?.role === "admin"), true);
    assert.equal(auditPayload.items.some((item) => item.requestId === "cp-admin-room-create" && item.permission === "room.create" && item.result === "allowed"), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.API_PORT;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
    delete process.env.STATE_TOKEN_SECRET;
    delete process.env.VRATA_DEV_ROLE_QUERY;
    delete process.env.MINIO_PUBLIC_BASE_URL;
    delete process.env.MINIO_BUCKET;
  }
});

test("remote browser frame token endpoint returns websocket URL and short-lived token", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4026";
  process.env.VRATA_DEV_ROLE_QUERY = "true";
  process.env.STATE_TOKEN_SECRET = "remote-browser-frame-state-secret";
  process.env.REMOTE_BROWSER_PUBLIC_URL = "https://browser.89.169.161.91.sslip.io";
  process.env.REMOTE_BROWSER_TOKEN_SECRET = "remote-browser-test-secret";
  process.env.REMOTE_BROWSER_TOKEN_TTL_SECONDS = "120";
  const module = await import("./index.js");
  const server = module.startApiServer(4026);

  try {
    const stateResponse = await fetch("http://127.0.0.1:4026/api/tokens/state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "room-1", participantId: "host-1", displayName: "Host", requestedRole: "host" })
    });
    assert.equal(stateResponse.ok, true);
    const statePayload = (await stateResponse.json()) as { token?: string };

    const response = await fetch("http://127.0.0.1:4026/api/tokens/remote-browser-frame", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${statePayload.token}`
      },
      body: JSON.stringify({
        roomId: "room-1",
        objectId: "object-1",
        executorSessionId: "remote-browser:object-1",
        frameStreamId: "remote-browser:object-1:frames"
      })
    });
    assert.equal(response.ok, true);
    const payload = (await response.json()) as { token?: string; expiresInSeconds?: number; frameStreamUrl?: string };
    assert.equal(typeof payload.token, "string");
    assert.equal(payload.expiresInSeconds, 120);
    assert.equal(payload.frameStreamUrl?.startsWith("wss://browser.89.169.161.91.sslip.io/frames?token="), true);

    const tokenBody = payload.token?.split(".")[0] ?? "";
    const tokenPayload = JSON.parse(Buffer.from(tokenBody, "base64url").toString("utf8")) as { roomId?: string; objectId?: string; executorSessionId?: string; frameStreamId?: string; exp?: number };
    assert.equal(tokenPayload.roomId, "room-1");
    assert.equal(tokenPayload.objectId, "object-1");
    assert.equal(tokenPayload.executorSessionId, "remote-browser:object-1");
    assert.equal(tokenPayload.frameStreamId, "remote-browser:object-1:frames");
    assert.equal(typeof tokenPayload.exp, "number");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.API_PORT;
    delete process.env.VRATA_DEV_ROLE_QUERY;
    delete process.env.STATE_TOKEN_SECRET;
    delete process.env.REMOTE_BROWSER_PUBLIC_URL;
    delete process.env.REMOTE_BROWSER_TOKEN_SECRET;
    delete process.env.REMOTE_BROWSER_TOKEN_TTL_SECONDS;
  }
});

test("room manifest exposes optional scene bundle url", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4012";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  const module = await import("./index.js");
  const server = module.startApiServer(4012);

  try {
    const createResponse = await fetch("http://127.0.0.1:4012/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "test-admin-token"
      },
      body: JSON.stringify({
        tenantId: "demo-tenant",
        templateId: "meeting-room-basic",
        name: "Scene Bundle Room",
        sceneBundleUrl: "/assets/scenes/the-hall-v1/scene.json"
      })
    });
    assert.equal(createResponse.ok, true);

    const room = (await createResponse.json()) as { roomId: string };
    const manifestResponse = await fetch(`http://127.0.0.1:4012/api/rooms/${room.roomId}/manifest`);
    assert.equal(manifestResponse.ok, true);
      const manifest = (await manifestResponse.json()) as {
        sceneBundle?: { url?: string };
        avatars?: {
          avatarsEnabled?: boolean;
          avatarCatalogUrl?: string;
          avatarPoseBinaryEnabled?: boolean;
          avatarCustomizationEnabled?: boolean;
        };
      };
      assert.equal(manifest.sceneBundle?.url, "/assets/scenes/the-hall-v1/scene.json");
      assert.equal(manifest.avatars?.avatarsEnabled, true);
      assert.equal(manifest.avatars?.avatarCatalogUrl, "/assets/avatars/catalog.v1.json");
      assert.equal(manifest.avatars?.avatarPoseBinaryEnabled, true);
      assert.equal(manifest.avatars?.avatarCustomizationEnabled, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
  }
});

test("room manifest exposes avatar config when enabled", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4017";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  const module = await import("./index.js");
  const server = module.startApiServer(4017);

  try {
    const createResponse = await fetch("http://127.0.0.1:4017/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "test-admin-token"
      },
      body: JSON.stringify({
        tenantId: "demo-tenant",
        templateId: "meeting-room-basic",
        name: "Avatar Room",
        avatarConfig: {
          avatarsEnabled: true,
          avatarCatalogUrl: "/assets/avatars/catalog.v1.json",
          avatarQualityProfile: "xr",
          avatarFallbackCapsulesEnabled: true,
          avatarSeatsEnabled: false
        }
      })
    });
    assert.equal(createResponse.ok, true);
    const room = (await createResponse.json()) as { roomId: string };

    const manifestResponse = await fetch(`http://127.0.0.1:4017/api/rooms/${room.roomId}/manifest`);
    assert.equal(manifestResponse.ok, true);
    const manifest = (await manifestResponse.json()) as {
      avatars?: {
        avatarsEnabled?: boolean;
        avatarCatalogUrl?: string;
        avatarQualityProfile?: string;
        avatarPoseBinaryEnabled?: boolean;
        avatarLipsyncEnabled?: boolean;
        avatarLegIkEnabled?: boolean;
        avatarFallbackCapsulesEnabled?: boolean;
        avatarCustomizationEnabled?: boolean;
      };
    };
    assert.equal(manifest.avatars?.avatarsEnabled, true);
    assert.equal(manifest.avatars?.avatarCatalogUrl, "/assets/avatars/catalog.v1.json");
    assert.equal(manifest.avatars?.avatarQualityProfile, "xr");
    assert.equal(manifest.avatars?.avatarPoseBinaryEnabled, true);
    assert.equal(manifest.avatars?.avatarLipsyncEnabled, false);
    assert.equal(manifest.avatars?.avatarLegIkEnabled, false);
    assert.equal(manifest.avatars?.avatarFallbackCapsulesEnabled, true);
    assert.equal(manifest.avatars?.avatarCustomizationEnabled, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
  }
});

test("room manifest derives secure room-state url behind https proxy", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4020";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  delete process.env.ROOM_STATE_PUBLIC_URL;
  const module = await import("./index.js");
  const server = module.startApiServer(4020);

  try {
    const manifestResponse = await fetch("http://127.0.0.1:4020/api/rooms/demo-room/manifest", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "89.169.161.91.sslip.io"
      }
    });
    assert.equal(manifestResponse.ok, true);
    const manifest = (await manifestResponse.json()) as {
      realtime?: { roomStateUrl?: string };
    };
    assert.equal(manifest.realtime?.roomStateUrl, "wss://state.89.169.161.91.sslip.io");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
  }
});

test("room manifest upgrades insecure configured room-state url behind https proxy", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4021";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  process.env.ROOM_STATE_PUBLIC_URL = "ws://89.169.161.91:2567";
  const module = await import("./index.js");
  const server = module.startApiServer(4021);

  try {
    const manifestResponse = await fetch("http://127.0.0.1:4021/api/rooms/demo-room/manifest", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "89.169.161.91.sslip.io"
      }
    });
    assert.equal(manifestResponse.ok, true);
    const manifest = (await manifestResponse.json()) as {
      realtime?: { roomStateUrl?: string };
    };
    assert.equal(manifest.realtime?.roomStateUrl, "wss://state.89.169.161.91.sslip.io");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
    delete process.env.ROOM_STATE_PUBLIC_URL;
  }
});

test("xr telemetry endpoint stores latest runtime snapshot for admin inspection", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4024";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  const module = await import("./index.js");
  const server = module.startApiServer(4024);

  try {
    const stateResponse = await fetch("http://127.0.0.1:4024/api/tokens/state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "demo-room", participantId: "p-1", displayName: "XR Runtime" })
    });
    assert.equal(stateResponse.ok, true);
    const statePayload = (await stateResponse.json()) as { token?: string };
    const runtimeHeaders = {
      "content-type": "application/json",
      "authorization": `Bearer ${statePayload.token}`
    };

    const putResponse = await fetch("http://127.0.0.1:4024/api/rooms/demo-room/xr-telemetry/p-1", {
      method: "PUT",
      headers: runtimeHeaders,
      body: JSON.stringify({
        participantId: "ignored",
        roomId: "ignored",
        updatedAt: "2026-04-16T10:00:00.000Z",
        statusLine: "Seated at hall-seat-a",
        currentSeatId: "hall-seat-a",
        xrAxes: { turnX: 0.4, turnY: -1 },
        interactionRay: {
          active: true,
          mode: "xr-right-stick",
          source: { index: 1, handedness: "right" }
        }
      })
    });
    assert.equal(putResponse.ok, true);

    const getResponse = await fetch("http://127.0.0.1:4024/api/rooms/demo-room/xr-telemetry", {
      headers: {
        "x-vrata-admin-token": "test-admin-token"
      }
    });
    assert.equal(getResponse.ok, true);
    const payload = await getResponse.json() as {
      items?: Array<{
        participantId?: string;
        roomId?: string;
        currentSeatId?: string | null;
        interactionRay?: { source?: { index?: number; handedness?: string | null } };
        history?: Array<{ kind?: string | null; currentSeatId?: string | null }>;
      }>;
    };
    assert.equal(payload.items?.[0]?.participantId, "p-1");
    assert.equal(payload.items?.[0]?.roomId, "demo-room");
    assert.equal(payload.items?.[0]?.currentSeatId, "hall-seat-a");
    assert.equal(payload.items?.[0]?.interactionRay?.source?.index, 1);
    assert.equal(payload.items?.[0]?.interactionRay?.source?.handedness, "right");
    assert.equal(Array.isArray(payload.items?.[0]?.history), true);

    const secondPut = await fetch("http://127.0.0.1:4024/api/rooms/demo-room/xr-telemetry/p-1", {
      method: "PUT",
      headers: runtimeHeaders,
      body: JSON.stringify({
        updatedAt: "2026-04-16T10:00:01.000Z",
        kind: "trigger_press",
        currentSeatId: null
      })
    });
    assert.equal(secondPut.ok, true);

    const secondGet = await fetch("http://127.0.0.1:4024/api/rooms/demo-room/xr-telemetry", {
      headers: {
        "x-vrata-admin-token": "test-admin-token"
      }
    });
    const secondPayload = await secondGet.json() as {
      items?: Array<{
        kind?: string | null;
        history?: Array<{ kind?: string | null; currentSeatId?: string | null }>;
      }>;
    };
    assert.equal(secondPayload.items?.[0]?.kind, "trigger_press");
    assert.equal(secondPayload.items?.[0]?.history?.length, 2);
    assert.equal(secondPayload.items?.[0]?.history?.[0]?.currentSeatId, "hall-seat-a");
    assert.equal(secondPayload.items?.[0]?.history?.[1]?.kind, "trigger_press");

    const idlePut = await fetch("http://127.0.0.1:4024/api/rooms/demo-room/xr-telemetry/p-1", {
      method: "PUT",
      headers: runtimeHeaders,
      body: JSON.stringify({
        updatedAt: "2026-04-16T10:00:02.000Z",
        kind: null,
        currentSeatId: null,
        xrAxes: { moveX: 0, moveY: 0, turnX: 0, turnY: 0 },
        xrRawInputs: []
      })
    });
    assert.equal(idlePut.ok, true);

    const idleGet = await fetch("http://127.0.0.1:4024/api/rooms/demo-room/xr-telemetry", {
      headers: {
        "x-vrata-admin-token": "test-admin-token"
      }
    });
    const idlePayload = await idleGet.json() as {
      items?: Array<{ history?: Array<unknown> }>;
    };
    assert.equal(idlePayload.items?.[0]?.history?.length, 2);

    const repeatedSeatPut = await fetch("http://127.0.0.1:4024/api/rooms/demo-room/xr-telemetry/p-1", {
      method: "PUT",
      headers: runtimeHeaders,
      body: JSON.stringify({
        updatedAt: "2026-04-16T10:00:03.000Z",
        currentSeatId: "hall-seat-a",
        xrAxes: { moveX: 0, moveY: 0, turnX: 0, turnY: 0 },
        xrRawInputs: []
      })
    });
    assert.equal(repeatedSeatPut.ok, true);

    const repeatedSeatGet = await fetch("http://127.0.0.1:4024/api/rooms/demo-room/xr-telemetry", {
      headers: {
        "x-vrata-admin-token": "test-admin-token"
      }
    });
    const repeatedSeatPayload = await repeatedSeatGet.json() as {
      items?: Array<{ history?: Array<unknown> }>;
    };
    assert.equal(repeatedSeatPayload.items?.[0]?.history?.length, 3);

    const repeatedSeatPutAgain = await fetch("http://127.0.0.1:4024/api/rooms/demo-room/xr-telemetry/p-1", {
      method: "PUT",
      headers: runtimeHeaders,
      body: JSON.stringify({
        updatedAt: "2026-04-16T10:00:04.000Z",
        currentSeatId: "hall-seat-a",
        xrAxes: { moveX: 0, moveY: 0, turnX: 0, turnY: 0 },
        xrRawInputs: []
      })
    });
    assert.equal(repeatedSeatPutAgain.ok, true);

    const repeatedSeatGetAgain = await fetch("http://127.0.0.1:4024/api/rooms/demo-room/xr-telemetry", {
      headers: {
        "x-vrata-admin-token": "test-admin-token"
      }
    });
    const repeatedSeatPayloadAgain = await repeatedSeatGetAgain.json() as {
      items?: Array<{ history?: Array<unknown> }>;
    };
    assert.equal(repeatedSeatPayloadAgain.items?.[0]?.history?.length, 3);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
  }
});

test("media token derives secure livekit url behind https proxy", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4022";
  process.env.LIVEKIT_URL = "ws://89.169.161.91:7880";
  process.env.STATE_TOKEN_SECRET = "media-token-state-secret";
  const module = await import("./index.js");
  const server = module.startApiServer(4022);

  try {
    const denied = await fetch("http://127.0.0.1:4022/api/tokens/media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "demo-room", participantId: "guest-test", canPublishAudio: true, canPublishVideo: false })
    });
    assert.equal(denied.status, 401);

    const stateResponse = await fetch("http://127.0.0.1:4022/api/tokens/state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: "demo-room", participantId: "guest-test", displayName: "Guest Test" })
    });
    assert.equal(stateResponse.ok, true);
    const statePayload = (await stateResponse.json()) as { token?: string };
    assert.equal(typeof statePayload.token, "string");

    const response = await fetch("http://127.0.0.1:4022/api/tokens/media", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${statePayload.token}`,
        "x-forwarded-proto": "https",
        "x-forwarded-host": "89.169.161.91.sslip.io"
      },
      body: JSON.stringify({
        roomId: "demo-room",
        participantId: "guest-test",
        canPublishAudio: true,
        canPublishVideo: false
      })
    });
    assert.equal(response.ok, true);
    const payload = (await response.json()) as { livekitUrl?: string };
    assert.equal(payload.livekitUrl, "wss://livekit.89.169.161.91.sslip.io");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.LIVEKIT_URL;
    delete process.env.STATE_TOKEN_SECRET;
  }
});

test("remote browser media token requires internal auth and scoped publisher identity", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4027";
  process.env.VRATA_INTERNAL_SERVICE_TOKEN = "internal-token";
  process.env.LIVEKIT_URL = "ws://89.169.161.91:7880";
  const module = await import("./index.js");
  const server = module.startApiServer(4027);

  try {
    const denied = await fetch("http://127.0.0.1:4027/api/tokens/remote-browser-media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        roomId: "demo-room",
        objectId: "browser-1",
        executorSessionId: "remote-browser:browser-1",
        mediaParticipantId: "remote-browser:browser-1"
      })
    });
    assert.equal(denied.status, 403);

    const response = await fetch("http://127.0.0.1:4027/api/tokens/remote-browser-media", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-internal-token": "internal-token",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "89.169.161.91.sslip.io"
      },
      body: JSON.stringify({
        roomId: "demo-room",
        objectId: "browser-1",
        executorSessionId: "remote-browser:browser-1",
        mediaParticipantId: "remote-browser:browser-1"
      })
    });
    assert.equal(response.ok, true);
    const payload = (await response.json()) as { token?: string; livekitUrl?: string; participantId?: string };
    assert.equal(typeof payload.token, "string");
    assert.equal(payload.livekitUrl, "wss://livekit.89.169.161.91.sslip.io");
    assert.equal(payload.participantId, "remote-browser:browser-1");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.VRATA_INTERNAL_SERVICE_TOKEN;
    delete process.env.LIVEKIT_URL;
  }
});

test("remote browser media token can prefer public livekit url for secure captured pages", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4028";
  process.env.VRATA_INTERNAL_SERVICE_TOKEN = "internal-token";
  process.env.LIVEKIT_URL = "ws://89.169.161.91:7880";
  process.env.VRATA_LIVEKIT_DOMAIN = "livekit.89.169.161.91.sslip.io";
  const module = await import("./index.js");
  const server = module.startApiServer(4028);

  try {
    const headers = {
      "content-type": "application/json",
      "x-vrata-internal-token": "internal-token"
    };
    const basePayload = {
      roomId: "demo-room",
      objectId: "browser-1",
      executorSessionId: "remote-browser:browser-1",
      mediaParticipantId: "remote-browser:browser-1"
    };
    const internalResponse = await fetch("http://127.0.0.1:4028/api/tokens/remote-browser-media", {
      method: "POST",
      headers,
      body: JSON.stringify(basePayload)
    });
    assert.equal(internalResponse.ok, true);
    const internalPayload = (await internalResponse.json()) as { livekitUrl?: string };
    assert.equal(internalPayload.livekitUrl, "ws://89.169.161.91:7880");

    const publicResponse = await fetch("http://127.0.0.1:4028/api/tokens/remote-browser-media", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...basePayload, preferPublicLivekitUrl: true })
    });
    assert.equal(publicResponse.ok, true);
    const publicPayload = (await publicResponse.json()) as { livekitUrl?: string };
    assert.equal(publicPayload.livekitUrl, "wss://livekit.89.169.161.91.sslip.io");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.VRATA_INTERNAL_SERVICE_TOKEN;
    delete process.env.LIVEKIT_URL;
    delete process.env.VRATA_LIVEKIT_DOMAIN;
  }
});

test("room api accepts legacy top-level avatar fields and normalizes them into avatarConfig", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4018";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  const module = await import("./index.js");
  const server = module.startApiServer(4018);

  try {
    const createResponse = await fetch("http://127.0.0.1:4018/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "test-admin-token"
      },
      body: JSON.stringify({
        tenantId: "demo-tenant",
        templateId: "meeting-room-basic",
        name: "Legacy Avatar Room",
        avatarsEnabled: true,
        avatarCatalogUrl: "/assets/avatars/catalog.v1.json",
        avatarQualityProfile: "mobile-lite",
        avatarFallbackCapsulesEnabled: true,
        avatarSeatsEnabled: true
      })
    });
    assert.equal(createResponse.ok, true);
    const room = (await createResponse.json()) as { roomId: string; avatarConfig?: { avatarsEnabled?: boolean; avatarSeatsEnabled?: boolean } };
    assert.equal(room.avatarConfig?.avatarsEnabled, true);
    assert.equal(room.avatarConfig?.avatarSeatsEnabled, true);

    const manifestResponse = await fetch(`http://127.0.0.1:4018/api/rooms/${room.roomId}/manifest`);
    assert.equal(manifestResponse.ok, true);
    const manifest = (await manifestResponse.json()) as {
      avatars?: { avatarsEnabled?: boolean; avatarQualityProfile?: string; avatarSeatsEnabled?: boolean };
    };
    assert.equal(manifest.avatars?.avatarsEnabled, true);
    assert.equal(manifest.avatars?.avatarQualityProfile, "mobile-lite");
    assert.equal(manifest.avatars?.avatarSeatsEnabled, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
  }
});

test("room api merges partial avatarConfig updates onto defaults", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4019";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  const module = await import("./index.js");
  const server = module.startApiServer(4019);

  try {
    const createResponse = await fetch("http://127.0.0.1:4019/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "test-admin-token"
      },
      body: JSON.stringify({
        tenantId: "demo-tenant",
        templateId: "meeting-room-basic",
        name: "Partial Avatar Config Room"
      })
    });
    assert.equal(createResponse.ok, true);
    const room = (await createResponse.json()) as { roomId: string };

    const patchResponse = await fetch(`http://127.0.0.1:4019/api/rooms/${room.roomId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "test-admin-token"
      },
      body: JSON.stringify({
        avatarConfig: {
          avatarsEnabled: true,
          avatarQualityProfile: "xr"
        }
      })
    });
    assert.equal(patchResponse.ok, true);
    const updated = (await patchResponse.json()) as {
      avatarConfig?: {
        avatarsEnabled?: boolean;
        avatarCatalogUrl?: string;
        avatarQualityProfile?: string;
        avatarFallbackCapsulesEnabled?: boolean;
        avatarSeatsEnabled?: boolean;
      };
    };
    assert.equal(updated.avatarConfig?.avatarsEnabled, true);
    assert.equal(updated.avatarConfig?.avatarQualityProfile, "xr");
    assert.equal(updated.avatarConfig?.avatarCatalogUrl, "/assets/avatars/catalog.v1.json");
    assert.equal(updated.avatarConfig?.avatarFallbackCapsulesEnabled, true);
    assert.equal(updated.avatarConfig?.avatarSeatsEnabled, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
  }
});

test("runtime spaces endpoint keeps same-tenant guest-safe rooms only", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4013";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  const module = await import("./index.js");
  const server = module.startApiServer(4013);

  try {
    const createGuestRoomResponse = await fetch("http://127.0.0.1:4013/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "test-admin-token"
      },
      body: JSON.stringify({
        tenantId: "demo-tenant",
        templateId: "meeting-room-basic",
        name: "Guest Room",
        guestAllowed: true
      })
    });
    assert.equal(createGuestRoomResponse.ok, true);
    const guestRoom = (await createGuestRoomResponse.json()) as { roomId: string };

    const createPrivateRoomResponse = await fetch("http://127.0.0.1:4013/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "test-admin-token"
      },
      body: JSON.stringify({
        tenantId: "demo-tenant",
        templateId: "meeting-room-basic",
        name: "Private Room",
        guestAllowed: false
      })
    });
    assert.equal(createPrivateRoomResponse.ok, true);

    const spacesResponse = await fetch("http://127.0.0.1:4013/api/rooms/demo-room/spaces");
    assert.equal(spacesResponse.ok, true);
    const payload = (await spacesResponse.json()) as {
      items: Array<{ roomId: string; name: string }>;
    };

    assert.equal(payload.items[0]?.roomId, "demo-room");
    assert.equal(payload.items.some((item) => item.roomId === guestRoom.roomId), true);
    assert.equal(payload.items.some((item) => item.name === "Private Room"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
  }
});

test("runtime spaces endpoint keeps https room links behind https proxy", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4023";
  process.env.RUNTIME_BASE_URL = "http://89.169.161.91:4000";
  const module = await import("./index.js");
  const server = module.startApiServer(4023);

  try {
    const response = await fetch("http://127.0.0.1:4023/api/rooms/demo-room/spaces", {
      headers: {
        host: "89.169.161.91.sslip.io",
        "x-forwarded-host": "89.169.161.91.sslip.io",
        "x-forwarded-proto": "https"
      }
    });
    assert.equal(response.ok, true);
    const payload = (await response.json()) as {
      items: Array<{ roomId: string; roomLink: string }>;
    };

    assert.equal(payload.items[0]?.roomId, "demo-room");
    assert.equal(payload.items[0]?.roomLink, "https://89.169.161.91.sslip.io/rooms/demo-room");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.RUNTIME_BASE_URL;
  }
});

test("scene bundle metadata can be created and bound to a room", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4014";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  process.env.MINIO_PUBLIC_BASE_URL = "http://127.0.0.1:9000";
  process.env.MINIO_BUCKET = "vrata-scene-bundles";
  const module = await import("./index.js");
  const server = module.startApiServer(4014);

  try {
    const bundleResponse = await fetch("http://127.0.0.1:4014/api/scene-bundles", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "test-admin-token"
      },
      body: JSON.stringify({
        bundleId: "hall-bundle",
        storageKey: "scenes/hall/v1/scene.json",
        version: "v1"
      })
    });
    assert.equal(bundleResponse.ok, true);
    const bundle = (await bundleResponse.json()) as { bundleId: string; publicUrl: string };
    assert.equal(bundle.bundleId, "hall-bundle");
    assert.equal(bundle.publicUrl, "http://127.0.0.1:9000/vrata-scene-bundles/scenes/hall/v1/scene.json");

    const roomResponse = await fetch("http://127.0.0.1:4014/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "test-admin-token"
      },
      body: JSON.stringify({
        tenantId: "demo-tenant",
        templateId: "meeting-room-basic",
        name: "Bound Scene Room"
      })
    });
    assert.equal(roomResponse.ok, true);
    const room = (await roomResponse.json()) as { roomId: string };

    const bindResponse = await fetch(`http://127.0.0.1:4014/api/rooms/${room.roomId}/bind-scene-bundle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "test-admin-token"
      },
      body: JSON.stringify({ bundleId: "hall-bundle" })
    });
    assert.equal(bindResponse.ok, true);

    const manifestResponse = await fetch(`http://127.0.0.1:4014/api/rooms/${room.roomId}/manifest`);
    assert.equal(manifestResponse.ok, true);
    const manifest = (await manifestResponse.json()) as { sceneBundle?: { url?: string } };
    assert.equal(manifest.sceneBundle?.url, "http://127.0.0.1:9000/vrata-scene-bundles/scenes/hall/v1/scene.json");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
    delete process.env.MINIO_PUBLIC_BASE_URL;
    delete process.env.MINIO_BUCKET;
  }
});

test("legacy room scene bundle url remains backward compatible", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4015";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  const module = await import("./index.js");
  const server = module.startApiServer(4015);

  try {
    const roomResponse = await fetch("http://127.0.0.1:4015/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "test-admin-token"
      },
      body: JSON.stringify({
        tenantId: "demo-tenant",
        templateId: "meeting-room-basic",
        name: "Legacy Scene Room",
        sceneBundleUrl: "https://example.com/scenes/legacy/scene.json"
      })
    });
    assert.equal(roomResponse.ok, true);
    const room = (await roomResponse.json()) as { roomId: string };

    const manifestResponse = await fetch(`http://127.0.0.1:4015/api/rooms/${room.roomId}/manifest`);
    const manifest = (await manifestResponse.json()) as { sceneBundle?: { url?: string } };
    assert.equal(manifest.sceneBundle?.url, "https://example.com/scenes/legacy/scene.json");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
  }
});

test("scene bundle versions can switch current binding without runtime contract change", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4016";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  process.env.MINIO_PUBLIC_BASE_URL = "http://127.0.0.1:9000";
  process.env.MINIO_BUCKET = "vrata-scene-bundles";
  const module = await import("./index.js");
  const server = module.startApiServer(4016);

  try {
    const createVersion = async (version: string) => {
      const response = await fetch(`http://127.0.0.1:4016/api/scene-bundles/hall-productized/versions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vrata-admin-token": "test-admin-token"
        },
        body: JSON.stringify({
          storageKey: `scenes/hall-productized/${version}/scene.json`,
          version
        })
      });
      assert.equal(response.ok, true);
      return response.json();
    };

    const versionOne = await createVersion("v1") as { publicUrl: string };
    const versionTwo = await createVersion("v2") as { publicUrl: string };
    assert.equal(versionOne.publicUrl, "http://127.0.0.1:9000/vrata-scene-bundles/scenes/hall-productized/v1/scene.json");
    assert.equal(versionTwo.publicUrl, "http://127.0.0.1:9000/vrata-scene-bundles/scenes/hall-productized/v2/scene.json");
    assert.notEqual(versionOne.publicUrl, versionTwo.publicUrl);

    const duplicateVersionResponse = await fetch(`http://127.0.0.1:4016/api/scene-bundles/hall-productized/versions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "test-admin-token"
      },
      body: JSON.stringify({
        storageKey: "scenes/hall-productized/v2/scene.json",
        version: "v2"
      })
    });
    assert.equal(duplicateVersionResponse.status, 400);
    assert.equal((await duplicateVersionResponse.json() as { error?: string }).error, "scene_bundle_version_conflict");

    const roomResponse = await fetch("http://127.0.0.1:4016/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "test-admin-token"
      },
      body: JSON.stringify({
        tenantId: "demo-tenant",
        templateId: "meeting-room-basic",
        name: "Productized Bundle Room One"
      })
    });
    const room = (await roomResponse.json()) as { roomId: string };

    const bindResponse = await fetch(`http://127.0.0.1:4016/api/rooms/${room.roomId}/bind-scene-bundle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "test-admin-token"
      },
      body: JSON.stringify({ bundleId: "hall-productized" })
    });
    assert.equal(bindResponse.ok, true);

    let manifest = await (await fetch(`http://127.0.0.1:4016/api/rooms/${room.roomId}/manifest`)).json() as { sceneBundle?: { url?: string } };
    assert.equal(manifest.sceneBundle?.url, "http://127.0.0.1:9000/vrata-scene-bundles/scenes/hall-productized/v2/scene.json");

    const currentResponse = await fetch("http://127.0.0.1:4016/api/scene-bundles/hall-productized/current", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "test-admin-token"
      },
      body: JSON.stringify({ version: "v1" })
    });
    assert.equal(currentResponse.ok, true);

    const reboundResponse = await fetch(`http://127.0.0.1:4016/api/rooms/${room.roomId}/bind-scene-bundle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "test-admin-token"
      },
      body: JSON.stringify({ bundleId: "hall-productized" })
    });
    assert.equal(reboundResponse.ok, true);

    manifest = await (await fetch(`http://127.0.0.1:4016/api/rooms/${room.roomId}/manifest`)).json() as { sceneBundle?: { url?: string } };
    assert.equal(manifest.sceneBundle?.url, "http://127.0.0.1:9000/vrata-scene-bundles/scenes/hall-productized/v1/scene.json");

    const statusResponse = await fetch("http://127.0.0.1:4016/api/scene-bundles/hall-productized/versions/v2/status", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "test-admin-token"
      },
      body: JSON.stringify({ status: "obsolete" })
    });
    assert.equal(statusResponse.ok, true);
    const statusPayload = await statusResponse.json() as { version?: string; status?: string; isCurrent?: boolean };
    assert.equal(statusPayload.version, "v2");
    assert.equal(statusPayload.status, "obsolete");
    assert.equal(statusPayload.isCurrent, false);

    const versionsResponse = await fetch("http://127.0.0.1:4016/api/scene-bundles/hall-productized/versions");
    const versionsPayload = await versionsResponse.json() as { items: Array<{ version: string; status: string; isCurrent: boolean }> };
    const updatedVersionTwo = versionsPayload.items.find((item) => item.version === "v2");
    assert.equal(updatedVersionTwo?.status, "obsolete");
    assert.equal(updatedVersionTwo?.isCurrent, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
    delete process.env.MINIO_PUBLIC_BASE_URL;
    delete process.env.MINIO_BUCKET;
  }
});

test("cleanup-ready scene bundle version is rejected while still bound", async () => {
  process.env.VRATA_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4017";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  process.env.MINIO_PUBLIC_BASE_URL = "http://127.0.0.1:9000";
  process.env.MINIO_BUCKET = "vrata-scene-bundles";
  const module = await import("./index.js");
  const server = module.startApiServer(4017);

  try {
    await fetch("http://127.0.0.1:4017/api/scene-bundles/cleanup-bundle/versions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "test-admin-token"
      },
      body: JSON.stringify({
        storageKey: "scenes/cleanup-bundle/v1/scene.json",
        version: "v1"
      })
    });

    const roomResponse = await fetch("http://127.0.0.1:4017/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "test-admin-token"
      },
      body: JSON.stringify({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Cleanup Bound Room One" })
    });
    const room = (await roomResponse.json()) as { roomId: string };

    await fetch(`http://127.0.0.1:4017/api/rooms/${room.roomId}/bind-scene-bundle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "test-admin-token"
      },
      body: JSON.stringify({ bundleId: "cleanup-bundle" })
    });

    const cleanupResponse = await fetch("http://127.0.0.1:4017/api/scene-bundles/cleanup-bundle/versions/v1/status", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vrata-admin-token": "test-admin-token"
      },
      body: JSON.stringify({ status: "cleanup-ready" })
    });
    assert.equal(cleanupResponse.status, 409);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.VRATA_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
    delete process.env.MINIO_PUBLIC_BASE_URL;
    delete process.env.MINIO_BUCKET;
  }
});
