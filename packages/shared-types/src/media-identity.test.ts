import assert from "node:assert/strict";
import test from "node:test";
import { createUserMediaIdentity, parseUserMediaBinding, userMediaCodec, userMediaScope, verifyUserMediaIdentity } from "./media-identity.js";

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

test("codec 3 separates every authorization epoch of the same participant and never aliases codec 2", async () => {
  const room = "v3:namespace:incarnation:room";
  const legacy = await createUserMediaIdentity(room, { participantId: "same", scope: "ms" });
  const first = await createUserMediaIdentity(room, { participantId: "same", scope: "ms", epoch: 1 });
  const recovered = await createUserMediaIdentity(room, { participantId: "same", scope: "ms", epoch: 2 });
  assert.match(legacy.identity, /^vmi2\.ms\./);
  assert.match(first.identity, /^vmi3\.ms\.[a-f0-9]{64}$/);
  assert.equal(new Set([legacy.identity, first.identity, recovered.identity]).size, 3);
  assert.equal(first.attributes.vrataMediaBinding, '{"v":3,"participantId":"same","scope":"ms","epoch":1}');
  assert.deepEqual(await verifyUserMediaIdentity(room, first.identity, first.attributes), { participantId: "same", scope: "ms", epoch: 1 });
  assert.deepEqual(await verifyUserMediaIdentity(room, recovered.identity, recovered.attributes), { participantId: "same", scope: "ms", epoch: 2 });
  assert.equal(await verifyUserMediaIdentity("v3:namespace:other:room", first.identity, first.attributes), null);
  // An epoch cannot be moved onto another address, nor dropped to reuse the codec-2 address.
  assert.equal(await verifyUserMediaIdentity(room, first.identity, recovered.attributes), null);
  assert.equal(await verifyUserMediaIdentity(room, recovered.identity, first.attributes), null);
  assert.equal(await verifyUserMediaIdentity(room, legacy.identity, first.attributes), null);
  assert.equal(await verifyUserMediaIdentity(room, first.identity, legacy.attributes), null);
  assert.equal(userMediaCodec({}), 2); assert.equal(userMediaCodec({ epoch: 7 }), 3);
});

test("codec 3 bindings require one canonical bounded epoch", async () => {
  for (const epoch of [0, -1, 1.5, 2_147_483_648, Number.NaN]) {
    await assert.rejects(createUserMediaIdentity("room", { participantId: "p", scope: "m", epoch }), /invalid_user_media_binding/);
  }
  const media = await createUserMediaIdentity("room", { participantId: "p", scope: "m", epoch: 2_147_483_647 });
  const binding = media.attributes.vrataMediaBinding;
  for (const value of [binding.replace(',"epoch":2147483647', ""), binding.replace("2147483647", '"2147483647"'),
    binding.replace("2147483647", "2147483647.0"), binding.replace('"v":3', '"v":2'), binding.replace("2147483647", "1,\"epoch\":2147483647")]) {
    assert.equal(parseUserMediaBinding(media.identity, { vrataMediaBinding: value }), null);
  }
  assert.equal(parseUserMediaBinding(media.identity.replace("vmi3.", "vmi2."), media.attributes), null);
  assert.equal(parseUserMediaBinding(media.identity.replace("vmi3.", "vmi4."), media.attributes), null);
});

test("source classes are exact canonical complete grants", () => {
  assert.equal(userMediaScope(["microphone"]), "m");
  assert.equal(userMediaScope(["screen_share", "screen_share_audio"]), "s");
  assert.equal(userMediaScope(["microphone", "screen_share", "screen_share_audio"]), "ms");
  for (const sources of [[], ["camera"], ["screen_share"], ["microphone", "microphone"], ["screen_share_audio", "screen_share"]]) {
    assert.equal(userMediaScope(sources), null);
  }
});
