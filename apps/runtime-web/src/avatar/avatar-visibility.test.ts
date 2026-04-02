import test from "node:test";
import assert from "node:assert/strict";

import { resolveAvatarViewProfile, resolveSelfAvatarVisibility } from "./avatar-visibility.js";

test("resolveSelfAvatarVisibility hides body in vr", () => {
  assert.equal(resolveSelfAvatarVisibility({ inputMode: "vr-controller", xrPresenting: true }), "hands-only");
});

test("resolveSelfAvatarVisibility keeps full body on desktop", () => {
  assert.equal(resolveSelfAvatarVisibility({ inputMode: "desktop", xrPresenting: false }), "full-body");
});

test("resolveSelfAvatarVisibility keeps upper body on mobile", () => {
  assert.equal(resolveSelfAvatarVisibility({ inputMode: "mobile", xrPresenting: false }), "upper-body");
});

test("resolveSelfAvatarVisibility returns hidden during fallback", () => {
  assert.equal(resolveSelfAvatarVisibility({ inputMode: "mobile", xrPresenting: false, fallbackActive: true }), "hidden");
});

test("resolveAvatarViewProfile returns mobile pose profile", () => {
  const profile = resolveAvatarViewProfile({ inputMode: "mobile", xrPresenting: false });
  assert.equal(profile.visibility, "upper-body");
  assert.equal(profile.poseProfile.handHeight, 1.02);
});
