import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { resetAvatarSession, startAvatarSandboxSession } from "./avatar-session.js";

test("resetAvatarSession returns idle diagnostics with sandbox entry point", () => {
  const panelEl = { hidden: false } as HTMLDivElement;
  const statusEl = { textContent: "" } as HTMLDivElement;
  const presetSelectEl = {
    disabled: false,
    onchange: () => undefined,
    replaceChildren() {}
  } as unknown as HTMLSelectElement;

  const result = resetAvatarSession({
    previousRegistry: null,
    elements: { panelEl, presetSelectEl, statusEl },
    sandboxEntryPoint: "/assets/avatars/catalog.v1.json"
  });

  assert.equal(result.registry, null);
  assert.equal(result.diagnostics.state, "idle");
  assert.equal(result.diagnostics.sandboxEntryPoint, "/assets/avatars/catalog.v1.json");
});

test("startAvatarSandboxSession reports failure note on broken catalog", async () => {
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
    onchange: null,
    replaceChildren() {},
    appendChild() {}
  } as unknown as HTMLSelectElement;

  try {
    const result = await startAvatarSandboxSession({
      catalogUrl: "https://example.com/assets/avatars/catalog.v1.json",
      renderer: {} as THREE.WebGLRenderer,
      scene: new THREE.Scene(),
      player: new THREE.Group(),
      previousRegistry: null,
      elements: { panelEl, presetSelectEl, statusEl }
    });
    assert.equal(result.note, "avatar_sandbox_failed");
    assert.equal(result.diagnostics.state, "failed");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
  }
});
