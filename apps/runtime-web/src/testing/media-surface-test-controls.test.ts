import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as THREE from "three";

import { createSurfaceInputDebugState, type ResolvedSurfaceHit } from "../input/surface-input.js";
import type { RuntimeMediaSurfaceView } from "../media/media-surface-view.js";
import { createMediaSurfaceTestControls, type MediaSurfaceTestControlsContext } from "./media-surface-test-controls.js";

function surface(surfaceId: string): RuntimeMediaSurfaceView {
  return {
    surfaceId, object: new THREE.Mesh(new THREE.PlaneGeometry(4, 2), new THREE.MeshBasicMaterial()),
    widthPx: 1000, heightPx: 500, widthM: 4, heightM: 2,
    visible: true, inputEnabled: true, maxDistanceM: 10,
    position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0,
    manifestPosition: null, manifestYaw: null, manifestFormat: "default"
  };
}

function fixture(t: TestContext) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const browser: { innerWidth: number; innerHeight: number; __VRATA_TEST__?: unknown } = { innerWidth: 800, innerHeight: 600 };
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const main = surface("main");
  const other = surface("other");
  const views = new Map([["main", main], ["other", other]]);
  const whiteboards = new Map<string, { texture: { image: unknown } }>();
  const markdownBoards = new Map<string, unknown>();
  const remoteBrowsers = new Map<string, unknown>();
  let selected = "main";
  let selectionReads = 0;
  let resolvedHit: ResolvedSurfaceHit | null = null;
  let accepted = false;
  const sample = { clip: { sx: 1, sy: 2, sw: 3, sh: 4 }, samples: [[1, 2, 3] as [number, number, number]] };
  const context: MediaSurfaceTestControlsContext = {
    debugSurfaceId: "main",
    get selectedMediaSurfaceId() { selectionReads += 1; return selected; },
    debugState: { surfaceInput: createSurfaceInputDebugState("main"), access: { permissions: ["surface.select"] } },
    camera: new THREE.PerspectiveCamera(90, 2, 0.1, 100),
    displaySurface: new THREE.Group(), mediaSurfaceViews: views, whiteboardRuntimes: whiteboards,
    markdownBoardRuntimes: markdownBoards, remoteBrowserRuntimes: remoteBrowsers,
    remoteBrowserVrKeyboardView: { toggleMesh: new THREE.Mesh(), meshById: new Map() },
    selectMediaSurface: function (this: unknown, id) { assert.equal(this, undefined); calls.push({ name: "select", args: [id] }); return accepted; },
    resolveDebugSurfaceHit: function (this: unknown, ...args) { assert.equal(this, undefined); calls.push({ name: "ray", args }); return resolvedHit; },
    activeMediaObjectIdForSurface: (id) => { calls.push({ name: "object", args: [id] }); return `object:${id}`; },
    isMediaSurfaceInputEnabled: (view) => { calls.push({ name: "enabled", args: [view] }); return view.inputEnabled; },
    commitDebugSurfaceInput: function (this: unknown, input) { assert.equal(this, undefined); calls.push({ name: "commit", args: [input] }); return accepted; },
    syncPhysicalMediaSurfaceDebugSnapshots: () => { calls.push({ name: "sync", args: [context.debugState.surfaceInput.enabled] }); },
    sampleMediaSurfaceTexture: function (this: unknown, ...args) { assert.equal(this, undefined); calls.push({ name: "sample", args }); return sample; }
  };
  const controls = createMediaSurfaceTestControls(context);
  return {
    controls, context, calls, main, other, views, whiteboards, markdownBoards, remoteBrowsers, browser, sample,
    select: (id: string) => { selected = id; }, selectionReads: () => selectionReads,
    accept: (value: boolean) => { accepted = value; }, resolve: (value: ResolvedSurfaceHit | null) => { resolvedHit = value; }
  };
}

function close(actual: { x: number; y: number; z?: number } | null, expected: { x: number; y: number; z?: number }): void {
  assert.ok(actual);
  for (const key of ["x", "y", "z"] as const) {
    if (expected[key] !== undefined) assert.ok(Math.abs(actual[key]! - expected[key]!) < 1e-10, `${key}: ${actual[key]} vs ${expected[key]}`);
  }
}

test("construction is inert and retains command names, arities and writable properties", (t) => {
  const f = fixture(t);
  assert.equal(f.selectionReads(), 0);
  assert.deepEqual(f.calls, []);
  const arities = {
    selectMediaSurface: 1, getMediaSurfaceRuntimePixelDimensions: 1, getMediaCanvasRuntimeKinds: 1,
    resolveMediaSurfaceRayHit: 2, sendDebugSurfaceInput: 0, setDebugSurfaceInputEnabled: 1, focusDebugSurface: 0,
    getDebugSurfaceWorldPosition: 2, getDebugSurfaceClientPosition: 2,
    getMediaSurfaceWorldPosition: 3, getMediaSurfaceClientPosition: 3,
    sampleDebugSurfaceTexture: 1, sampleMediaSurfaceTexture: 2,
    getRemoteBrowserVrKeyboardTargetWorldPosition: 1, getRemoteBrowserVrKeyboardKeyWorldPosition: 1
  };
  assert.deepEqual(Object.keys(f.controls), Object.keys(arities));
  for (const [name, arity] of Object.entries(arities)) {
    const descriptor = Object.getOwnPropertyDescriptor(f.controls, name)!;
    assert.equal(descriptor.value.name, name);
    assert.equal(descriptor.value.length, arity);
    assert.equal(descriptor.enumerable, true);
    assert.equal(descriptor.configurable, true);
    assert.equal(descriptor.writable, true);
  }
});

test("selection delegates with the original receiver and result, including an empty id", (t) => {
  const f = fixture(t);
  assert.equal(f.controls.selectMediaSurface(""), false);
  f.accept(true);
  assert.equal(f.controls.selectMediaSurface("other"), true);
  assert.deepEqual(f.calls.map((call) => call.args), [[""], ["other"]]);
});

test("pixel dimensions only require number-valued image fields and read the live map", (t) => {
  const f = fixture(t);
  for (const image of [undefined, null, {}, { width: 1 }, { width: "1", height: 2 }]) {
    f.whiteboards.set("main", { texture: { image } });
    assert.equal(f.controls.getMediaSurfaceRuntimePixelDimensions("main"), null);
  }
  f.whiteboards.set("main", { texture: { image: { width: 0, height: -2 } } });
  assert.deepEqual(f.controls.getMediaSurfaceRuntimePixelDimensions("main"), { width: 0, height: -2 });
  f.whiteboards.set("main", { texture: { image: { width: NaN, height: Infinity } } });
  assert.deepEqual(f.controls.getMediaSurfaceRuntimePixelDimensions("main"), { width: NaN, height: Infinity });
  f.whiteboards.delete("main");
  assert.equal(f.controls.getMediaSurfaceRuntimePixelDimensions("main"), null);
});

test("runtime kinds follow the fixed order without allocating runtimes", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.controls.getMediaCanvasRuntimeKinds("main"), []);
  f.remoteBrowsers.set("main", {});
  f.markdownBoards.set("main", {});
  f.whiteboards.set("main", { texture: { image: {} } });
  assert.deepEqual(f.controls.getMediaCanvasRuntimeKinds("main"), ["whiteboard", "markdown-board", "remote-browser"]);
  f.markdownBoards.delete("main");
  assert.deepEqual(f.controls.getMediaCanvasRuntimeKinds("main"), ["whiteboard", "remote-browser"]);
  assert.deepEqual(f.controls.getMediaCanvasRuntimeKinds("absent"), []);
});

for (const invalid of [NaN, Infinity, -Infinity]) {
  test(`ray lookup rejects every nonfinite component (${invalid}) before delegation`, (t) => {
    const f = fixture(t);
    for (let index = 0; index < 6; index += 1) {
      const values = [1, 2, 3, 4, 5, 6]; values[index] = invalid;
      assert.equal(f.controls.resolveMediaSurfaceRayHit({ x: values[0]!, y: values[1]!, z: values[2]! }, { x: values[3]!, y: values[4]!, z: values[5]! }), null);
    }
    assert.deepEqual(f.calls, []);
  });
}

test("ray lookup rejects zero and underflow-length directions", (t) => {
  const f = fixture(t);
  for (const value of [0, -0, Number.MIN_VALUE]) assert.equal(f.controls.resolveMediaSurfaceRayHit({ x: 1, y: 2, z: 3 }, { x: value, y: 0, z: 0 }), null);
  assert.deepEqual(f.calls, []);
});

test("ray lookup normalizes a copied direction and preserves zero or missing distance", (t) => {
  const f = fixture(t);
  const origin = { x: 1, y: 2, z: 3 }; const direction = { x: 0, y: 3, z: 4 };
  assert.equal(f.controls.resolveMediaSurfaceRayHit(origin, direction), null);
  const [ray, source] = f.calls[0]!.args as [THREE.Ray, string];
  assert.ok(ray instanceof THREE.Ray); close(ray.origin, origin); close(ray.direction, { x: 0, y: 0.6, z: 0.8 });
  assert.equal(source, "mouse"); assert.deepEqual(direction, { x: 0, y: 3, z: 4 });
  const hit: ResolvedSurfaceHit = { surfaceId: "other", source: "mouse", uv: { u: 0, v: 0 }, pixel: { x: 0, y: 0 }, inputEnabled: true };
  for (const distanceM of [undefined, 0, 4]) {
    f.resolve({ ...hit, distanceM });
    assert.deepEqual(f.controls.resolveMediaSurfaceRayHit(origin, direction), { surfaceId: "other", distanceM: distanceM ?? null });
  }
});

test("synthetic input defaults to the live selection and commits after lookup and clock read", (t) => {
  const f = fixture(t);
  t.mock.method(Date, "now", () => { f.calls.push({ name: "clock", args: [] }); return 1234; });
  f.select("other"); f.accept(true);
  assert.equal(f.controls.sendDebugSurfaceInput(), true);
  assert.equal(f.selectionReads(), 1);
  assert.deepEqual(f.calls.map((call) => call.name), ["object", "enabled", "clock", "commit"]);
  assert.deepEqual(f.calls.at(-1)!.args[0], {
    hit: { surfaceId: "other", objectId: "object:other", source: "mouse", uv: { u: 0.5, v: 0.5 }, pixel: { x: 500, y: 250 }, inputEnabled: true },
    source: "mouse", kind: "click", key: undefined, text: undefined, scrollDelta: undefined, clientTimeMs: 1234
  });
});

test("explicit input preserves empty values, zero coordinates and scroll object identity", (t) => {
  const f = fixture(t); const scrollDelta = { x: -1, y: 0 };
  t.mock.method(Date, "now", () => 0); f.main.inputEnabled = false;
  assert.equal(f.controls.sendDebugSurfaceInput({ surfaceId: "main", source: "touch", kind: "scroll", u: 0, v: 0, key: "", text: "", scrollDelta }), false);
  const input = f.calls.at(-1)!.args[0] as Parameters<MediaSurfaceTestControlsContext["commitDebugSurfaceInput"]>[0];
  assert.equal(f.selectionReads(), 0); assert.equal(input.scrollDelta, scrollDelta);
  assert.deepEqual(input, { hit: { surfaceId: "main", objectId: "object:main", source: "touch", uv: { u: 0, v: 0 }, pixel: { x: 0, y: 0 }, inputEnabled: false }, source: "touch", kind: "scroll", key: "", text: "", scrollDelta, clientTimeMs: 0 });
});

test("missing or explicitly empty input surfaces return false without fallback or clock reads", (t) => {
  const f = fixture(t); t.mock.method(Date, "now", () => { throw new Error("unexpected clock read"); });
  assert.equal(f.controls.sendDebugSurfaceInput({ surfaceId: "" }), false);
  f.select("absent"); assert.equal(f.controls.sendDebugSurfaceInput(), false);
  assert.deepEqual(f.calls, []);
});

test("input enable updates the current debug object before synchronizing", (t) => {
  const f = fixture(t); const previous = f.context.debugState.surfaceInput;
  f.context.debugState.surfaceInput = createSurfaceInputDebugState("other");
  assert.equal(f.controls.setDebugSurfaceInputEnabled(false), true);
  assert.equal(previous.enabled, true);
  assert.equal(f.context.debugState.surfaceInput.enabled, false);
  assert.deepEqual(f.calls, [{ name: "sync", args: [false] }]);
});

test("focus observes selection and replaced permissions, recording the hit before permission rejection", (t) => {
  const f = fixture(t); f.select("other"); f.context.debugState.access.permissions = [];
  assert.equal(f.controls.focusDebugSurface(), false);
  assert.equal(f.context.debugState.surfaceInput.lastHit?.surfaceId, "other");
  assert.equal(f.context.debugState.surfaceInput.blockedReason, "missing-permission:surface.select");
  f.context.debugState.access = { permissions: ["surface.select"] };
  assert.equal(f.controls.focusDebugSurface(), true);
  assert.equal(f.context.debugState.surfaceInput.focusedSurfaceId, "other");
  assert.equal(f.context.debugState.surfaceInput.blockedReason, null);
});

test("focus preserves explicit empty ids and missing-surface state without reading selection", (t) => {
  const f = fixture(t); const before = structuredClone(f.context.debugState.surfaceInput);
  assert.equal(f.controls.focusDebugSurface(""), false);
  assert.equal(f.selectionReads(), 0); assert.deepEqual(f.calls, []);
  assert.deepEqual(f.context.debugState.surfaceInput, before);
});

test("focus delegates existing semantics even when surface input is disabled", (t) => {
  const f = fixture(t); f.main.inputEnabled = false;
  assert.equal(f.controls.focusDebugSurface("main"), true);
  assert.equal((f.context.debugState.surfaceInput.lastHit as ResolvedSurfaceHit).inputEnabled, false);
});

for (const debug of [true, false]) {
  test(`${debug ? "debug" : "named"} world coordinates clamp UV and include updated transforms`, (t) => {
    const f = fixture(t); const view = debug ? f.main : f.other;
    view.object.position.set(3, 2, -5); view.object.rotation.z = Math.PI / 2; view.object.scale.set(2, 3, 1);
    const read = (u: number, v: number) => debug ? f.controls.getDebugSurfaceWorldPosition(u, v) : f.controls.getMediaSurfaceWorldPosition("other", u, v);
    close(read(2, -1), { x: 6, y: 6, z: -5 });
    view.object.position.x = 7;
    close(read(0.5, 0.5), { x: 7, y: 2, z: -5 });
    for (const invalid of [NaN, Infinity, -Infinity]) { assert.equal(read(invalid, 0.5), null); assert.equal(read(0.5, invalid), null); }
    f.views.delete(view.surfaceId); assert.equal(read(0.5, 0.5), null);
  });

  test(`${debug ? "debug" : "named"} client coordinates update surface then camera and read current viewport`, (t) => {
    const f = fixture(t); const view = debug ? f.main : f.other;
    view.object.position.z = -5;
    const order: string[] = [];
    const objectUpdate = view.object.updateMatrixWorld.bind(view.object);
    const cameraUpdate = f.context.camera.updateMatrixWorld.bind(f.context.camera);
    t.mock.method(view.object, "updateMatrixWorld", (force: boolean) => { assert.equal(force, true); order.push("surface"); objectUpdate(force); });
    t.mock.method(f.context.camera, "updateMatrixWorld", (force: boolean) => { assert.equal(force, true); order.push("camera"); cameraUpdate(force); });
    const read = (u: number, v: number) => debug ? f.controls.getDebugSurfaceClientPosition(u, v) : f.controls.getMediaSurfaceClientPosition("other", u, v);
    close(read(2, 2), { x: 480, y: 240 }); assert.deepEqual(order, ["surface", "camera"]);
    f.browser.innerWidth = 1600; f.browser.innerHeight = 1200;
    close(read(0, 0), { x: 640, y: 720 });
    f.context.camera.position.x = 2;
    close(read(1, 0.5), { x: 800, y: 600 });
    for (const invalid of [NaN, Infinity, -Infinity]) { assert.equal(read(invalid, 0.5), null); assert.equal(read(0.5, invalid), null); }
    f.views.delete(view.surfaceId); assert.equal(read(0.5, 0.5), null);
  });
}

test("debug coordinate lookup ignores selection and named lookup does not fall back", (t) => {
  const f = fixture(t); f.main.object.position.x = 2; f.other.object.position.x = 10; f.select("other");
  close(f.controls.getDebugSurfaceWorldPosition(0.5, 0.5), { x: 2, y: 0, z: 0 });
  assert.equal(f.controls.getMediaSurfaceWorldPosition("", 0.5, 0.5), null);
  assert.equal(f.controls.getMediaSurfaceClientPosition("", 0.5, 0.5), null);
  assert.equal(f.selectionReads(), 0);
});

test("texture sampling delegates unchanged references and allocates each default size separately", (t) => {
  const f = fixture(t); const center = { u: 0.1, v: 0.2 }; const size = { width: 0, height: -1 };
  assert.equal(f.controls.sampleDebugSurfaceTexture(center), f.sample);
  assert.equal(f.controls.sampleMediaSurfaceTexture("", center), f.sample);
  assert.equal(f.controls.sampleMediaSurfaceTexture("other", center, size), f.sample);
  assert.equal(f.calls[0]!.args[0], "main"); assert.equal(f.calls[1]!.args[0], "");
  assert.equal(f.calls[2]!.args[1], center); assert.equal(f.calls[2]!.args[2], size);
  assert.deepEqual(f.calls[0]!.args[2], { width: 0.18, height: 0.18 });
  assert.deepEqual(f.calls[1]!.args[2], f.calls[0]!.args[2]);
  assert.notEqual(f.calls[1]!.args[2], f.calls[0]!.args[2]);
});

test("keyboard target lookup updates the display and selected mesh in order", (t) => {
  const f = fixture(t); const keyboard = f.context.remoteBrowserVrKeyboardView;
  const key = new THREE.Mesh(); key.position.set(1, 2, 3);
  keyboard.toggleMesh.position.set(4, 5, 6); keyboard.meshById.set("key", key);
  const order: string[] = [];
  t.mock.method(f.context.displaySurface, "updateMatrixWorld", (force: boolean) => { assert.equal(force, true); order.push("display"); });
  const updateKey = key.updateMatrixWorld.bind(key);
  t.mock.method(key, "updateMatrixWorld", (force: boolean) => { assert.equal(force, true); order.push("key"); updateKey(force); });
  assert.equal(f.controls.getRemoteBrowserVrKeyboardTargetWorldPosition("missing"), null); assert.deepEqual(order, []);
  close(f.controls.getRemoteBrowserVrKeyboardTargetWorldPosition("key"), { x: 1, y: 2, z: 3 });
  assert.deepEqual(order, ["display", "key"]);
  close(f.controls.getRemoteBrowserVrKeyboardTargetWorldPosition("toggle"), { x: 4, y: 5, z: 6 });
  keyboard.meshById.delete("key"); assert.equal(f.controls.getRemoteBrowserVrKeyboardTargetWorldPosition("key"), null);
});

test("keyboard key helper looks up the live public API and preserves its receiver and returned object", (t) => {
  const f = fixture(t); const value = { x: 1, y: 2, z: 3 };
  assert.equal(f.controls.getRemoteBrowserVrKeyboardKeyWorldPosition("key"), null);
  const api = { getRemoteBrowserVrKeyboardTargetWorldPosition(this: unknown, id: string) { assert.equal(this, api); assert.equal(id, "key"); return value; } };
  f.browser.__VRATA_TEST__ = api;
  assert.equal(f.controls.getRemoteBrowserVrKeyboardKeyWorldPosition("key"), value);
  f.browser.__VRATA_TEST__ = { getRemoteBrowserVrKeyboardTargetWorldPosition: () => null };
  assert.equal(f.controls.getRemoteBrowserVrKeyboardKeyWorldPosition("key"), null);
});

for (const method of ["selectMediaSurface", "resolveDebugSurfaceHit", "commitDebugSurfaceInput", "syncPhysicalMediaSurfaceDebugSnapshots", "sampleMediaSurfaceTexture"] as const) {
  test(`${method} exceptions propagate without conversion or suppression`, (t) => {
    const f = fixture(t); const error = new Error(method);
    f.context[method] = () => { throw error; };
    const controls = createMediaSurfaceTestControls(f.context);
    const actions = {
      selectMediaSurface: () => controls.selectMediaSurface("main"),
      resolveDebugSurfaceHit: () => controls.resolveMediaSurfaceRayHit({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }),
      commitDebugSurfaceInput: () => controls.sendDebugSurfaceInput(),
      syncPhysicalMediaSurfaceDebugSnapshots: () => controls.setDebugSurfaceInputEnabled(false),
      sampleMediaSurfaceTexture: () => controls.sampleDebugSurfaceTexture({ u: 0.5, v: 0.5 })
    };
    assert.throws(actions[method], (actual) => actual === error);
    if (method === "syncPhysicalMediaSurfaceDebugSnapshots") assert.equal(f.context.debugState.surfaceInput.enabled, false);
  });
}
