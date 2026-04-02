import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { appendBrandingSuffix, applyRoomShellBootState } from "./boot-session.js";

test("applyRoomShellBootState populates room shell labels and theme", () => {
  const roomNameEl = { textContent: "" } as HTMLDivElement;
  const brandingLineEl = { textContent: "" } as HTMLDivElement;
  const guestAccessLineEl = { textContent: "" } as HTMLDivElement;
  const floorMaterial = new THREE.MeshStandardMaterial({ color: "#000000" });
  const wallMaterial = new THREE.MeshStandardMaterial({ color: "#000000" });
  let roomStateStatus = "";

  applyRoomShellBootState({
    boot: {
      roomId: "demo-room",
      template: "meeting-room-basic",
      assets: [{ assetId: "a1", kind: "logo", url: "/logo.glb", validationStatus: "validated" }],
      guestAllowed: true,
      theme: { primaryColor: "#163354", accentColor: "#5fc8ff" }
    } as never,
    elements: { roomNameEl, brandingLineEl, guestAccessLineEl },
    floorMaterial,
    wallMaterial,
    setRoomStateStatus(message) {
      roomStateStatus = message;
    }
  });

  assert.equal(roomStateStatus, "Room-state: connecting");
  assert.equal(roomNameEl.textContent, "meeting-room-basic - demo-room");
  assert.match(brandingLineEl.textContent ?? "", /logo \[validated\]/);
  assert.equal(guestAccessLineEl.textContent, "Guest access: enabled");
  assert.equal(floorMaterial.color.getHexString(), "5fc8ff");
  assert.equal(wallMaterial.color.getHexString(), "163354");
});

test("appendBrandingSuffix appends scene note only when present", () => {
  const brandingLineEl = { textContent: "No branded assets attached" } as HTMLDivElement;
  appendBrandingSuffix(brandingLineEl, null);
  assert.equal(brandingLineEl.textContent, "No branded assets attached");
  appendBrandingSuffix(brandingLineEl, "Scene: Hall");
  assert.equal(brandingLineEl.textContent, "No branded assets attached | Scene: Hall");
});
