import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultRoomMediaObjectsState } from "./media-objects.js";
import { parseSceneMediaSurfaceDefinitions, registerSceneMediaSurfaces } from "./scene-media-surfaces.js";

test("legacy and F3 surface identities normalize, duplicates and unsafe IDs fail atomically", () => {
  assert.deepEqual(parseSceneMediaSurfaceDefinitions([{ id: "workspace-main", allowedObjectTypes: ["markdown-board"] }]), [{ surfaceId: "workspace-main", label: "workspace-main", allowedObjectTypes: ["markdown-board"] }]);
  for (const value of [[{ surfaceId: "__proto__" }], [{ surfaceId: "constructor" }], [{ id: "same" }, { surfaceId: "same" }], [{ surfaceId: "x", allowedObjectTypes: [42] }], Array.from({ length: 17 }, (_, i) => ({ id: `surface-${i}` }))]) {
    assert.throws(() => parseSceneMediaSurfaceDefinitions(value));
  }
});

test("registering scene surfaces preserves existing shared state and isolates definition arrays", () => {
  const state = createDefaultRoomMediaObjectsState("room");
  state.surfaces["debug-main"]!.activeObjectId = "active-object";
  const definitions = [{ surfaceId: "workspace-main", label: "Desk", allowedObjectTypes: ["markdown-board"] }];
  const configured = registerSceneMediaSurfaces(state, "room", definitions);
  assert.equal(configured.surfaces["debug-main"]!.activeObjectId, "active-object");
  assert.equal(configured.surfaces["workspace-main"]!.roomId, "room");
  assert.equal(configured.surfaces["workspace-main"]!.activeObjectId, null);
  assert.equal(state.surfaces["workspace-main"], undefined);
  definitions[0]!.allowedObjectTypes.push("video-player");
  assert.deepEqual(configured.surfaces["workspace-main"]!.allowedObjectTypes, ["markdown-board"]);
  configured.surfaces["workspace-main"]!.activeObjectId = "board";
  assert.equal(registerSceneMediaSurfaces(configured, "room", definitions).surfaces["workspace-main"]!.activeObjectId, "board");
});
