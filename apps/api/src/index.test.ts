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

test("scene bundle metadata can be created and bound to a room", async () => {
  process.env.NOAH_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4014";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  process.env.MINIO_PUBLIC_BASE_URL = "http://127.0.0.1:9000";
  process.env.MINIO_BUCKET = "noah-scene-bundles";
  const module = await import("./index.js");
  const server = module.startApiServer(4014);

  try {
    const bundleResponse = await fetch("http://127.0.0.1:4014/api/scene-bundles", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-noah-admin-token": "test-admin-token"
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
    assert.equal(bundle.publicUrl, "http://127.0.0.1:9000/noah-scene-bundles/scenes/hall/v1/scene.json");

    const roomResponse = await fetch("http://127.0.0.1:4014/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-noah-admin-token": "test-admin-token"
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
        "x-noah-admin-token": "test-admin-token"
      },
      body: JSON.stringify({ bundleId: "hall-bundle" })
    });
    assert.equal(bindResponse.ok, true);

    const manifestResponse = await fetch(`http://127.0.0.1:4014/api/rooms/${room.roomId}/manifest`);
    assert.equal(manifestResponse.ok, true);
    const manifest = (await manifestResponse.json()) as { sceneBundle?: { url?: string } };
    assert.equal(manifest.sceneBundle?.url, "http://127.0.0.1:9000/noah-scene-bundles/scenes/hall/v1/scene.json");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.NOAH_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
    delete process.env.MINIO_PUBLIC_BASE_URL;
    delete process.env.MINIO_BUCKET;
  }
});

test("legacy room scene bundle url remains backward compatible", async () => {
  process.env.NOAH_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4015";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  const module = await import("./index.js");
  const server = module.startApiServer(4015);

  try {
    const roomResponse = await fetch("http://127.0.0.1:4015/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-noah-admin-token": "test-admin-token"
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
    delete process.env.NOAH_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
  }
});
