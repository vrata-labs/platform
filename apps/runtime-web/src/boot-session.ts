import * as THREE from "three";

import type { RuntimeBootResult } from "./index.js";

export interface RoomShellElements {
  roomNameEl: HTMLDivElement;
  brandingLineEl: HTMLDivElement;
  guestAccessLineEl: HTMLDivElement;
}

export function applyRoomShellBootState(input: {
  boot: RuntimeBootResult;
  elements: RoomShellElements;
  floorMaterial: THREE.MeshBasicMaterial | THREE.MeshStandardMaterial;
  wallMaterial: THREE.MeshBasicMaterial | THREE.MeshStandardMaterial;
  setRoomStateStatus(message: string): void;
}): void {
  input.setRoomStateStatus("Room-state: connecting");
  input.elements.roomNameEl.textContent = `${input.boot.template} - ${input.boot.roomId}`;
  input.elements.brandingLineEl.textContent = input.boot.assets.length > 0
    ? `Attached assets: ${input.boot.assets.map((asset) => `${asset.kind}${asset.validationStatus ? ` [${asset.validationStatus}]` : ""}`).join(", ")}`
    : "No branded assets attached";
  input.elements.guestAccessLineEl.textContent = input.boot.guestAllowed
    ? "Guest access: enabled"
    : "Guest access: members only";
  input.floorMaterial.color.set(input.boot.theme.accentColor);
  input.wallMaterial.color.set(input.boot.theme.primaryColor);
}

export function appendBrandingSuffix(brandingLineEl: HTMLDivElement, suffix: string | null): void {
  if (!suffix) {
    return;
  }
  brandingLineEl.textContent = `${brandingLineEl.textContent} | ${suffix}`;
}
