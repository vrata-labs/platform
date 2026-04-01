import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { bootAvatarSandbox } from "./avatar-sandbox.js";

test("bootAvatarSandbox returns fallback diagnostics when catalog load fails", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  globalThis.fetch = async () => new Response("missing", { status: 404 });
  globalThis.document = {
    createElement() {
      return {
        value: "",
        textContent: "",
        selected: false
      };
    }
  } as unknown as Document;

  const panelEl = { hidden: true } as HTMLDivElement;
  const statusEl = { textContent: "" } as HTMLDivElement;
  const presetSelectEl = {
    disabled: false,
    value: "",
    onchange: null,
    replaceChildren() {},
    appendChild() {}
  } as unknown as HTMLSelectElement;

  try {
    const result = await bootAvatarSandbox({
      catalogUrl: "https://example.com/assets/avatars/catalog.v1.json",
      renderer: {} as THREE.WebGLRenderer,
      scene: new THREE.Scene(),
      player: new THREE.Group(),
      previousRegistry: null,
      elements: {
        panelEl,
        presetSelectEl,
        statusEl
      }
    });

    assert.equal(result.registry, null);
    assert.equal(result.diagnostics.fallbackActive, true);
    assert.match(result.diagnostics.fallbackReason ?? "", /failed_to_load_avatar_catalog:404/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
  }
});
