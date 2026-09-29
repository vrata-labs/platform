import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStorage } from "../storage.js";
import { createLegacyIdentityBoundary, IdentityBoundaryError, legacyBoundaryAllowsAdministrator, legacyBoundaryApplies } from "./legacy-boundary.js";

const denied = (status: number) => (error: unknown) => error instanceof IdentityBoundaryError && error.status === status;

test("legacy boundary protects bound rooms independently of the global protocol floor", async () => {
  const storage = new MemoryStorage();
  const boundary = createLegacyIdentityBoundary(Promise.resolve(storage));
  await boundary.assertCompatible("demo-room");
  await storage.roomIdentities.create({ tenantId: "demo-tenant", roomId: "demo-room", displayName: "New identity", baseRole: "guest", provenance: { kind: "guest" } });
  await assert.rejects(boundary.assertCompatible("demo-room"), denied(409));
  await boundary.assertCompatible("still-legacy");
  await storage.identityProtocol.raise(2);
  await assert.rejects(boundary.assertCompatible("still-legacy"), denied(409));
  await assert.rejects(boundary.assertCompatible(), denied(409));
  storage.identityProtocol.minimum = async () => { throw new Error("offline"); };
  await assert.rejects(boundary.assertCompatible(), denied(409), "a confirmed floor cannot be lowered by loss of storage");
});

test("legacy boundary never treats an unavailable policy or room lookup as protocol one", async () => {
  const storage = new MemoryStorage();
  const boundary = createLegacyIdentityBoundary(Promise.resolve(storage));
  storage.identityProtocol.minimum = async () => { throw new Error("offline"); };
  await assert.rejects(boundary.assertCompatible(), denied(503));
  storage.identityProtocol.minimum = async () => 1;
  storage.hasRoomIdentityAuthority = async () => { throw new Error("offline"); };
  await assert.rejects(boundary.assertCompatible("demo-room"), denied(503));
});

test("public static/catalog paths remain distinct from every room credential path", () => {
  for (const path of ["/health", "/control-plane", "/rooms/demo-room", "/api/templates", "/api/assets", "/api/tenants", "/api/internal/identity-policy"]) {
    assert.equal(legacyBoundaryApplies("GET", path), false, path);
  }
  for (const path of ["/api/tokens/state", "/api/tokens/media", "/api/tokens/remote-browser-frame", "/api/personal-room", "/api/rooms/x/notes", "/api/rooms/x/session-control", "/api/control-plane/session"]) {
    assert.equal(legacyBoundaryApplies("GET", path), true, path);
    assert.equal(legacyBoundaryApplies("POST", path), true, path);
  }
  for (const path of ["/api/tokens/state", "/api/tokens/media", "/api/tokens/remote-browser-media", "/api/personal-room"]) {
    assert.equal(legacyBoundaryAllowsAdministrator(path), false, "administrator metadata access cannot mint a legacy identity");
  }
  assert.equal(legacyBoundaryAllowsAdministrator("/api/rooms/x"), true);
});
