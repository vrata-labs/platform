import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as THREE from "three";
import { createMediaSurfaceView, DEFAULT_RUNTIME_MEDIA_SURFACES, type RuntimeMediaSurfaceView } from "./media-surface-view.js";
import { createMediaSurfaceTextureController, sampleTextureImage } from "./media-surface-textures.js";

function fixture(t: TestContext) {
  const mediaSurfaceViews = new Map<string, RuntimeMediaSurfaceView>();
  const retainedDisplayTextures = new Set<THREE.Texture>();
  const surfaces: RuntimeMediaSurfaceView[] = [];
  function add(id: string, texture: THREE.Texture | null = null) {
    const view = createMediaSurfaceView({ ...DEFAULT_RUNTIME_MEDIA_SURFACES[0]!, surfaceId: id });
    view.object.material.map = texture;
    mediaSurfaceViews.set(id, view);
    surfaces.push(view);
    return view;
  }
  t.after(() => {
    for (const view of surfaces) {
      view.object.geometry.dispose();
      const materials = Array.isArray(view.object.material) ? view.object.material : [view.object.material];
      for (const material of materials) material.dispose();
    }
  });
  const controller = createMediaSurfaceTextureController({ mediaSurfaceViews, retainedDisplayTextures });
  return { ...controller, add, mediaSurfaceViews, retainedDisplayTextures };
}

test("texture replacement disposes the old texture before changing the map and marks the material once", (t) => {
  const f = fixture(t);
  const old = new THREE.Texture();
  const next = new THREE.Texture();
  const surface = f.add("screen", old);
  const material = surface.object.material;
  material.color.setHex(0x123456);
  const version = material.version;
  const observations: unknown[] = [];
  old.addEventListener("dispose", () => observations.push([material.map, material.color.getHex(), material.version]));
  let nextDisposed = false;
  next.addEventListener("dispose", () => { nextDisposed = true; });
  f.applySurfaceTexture("screen", next);
  assert.deepEqual(observations, [[old, 0x123456, version]]);
  assert.equal(material.map, next);
  assert.equal(material.color.getHex(), 0xffffff);
  assert.equal(material.version, version + 1);
  assert.equal(nextDisposed, false);
});

test("reapplying the same texture only restores white and does not dispose or recompile", (t) => {
  const f = fixture(t);
  const texture = new THREE.Texture();
  const material = f.add("screen", texture).object.material;
  material.color.setHex(0x234567);
  let disposed = 0;
  texture.addEventListener("dispose", () => { disposed += 1; });
  const version = material.version;
  f.applySurfaceTexture("screen", texture);
  f.applySurfaceTexture("screen", texture);
  assert.equal(material.map, texture);
  assert.equal(material.color.getHex(), 0xffffff);
  assert.equal(material.version, version);
  assert.equal(disposed, 0);
});

test("applying null to an already empty material preserves its color and version", (t) => {
  const f = fixture(t);
  const material = f.add("screen").object.material;
  material.color.setHex(0x234567);
  const version = material.version;
  f.applySurfaceTexture("screen", null);
  assert.equal(material.map, null);
  assert.equal(material.color.getHex(), 0x234567);
  assert.equal(material.version, version);
});

test("clearing an unretained texture disposes it and restores white", (t) => {
  const f = fixture(t);
  const texture = new THREE.Texture();
  const material = f.add("screen", texture).object.material;
  material.color.setHex(0x234567);
  let disposed = 0;
  texture.addEventListener("dispose", () => { disposed += 1; });
  const version = material.version;
  f.applySurfaceTexture("screen", null);
  assert.equal(disposed, 1);
  assert.equal(material.map, null);
  assert.equal(material.color.getHex(), 0xffffff);
  assert.equal(material.version, version + 1);
});

test("retention changes after controller creation are observed without modifying the caller's set", (t) => {
  const f = fixture(t);
  const texture = new THREE.Texture();
  f.add("screen", texture);
  let disposed = 0;
  texture.addEventListener("dispose", () => { disposed += 1; });
  f.retainedDisplayTextures.add(texture);
  f.applySurfaceTexture("screen", null);
  assert.equal(disposed, 0);
  assert.deepEqual([...f.retainedDisplayTextures], [texture]);
  f.applySurfaceTexture("screen", texture);
  f.retainedDisplayTextures.delete(texture);
  f.applySurfaceTexture("screen", null);
  assert.equal(disposed, 1);
  assert.equal(f.retainedDisplayTextures.size, 0);
});

test("surface additions, replacements and removals are read from the original map", (t) => {
  const f = fixture(t);
  const texture = new THREE.Texture();
  const first = f.add("screen");
  f.applySurfaceTexture("screen", texture);
  const second = f.add("screen");
  f.applySurfaceTexture("screen", texture);
  assert.equal(first.object.material.map, texture);
  assert.equal(second.object.material.map, texture);
  f.mediaSurfaceViews.delete("screen");
  f.applySurfaceTexture("screen", null);
  assert.equal(second.object.material.map, texture);
  assert.equal(f.getSurfaceTextureDebugId("screen"), null);
});

test("missing surfaces, other material types and material arrays are ignored", (t) => {
  const f = fixture(t);
  const texture = new THREE.Texture();
  const surface = f.add("other");
  const original = surface.object.material;
  const other = new THREE.MeshStandardMaterial({ map: texture, color: 0x123456 });
  t.after(() => { original.dispose(); other.dispose(); });
  for (const material of [other, [original]]) {
    // Runtime guards deliberately handle values outside the view's static material type.
    Object.assign(surface.object, { material });
    f.applySurfaceTexture("other", null);
    assert.equal(f.getSurfaceTextureDebugId("other"), null);
    assert.equal(f.findSurfaceWithTexture(() => { assert.fail("unexpected predicate call"); }), null);
    f.clearSurfaceTextureWhere(() => { assert.fail("unexpected predicate call"); });
  }
  f.applySurfaceTexture("missing", texture);
  assert.equal(f.getSurfaceTextureDebugId("missing"), null);
  assert.equal(other.map, texture);
  assert.equal(other.color.getHex(), 0x123456);
});

test("dispose exceptions propagate before any replacement state is written", (t) => {
  const f = fixture(t);
  const old = new THREE.Texture();
  const material = f.add("screen", old).object.material;
  material.color.setHex(0x123456);
  const version = material.version;
  const error = new Error("dispose failed");
  old.addEventListener("dispose", () => { throw error; });
  assert.throws(() => f.applySurfaceTexture("screen", new THREE.Texture()), (actual) => actual === error);
  assert.equal(material.map, old);
  assert.equal(material.color.getHex(), 0x123456);
  assert.equal(material.version, version);
});

test("diagnostic IDs are lazy, stable across surfaces and monotonic across textures", (t) => {
  const f = fixture(t);
  f.add("empty");
  assert.equal(f.getSurfaceTextureDebugId("empty"), null);
  const first = new THREE.Texture();
  const second = new THREE.Texture();
  f.add("a", first);
  f.add("b", first);
  f.add("c", second);
  assert.equal(f.getSurfaceTextureDebugId("b"), 1);
  assert.equal(f.getSurfaceTextureDebugId("a"), 1);
  assert.equal(f.getSurfaceTextureDebugId("c"), 2);
  f.applySurfaceTexture("a", null);
  f.applySurfaceTexture("a", first);
  assert.equal(f.getSurfaceTextureDebugId("a"), 1);
});

test("independent controllers do not share diagnostic counters or texture IDs", (t) => {
  const first = fixture(t);
  const second = fixture(t);
  const shared = new THREE.Texture();
  first.add("a", new THREE.Texture());
  first.add("b", shared);
  second.add("b", shared);
  assert.equal(first.getSurfaceTextureDebugId("a"), 1);
  assert.equal(first.getSurfaceTextureDebugId("b"), 2);
  assert.equal(second.getSurfaceTextureDebugId("b"), 1);
});

test("find returns the first matching surface by map order, including null textures", (t) => {
  const f = fixture(t);
  const empty = f.add("empty");
  const texture = new THREE.Texture();
  const first = f.add("first", texture);
  f.add("second", texture);
  const visited: Array<THREE.Texture | null> = [];
  assert.equal(f.findSurfaceWithTexture((map) => { visited.push(map); return map === texture; }), first);
  assert.deepEqual(visited, [null, texture]);
  assert.equal(f.findSurfaceWithTexture((map) => map === null), empty);
  assert.equal(f.findSurfaceWithTexture(() => false), null);
});

test("clear visits all materials in map order and preserves retained textures", (t) => {
  const f = fixture(t);
  const first = new THREE.Texture();
  const retained = new THREE.Texture();
  const keep = new THREE.Texture();
  const a = f.add("a", first);
  const b = f.add("b", retained);
  const c = f.add("c", keep);
  f.retainedDisplayTextures.add(retained);
  const events: string[] = [];
  first.addEventListener("dispose", () => events.push("dispose:a"));
  retained.addEventListener("dispose", () => assert.fail("retained texture disposed"));
  f.clearSurfaceTextureWhere((map) => {
    events.push(map === first ? "visit:a" : map === retained ? "visit:b" : "visit:c");
    return map !== keep;
  });
  assert.deepEqual(events, ["visit:a", "dispose:a", "visit:b", "visit:c"]);
  assert.equal(a.object.material.map, null);
  assert.equal(b.object.material.map, null);
  assert.equal(c.object.material.map, keep);
});

test("find and clear preserve predicate exceptions", (t) => {
  const f = fixture(t);
  const material = f.add("a", new THREE.Texture()).object.material;
  const old = material.map;
  const error = new Error("predicate failed");
  const predicate = (): boolean => { throw error; };
  assert.throws(() => f.findSurfaceWithTexture(predicate), (actual) => actual === error);
  assert.throws(() => f.clearSurfaceTextureWhere(predicate), (actual) => actual === error);
  assert.equal(material.map, old);
});

function imageEnvironment(t: TestContext) {
  class CanvasImage { constructor(public width = 32, public height = 16) {} }
  class VideoImage { videoWidth = 32; videoHeight = 16; width = 999; height = 999; }
  class StaticImage { naturalWidth = 32; naturalHeight = 16; width = 99; height = 88; }
  class BitmapImage { width = 32; height = 16; }
  const clips: number[][] = [];
  const draws: unknown[][] = [];
  const reads: unknown[][] = [];
  const state = { noContext: false, drawError: null as Error | null, readError: null as Error | null, shortData: false };
  const canvases: Array<{ width: number; height: number }> = [];
  const context = {
    drawImage(...args: unknown[]) {
      if (state.drawError) throw state.drawError;
      draws.push(args);
    },
    getImageData(sx: number, sy: number, sw: number, sh: number) {
      if (state.readError) throw state.readError;
      clips.push([sx, sy, sw, sh]);
      const data = new Uint8ClampedArray(state.shortData ? 2 : sw * sh * 4);
      for (let y = 0; y < sh; y += 1) {
        for (let x = 0; x < sw; x += 1) {
          const offset = (y * sw + x) * 4;
          data[offset] = x;
          data[offset + 1] = y;
          data[offset + 2] = 42;
          data[offset + 3] = 255;
        }
      }
      return { data };
    }
  };
  const globals: Record<string, unknown> = {
    HTMLCanvasElement: CanvasImage, HTMLVideoElement: VideoImage,
    HTMLImageElement: StaticImage, ImageBitmap: BitmapImage,
    document: {
      createElement(name: string) {
        assert.equal(name, "canvas");
        const canvas = {
          width: 0, height: 0,
          getContext(...args: unknown[]) { reads.push(args); return state.noContext ? null : context; }
        };
        canvases.push(canvas);
        return canvas;
      }
    }
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  return { CanvasImage, VideoImage, StaticImage, BitmapImage, clips, draws, reads, canvases, state };
}

const center = { u: 0.5, v: 0.5 };
const fullSize = { width: 1, height: 1 };

for (const kind of ["CanvasImage", "VideoImage", "StaticImage", "BitmapImage"] as const) {
  test(`sampling ${kind} preserves native dimensions, pixel ordering and RGB output`, (t) => {
    const env = imageEnvironment(t);
    const image = new env[kind]();
    const result = sampleTextureImage(image, center, fullSize);
    assert.ok(result);
    assert.deepEqual(result.clip, { sx: 0, sy: 0, sw: 32, sh: 16 });
    assert.deepEqual(result.samples, Array.from({ length: 128 }, (_, i) => [2 * (i % 16) + 1, 2 * Math.floor(i / 16) + 1, 42]));
    assert.deepEqual(env.draws, [[image, 0, 0, 32, 16]]);
    assert.deepEqual(env.reads, [["2d", { willReadFrequently: true }]]);
    assert.equal(env.canvases[0]!.width, 32);
    assert.equal(env.canvases[0]!.height, 16);
  });
}

test("static image dimensions independently fall back when natural dimensions are zero", (t) => {
  const env = imageEnvironment(t);
  const image = new env.StaticImage();
  image.naturalWidth = 0;
  image.naturalHeight = 0;
  assert.deepEqual(sampleTextureImage(image, center, fullSize)?.clip, { sx: 0, sy: 0, sw: 99, sh: 88 });
  image.naturalHeight = 16;
  assert.deepEqual(sampleTextureImage(image, center, fullSize)?.clip, { sx: 0, sy: 0, sw: 99, sh: 16 });
});

test("sampling rejects unsupported sources even when ImageBitmap is unavailable", (t) => {
  const env = imageEnvironment(t);
  Reflect.deleteProperty(globalThis, "ImageBitmap");
  for (const image of [null, undefined, {}, { width: 32, height: 16 }]) {
    assert.equal(sampleTextureImage(image, center, fullSize), null);
  }
  assert.equal(env.canvases.length, 0);
  assert.ok(sampleTextureImage(new env.CanvasImage(), center, fullSize));
});

test("sampling zero or negative source dimensions does not allocate a scratch canvas", (t) => {
  const env = imageEnvironment(t);
  for (const [width, height] of [[0, 16], [32, 0], [-1, 16], [32, -1]]) {
    assert.equal(sampleTextureImage(new env.CanvasImage(width, height), center, fullSize), null);
  }
  const video = new env.VideoImage();
  video.videoWidth = 0;
  assert.equal(sampleTextureImage(video, center, fullSize), null);
  assert.equal(env.canvases.length, 0);
});

test("sampling flips vertical UV, clamps edges and floors fractional clip dimensions", (t) => {
  const env = imageEnvironment(t);
  const image = new env.CanvasImage(100, 80);
  const size = Object.freeze({ width: 0.219, height: 0.26 });
  const point = Object.freeze({ u: 0.5, v: 0.75 });
  assert.deepEqual(sampleTextureImage(image, point, size)?.clip, { sx: 39, sy: 10, sw: 21, sh: 20 });
  assert.deepEqual(sampleTextureImage(image, { u: -2, v: 3 }, size)?.clip, { sx: 0, sy: 0, sw: 21, sh: 20 });
  assert.deepEqual(sampleTextureImage(image, { u: 3, v: -2 }, size)?.clip, { sx: 79, sy: 60, sw: 21, sh: 20 });
});

test("sampling bounds requested clip sizes and repeats samples for a single pixel", (t) => {
  const env = imageEnvironment(t);
  const image = new env.CanvasImage(100, 80);
  assert.deepEqual(sampleTextureImage(image, center, { width: 2, height: 4 })?.clip, { sx: 0, sy: 0, sw: 100, sh: 80 });
  const result = sampleTextureImage(image, center, { width: -1, height: 0 });
  assert.deepEqual(result?.clip, { sx: 49, sy: 39, sw: 1, sh: 1 });
  assert.deepEqual(result?.samples, Array.from({ length: 128 }, () => [0, 0, 42]));
});

test("sampling allocates fresh canvases and results for each call", (t) => {
  const env = imageEnvironment(t);
  const image = new env.CanvasImage();
  const first = sampleTextureImage(image, center, fullSize);
  const second = sampleTextureImage(image, center, fullSize);
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.notEqual(first?.samples, second?.samples);
  assert.equal(env.canvases.length, 2);
  assert.notEqual(env.canvases[0], env.canvases[1]);
});

test("missing canvas contexts and drawing errors return null without reading pixels", (t) => {
  const env = imageEnvironment(t);
  const image = new env.CanvasImage();
  env.state.noContext = true;
  assert.equal(sampleTextureImage(image, center, fullSize), null);
  env.state.noContext = false;
  env.state.drawError = new Error("draw failed");
  assert.equal(sampleTextureImage(image, center, fullSize), null);
  assert.equal(env.clips.length, 0);
});

test("pixel read errors still propagate instead of being silently swallowed", (t) => {
  const env = imageEnvironment(t);
  const error = new Error("tainted canvas");
  env.state.readError = error;
  assert.throws(() => sampleTextureImage(new env.CanvasImage(), center, fullSize), (actual) => actual === error);
});

test("missing pixel channels default to zero", (t) => {
  const env = imageEnvironment(t);
  env.state.shortData = true;
  const result = sampleTextureImage(new env.CanvasImage(1, 1), center, fullSize);
  assert.deepEqual(result?.samples, Array.from({ length: 128 }, () => [0, 0, 0]));
});

test("surface sampling observes texture replacement and missing surfaces", (t) => {
  const env = imageEnvironment(t);
  const f = fixture(t);
  const material = f.add("screen").object.material;
  assert.equal(f.sampleMediaSurfaceTexture("screen", center, fullSize), null);
  assert.equal(f.sampleMediaSurfaceTexture("missing", center, fullSize), null);
  material.map = new THREE.Texture(new env.CanvasImage() as unknown as HTMLCanvasElement);
  assert.deepEqual(f.sampleMediaSurfaceTexture("screen", center, fullSize)?.clip, { sx: 0, sy: 0, sw: 32, sh: 16 });
  material.map = new THREE.Texture(new env.CanvasImage(16, 8) as unknown as HTMLCanvasElement);
  assert.deepEqual(f.sampleMediaSurfaceTexture("screen", center, fullSize)?.clip, { sx: 0, sy: 0, sw: 16, sh: 8 });
});
