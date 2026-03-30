import test from "node:test";
import assert from "node:assert/strict";

test("api module exports server starter", async () => {
  process.env.NOAH_DISABLE_AUTOSTART = "1";
  const module = await import("./index.js");
  assert.equal(typeof module.startApiServer, "function");
  assert.equal(typeof module.getMissingRequiredApiEnvVars, "function");
  delete process.env.NOAH_DISABLE_AUTOSTART;
});

test("api production env validator reports missing required vars", async () => {
  process.env.NOAH_DISABLE_AUTOSTART = "1";
  const module = await import("./index.js");

  assert.deepEqual(
    module.getMissingRequiredApiEnvVars({
      NODE_ENV: "production",
      API_PORT: "4000",
      CONTROL_PLANE_ADMIN_TOKEN: "",
      ROOM_STATE_PUBLIC_URL: "ws://127.0.0.1:2567",
      RUNTIME_BASE_URL: ""
    }),
    ["CONTROL_PLANE_ADMIN_TOKEN", "RUNTIME_BASE_URL"]
  );

  delete process.env.NOAH_DISABLE_AUTOSTART;
});

test("api health exposes env timestamp and dependencies", async () => {
  process.env.NOAH_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4011";
  const module = await import("./index.js");
  const server = module.startApiServer(4011);

  try {
    const response = await fetch("http://127.0.0.1:4011/health");
    assert.equal(response.ok, true);
    const payload = (await response.json()) as {
      env?: string;
      timestamp?: string;
      dependencies?: { livekit?: boolean };
    };
    assert.equal(typeof payload.env, "string");
    assert.equal(typeof payload.timestamp, "string");
    assert.equal(typeof payload.dependencies?.livekit, "boolean");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.NOAH_DISABLE_AUTOSTART;
  }
});

test("room manifest exposes optional scene bundle url", async () => {
  process.env.NOAH_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4012";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  const module = await import("./index.js");
  const server = module.startApiServer(4012);

  try {
    const createResponse = await fetch("http://127.0.0.1:4012/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-noah-admin-token": "test-admin-token"
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
    const manifest = (await manifestResponse.json()) as { sceneBundle?: { url?: string } };
    assert.equal(manifest.sceneBundle?.url, "/assets/scenes/the-hall-v1/scene.json");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.NOAH_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
  }
});

test("runtime spaces endpoint keeps same-tenant guest-safe rooms only", async () => {
  process.env.NOAH_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4013";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  const module = await import("./index.js");
  const server = module.startApiServer(4013);

  try {
    const createGuestRoomResponse = await fetch("http://127.0.0.1:4013/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-noah-admin-token": "test-admin-token"
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
        "x-noah-admin-token": "test-admin-token"
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
    delete process.env.NOAH_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
  }
});
