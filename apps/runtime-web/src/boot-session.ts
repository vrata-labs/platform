import * as THREE from "three";

import type { RuntimeBootResult } from "./index.js";
import type { SceneBundleAttribution } from "./scene-bundle.js";

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

export function renderSceneAttributions(input: {
  panelEl: HTMLDivElement;
  listEl: HTMLUListElement;
  attributions?: SceneBundleAttribution[];
}): void {
  input.listEl.replaceChildren();
  if (!input.attributions || input.attributions.length === 0) {
    input.panelEl.hidden = true;
    return;
  }

  input.panelEl.hidden = false;
  input.listEl.replaceChildren(...input.attributions.map((attribution) => {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = attribution.title;
    item.append(title, " by ");
    item.append(createAttributionLink(attribution.author, attribution.authorUrl));
    item.append(", ", createAttributionLink(attribution.license, attribution.licenseUrl), ". ");
    item.append(createAttributionLink("Source", attribution.source));

    if (attribution.changes) {
      const changes = document.createElement("div");
      changes.className = "attribution-changes";
      changes.textContent = `Changes: ${attribution.changes}`;
      item.append(changes);
    }

    return item;
  }));
}

function createAttributionLink(label: string, href?: string): HTMLElement | Text {
  if (!href || !isSafeAttributionHref(href)) {
    return document.createTextNode(label);
  }
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = label;
  return link;
}

function isSafeAttributionHref(href: string): boolean {
  try {
    const parsed = new URL(href);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
