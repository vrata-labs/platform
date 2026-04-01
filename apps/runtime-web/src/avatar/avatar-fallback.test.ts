import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { resetAvatarSandbox } from "./avatar-fallback.js";
import type { AvatarRegistry } from "./avatar-registry.js";

test("resetAvatarSandbox clears registry and hides panel", () => {
  const root = new THREE.Group();
  const parent = new THREE.Group();
  parent.add(root);
  const registry = { root, instances: [], selectAvatar() {} } satisfies AvatarRegistry;
  const panelEl = { hidden: false } as HTMLDivElement;
  const statusEl = { textContent: "" } as HTMLDivElement;
  const presetSelectEl = {
    disabled: false,
    onchange: () => undefined,
    replaceChildren() {}
  } as unknown as HTMLSelectElement;

  const result = resetAvatarSandbox({
    previousRegistry: registry,
    elements: { panelEl, presetSelectEl, statusEl },
    sandboxEntryPoint: "/assets/avatars/catalog.v1.json"
  });

  assert.equal(result.registry, null);
  assert.equal(panelEl.hidden, true);
  assert.equal(root.parent, null);
  assert.equal(result.diagnostics.state, "idle");
});

test("resetAvatarSandbox reports fallback reason when provided", () => {
  const panelEl = { hidden: false } as HTMLDivElement;
  const statusEl = { textContent: "" } as HTMLDivElement;
  const presetSelectEl = {
    disabled: false,
    onchange: () => undefined,
    replaceChildren() {}
  } as unknown as HTMLSelectElement;

  const result = resetAvatarSandbox({
    previousRegistry: null,
    elements: { panelEl, presetSelectEl, statusEl },
    reason: "avatars_disabled",
    sandboxEntryPoint: "/assets/avatars/catalog.v1.json"
  });

  assert.equal(result.diagnostics.state, "failed");
  assert.equal(result.diagnostics.fallbackActive, true);
  assert.equal(result.diagnostics.fallbackReason, "avatars_disabled");
});
