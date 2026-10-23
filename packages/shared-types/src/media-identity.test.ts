import assert from "node:assert/strict";
import test from "node:test";
import { createUserMediaIdentity, parseUserMediaBinding, userMediaScope, verifyUserMediaIdentity } from "./media-identity.js";

test("media addresses preserve source ceilings and every recovered participant ID without growing with ID length", async () => {
  const identities = new Set<string>();
  for (const participantId of ["same", "remote-browser:x", "a:b.c", "界".repeat(200), "😀".repeat(100), "x".repeat(200), "\ud800", "�"]) {
    for (const scope of ["m", "s", "ms"] as const) {
      const media = await createUserMediaIdentity("v2:namespace:room", { participantId, scope });
      assert.ok(media.identity.length < 80);
      assert.equal(identities.has(media.identity), false); identities.add(media.identity);
      assert.deepEqual(await verifyUserMediaIdentity("v2:namespace:room", media.identity, media.attributes), { participantId, scope });
      assert.deepEqual(await createUserMediaIdentity("v2:namespace:room", { participantId, scope }), media);
      assert.equal(await verifyUserMediaIdentity("v2:other:room", media.identity, media.attributes), null);
    }
  }
});

test("mapping rejects altered attributes, wrong source class and noncanonical or missing bindings", async () => {
  const media = await createUserMediaIdentity("room", { participantId: "original", scope: "s" });
  const other = await createUserMediaIdentity("room", { participantId: "replacement", scope: "s" });
  assert.equal(await verifyUserMediaIdentity("room", media.identity, other.attributes), null);
  const malformed: Array<Record<string, string>> = [{}, { ...media.attributes, vrataOther: "x" },
    { vrataMediaBinding: ` ${media.attributes.vrataMediaBinding}` },
    { vrataMediaBinding: media.attributes.vrataMediaBinding.replace('"s"', '"ms"') },
    { vrataMediaBinding: media.attributes.vrataMediaBinding.replace('"v":2', '"v":2,"v":2') }];
  for (const attributes of malformed) {
    assert.equal(parseUserMediaBinding(media.identity, attributes), null);
  }
  assert.equal(parseUserMediaBinding("remote-browser:x", media.attributes), null);
  assert.equal(parseUserMediaBinding(media.identity.toUpperCase(), media.attributes), null);
  assert.equal(parseUserMediaBinding(media.identity, { ...media.attributes, "lk.other": "value" })?.participantId, "original");
});

test("source classes are exact canonical complete grants", () => {
  assert.equal(userMediaScope(["microphone"]), "m");
  assert.equal(userMediaScope(["screen_share", "screen_share_audio"]), "s");
  assert.equal(userMediaScope(["microphone", "screen_share", "screen_share_audio"]), "ms");
  for (const sources of [[], ["camera"], ["screen_share"], ["microphone", "microphone"], ["screen_share_audio", "screen_share"]]) {
    assert.equal(userMediaScope(sources), null);
  }
});
