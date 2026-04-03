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
      assert.equal(manifest.avatars?.avatarsEnabled, false);
      assert.equal(manifest.avatars?.avatarCatalogUrl, "/assets/avatars/catalog.v1.json");
      assert.equal(manifest.avatars?.avatarPoseBinaryEnabled, false);
      assert.equal(manifest.avatars?.avatarCustomizationEnabled, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.NOAH_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
  }
});

test("room manifest exposes avatar config when enabled", async () => {
  process.env.NOAH_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4017";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  const module = await import("./index.js");
  const server = module.startApiServer(4017);

  try {
    const createResponse = await fetch("http://127.0.0.1:4017/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-noah-admin-token": "test-admin-token"
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
    assert.equal(manifest.avatars?.avatarPoseBinaryEnabled, false);
    assert.equal(manifest.avatars?.avatarLipsyncEnabled, false);
    assert.equal(manifest.avatars?.avatarLegIkEnabled, false);
    assert.equal(manifest.avatars?.avatarFallbackCapsulesEnabled, true);
    assert.equal(manifest.avatars?.avatarCustomizationEnabled, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.NOAH_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
  }
});

test("room manifest derives secure room-state url behind https proxy", async () => {
  process.env.NOAH_DISABLE_AUTOSTART = "1";
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
    delete process.env.NOAH_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
  }
});

test("room manifest upgrades insecure configured room-state url behind https proxy", async () => {
  process.env.NOAH_DISABLE_AUTOSTART = "1";
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
    delete process.env.NOAH_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
    delete process.env.ROOM_STATE_PUBLIC_URL;
  }
});

test("media token derives secure livekit url behind https proxy", async () => {
  process.env.NOAH_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4022";
  process.env.LIVEKIT_URL = "ws://89.169.161.91:7880";
  const module = await import("./index.js");
  const server = module.startApiServer(4022);

  try {
    const response = await fetch("http://127.0.0.1:4022/api/tokens/media", {
      method: "POST",
      headers: {
        "content-type": "application/json",
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
    delete process.env.NOAH_DISABLE_AUTOSTART;
    delete process.env.LIVEKIT_URL;
  }
});

test("room api accepts legacy top-level avatar fields and normalizes them into avatarConfig", async () => {
  process.env.NOAH_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4018";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  const module = await import("./index.js");
  const server = module.startApiServer(4018);

  try {
    const createResponse = await fetch("http://127.0.0.1:4018/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-noah-admin-token": "test-admin-token"
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
    delete process.env.NOAH_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
  }
});

test("room api merges partial avatarConfig updates onto defaults", async () => {
  process.env.NOAH_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4019";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  const module = await import("./index.js");
  const server = module.startApiServer(4019);

  try {
    const createResponse = await fetch("http://127.0.0.1:4019/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-noah-admin-token": "test-admin-token"
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
        "x-noah-admin-token": "test-admin-token"
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
    assert.equal(updated.avatarConfig?.avatarSeatsEnabled, false);
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

test("runtime spaces endpoint keeps https room links behind https proxy", async () => {
  process.env.NOAH_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4023";
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
    delete process.env.NOAH_DISABLE_AUTOSTART;
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

test("scene bundle versions can switch current binding without runtime contract change", async () => {
  process.env.NOAH_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4016";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  process.env.MINIO_PUBLIC_BASE_URL = "http://127.0.0.1:9000";
  process.env.MINIO_BUCKET = "noah-scene-bundles";
  const module = await import("./index.js");
  const server = module.startApiServer(4016);

  try {
    const createVersion = async (version: string) => {
      const response = await fetch(`http://127.0.0.1:4016/api/scene-bundles/hall-productized/versions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-noah-admin-token": "test-admin-token"
        },
        body: JSON.stringify({
          storageKey: `scenes/hall-productized/${version}/scene.json`,
          version
        })
      });
      assert.equal(response.ok, true);
      return response.json();
    };

    await createVersion("v1");
    await createVersion("v2");

    const roomResponse = await fetch("http://127.0.0.1:4016/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-noah-admin-token": "test-admin-token"
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
        "x-noah-admin-token": "test-admin-token"
      },
      body: JSON.stringify({ bundleId: "hall-productized" })
    });
    assert.equal(bindResponse.ok, true);

    let manifest = await (await fetch(`http://127.0.0.1:4016/api/rooms/${room.roomId}/manifest`)).json() as { sceneBundle?: { url?: string } };
    assert.equal(manifest.sceneBundle?.url, "http://127.0.0.1:9000/noah-scene-bundles/scenes/hall-productized/v2/scene.json");

    const currentResponse = await fetch("http://127.0.0.1:4016/api/scene-bundles/hall-productized/current", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-noah-admin-token": "test-admin-token"
      },
      body: JSON.stringify({ version: "v1" })
    });
    assert.equal(currentResponse.ok, true);

    const reboundResponse = await fetch(`http://127.0.0.1:4016/api/rooms/${room.roomId}/bind-scene-bundle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-noah-admin-token": "test-admin-token"
      },
      body: JSON.stringify({ bundleId: "hall-productized" })
    });
    assert.equal(reboundResponse.ok, true);

    manifest = await (await fetch(`http://127.0.0.1:4016/api/rooms/${room.roomId}/manifest`)).json() as { sceneBundle?: { url?: string } };
    assert.equal(manifest.sceneBundle?.url, "http://127.0.0.1:9000/noah-scene-bundles/scenes/hall-productized/v1/scene.json");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.NOAH_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
    delete process.env.MINIO_PUBLIC_BASE_URL;
    delete process.env.MINIO_BUCKET;
  }
});

test("cleanup-ready scene bundle version is rejected while still bound", async () => {
  process.env.NOAH_DISABLE_AUTOSTART = "1";
  process.env.API_PORT = "4017";
  process.env.CONTROL_PLANE_ADMIN_TOKEN = "test-admin-token";
  process.env.MINIO_PUBLIC_BASE_URL = "http://127.0.0.1:9000";
  process.env.MINIO_BUCKET = "noah-scene-bundles";
  const module = await import("./index.js");
  const server = module.startApiServer(4017);

  try {
    await fetch("http://127.0.0.1:4017/api/scene-bundles/cleanup-bundle/versions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-noah-admin-token": "test-admin-token"
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
        "x-noah-admin-token": "test-admin-token"
      },
      body: JSON.stringify({ tenantId: "demo-tenant", templateId: "meeting-room-basic", name: "Cleanup Bound Room One" })
    });
    const room = (await roomResponse.json()) as { roomId: string };

    await fetch(`http://127.0.0.1:4017/api/rooms/${room.roomId}/bind-scene-bundle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-noah-admin-token": "test-admin-token"
      },
      body: JSON.stringify({ bundleId: "cleanup-bundle" })
    });

    const cleanupResponse = await fetch("http://127.0.0.1:4017/api/scene-bundles/cleanup-bundle/versions/v1/status", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-noah-admin-token": "test-admin-token"
      },
      body: JSON.stringify({ status: "cleanup-ready" })
    });
    assert.equal(cleanupResponse.status, 409);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.NOAH_DISABLE_AUTOSTART;
    delete process.env.CONTROL_PLANE_ADMIN_TOKEN;
    delete process.env.MINIO_PUBLIC_BASE_URL;
    delete process.env.MINIO_BUCKET;
  }
});
