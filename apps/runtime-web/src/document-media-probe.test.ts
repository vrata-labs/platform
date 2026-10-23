import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { probeDocumentMedia } from "./document-media-probe.js";

function harness(t: TestContext, options: { failure?: boolean; unsupported?: boolean; infiniteWebm?: boolean } = {}) {
  let urls = 0, revoked = 0; const playableTypes: string[] = [];
  class Media extends EventTarget {
    naturalWidth = 640; naturalHeight = 360; videoWidth = 640; videoHeight = 360;
    duration = options.infiniteWebm ? Infinity : 2; preload = "";
    canPlayType(type: string) { playableTypes.push(type); return options.unsupported ? "" : "probably"; }
    set src(_url: string) { queueMicrotask(() => this.dispatchEvent(new Event(options.failure ? "error" : this instanceof Image ? "load" : "loadedmetadata"))); }
    set currentTime(time: number) { if (time === Number.MAX_SAFE_INTEGER) { this.duration = 4; queueMicrotask(() => this.dispatchEvent(new Event("durationchange"))); } }
  }
  class Image extends Media {}
  const replacements = { Image, document: { createElement: () => new Media() }, window: { setTimeout, clearTimeout } };
  for (const [name, value] of Object.entries(replacements)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => { if (old) Object.defineProperty(globalThis, name, old); else Reflect.deleteProperty(globalThis, name); });
  }
  t.mock.method(URL, "createObjectURL", () => { urls++; return "blob:owned-document-probe"; });
  t.mock.method(URL, "revokeObjectURL", () => { revoked++; });
  return { urls: () => urls, revoked: () => revoked, playableTypes };
}

test("image probe handles an Android extension-only MIME and releases its temporary URL", async t => {
  const h = harness(t); assert.deepEqual(await probeDocumentMedia(new File(["image"], "image.PNG ")), { kind: "image", widthPx: 640, heightPx: 360 });
  assert.equal(h.urls(), 1); assert.equal(h.revoked(), 1);
});
test("video probe uses canonical inferred MIME and preserves WebM duration recovery", async t => {
  const h = harness(t, { infiniteWebm: true });
  assert.deepEqual(await probeDocumentMedia(new File(["video"], "meeting.webm", { type: "application/octet-stream" })), { kind: "video", widthPx: 640, heightPx: 360, durationMs: 4000 });
  assert.deepEqual(h.playableTypes, ["video/webm"]); assert.equal(h.revoked(), 1);
});
test("failed media decoding releases the URL without exposing underlying browser details", async t => {
  const h = harness(t, { failure: true });
  await assert.rejects(probeDocumentMedia(new File(["broken"], "image.png", { type: "image/png" })), { message: "media_decode_failed" });
  assert.equal(h.revoked(), 1);
});
test("unsupported video codecs release the URL and non-media files create none", async t => {
  const h = harness(t, { unsupported: true });
  assert.equal(await probeDocumentMedia(new File(["pdf"], "document.pdf")), null); assert.equal(h.urls(), 0);
  await assert.rejects(probeDocumentMedia(new File(["video"], "meeting.mp4")), { message: "unsupported_video_codec" });
  assert.equal(h.revoked(), 1);
});
