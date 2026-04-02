import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { resetAvatarSession, startAvatarSandboxSession, startLocalAvatarSession } from "./avatar-session.js";

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

test("startLocalAvatarSession creates local avatar controller from procedural catalog", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("catalog.v1.json")) {
      return new Response(JSON.stringify({
        schemaVersion: 1,
        catalogId: "technical-v1",
        assetVersion: "v1",
        rig: "humanoid-v1",
        packUrl: "/assets/avatars/avatar-pack.v1.glb",
        packFormat: "procedural-debug-v1",
        presets: [{
          avatarId: "preset-01",
          label: "Preset 1",
          recipeId: "preset-01",
          validation: {
            triangleCount: 12000,
            materialCount: 1,
            textureCount: 1,
            morphTargets: ["blink"],
            animationClips: ["idle"],
            skeletonSignature: "humanoid-v1/base"
          }
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("avatar-recipes.v1.json")) {
      return new Response(JSON.stringify({
        schemaVersion: 1,
        recipes: [{
          schemaVersion: 1,
          avatarId: "preset-01",
          rig: "humanoid-v1",
          bodyVariant: "base",
          headVariant: "round",
          hairVariant: "short",
          outfitVariant: "hoodie",
          palette: { skin: "#f2d1b3", primary: "#355c7d", accent: "#f67280" },
          accessories: []
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const scene = new THREE.Scene();
    const result = await startLocalAvatarSession({
      catalogUrl: "https://example.com/assets/avatars/catalog.v1.json",
      renderer: {} as THREE.WebGLRenderer,
      scene
    });
    assert.equal(result.controller?.selectedAvatarId, "preset-01");
    assert.equal(result.diagnostics.state, "loaded");
    assert.equal(result.note, "local_avatar_ready");
    assert.equal(result.presetOptions.length, 1);
    assert.equal(result.presetOptions[0]?.avatarId, "preset-01");
    assert.equal(scene.children.includes(result.controller!.root), true);
    result.controller?.update({
      deltaSeconds: 0.25,
      inputMode: "desktop",
      xrPresenting: false,
      xrInputProfile: null,
      rootPosition: { x: 0, y: 0, z: 0 },
      yaw: 0,
      headPosition: { x: 0, y: 1.6, z: 0 },
      moveX: 0,
      moveZ: 1,
      turnRate: 0
    });
    assert.equal(result.controller?.diagnostics.animationState, "idle");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("startLocalAvatarSession returns failed note on broken catalog", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("missing", { status: 404 });

  try {
    const result = await startLocalAvatarSession({
      catalogUrl: "https://example.com/assets/avatars/catalog.v1.json",
      renderer: {} as THREE.WebGLRenderer,
      scene: new THREE.Scene()
    });
    assert.equal(result.controller, null);
    assert.equal(result.note, "local_avatar_failed");
    assert.equal(result.diagnostics.state, "failed");
    assert.deepEqual(result.presetOptions, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
