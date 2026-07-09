import assert from "node:assert/strict";
import test from "node:test";

import {
  formatGuestCompatibilityWarnings,
  formatGuestControlsHint,
  shouldShowGuestOnboarding,
  validateGuestDisplayName
} from "./guest-onboarding.js";

test("guest onboarding policy gates invite guests without explicit identity", () => {
  assert.equal(shouldShowGuestOnboarding({
    hasInviteToken: true,
    hasExplicitDisplayName: false,
    forced: false,
    disabled: false,
    avatarSandboxEnabled: false,
    botMode: "off"
  }), true);
  assert.equal(shouldShowGuestOnboarding({
    hasInviteToken: true,
    hasExplicitDisplayName: true,
    forced: false,
    disabled: false,
    avatarSandboxEnabled: false,
    botMode: "off"
  }), false);
  assert.equal(shouldShowGuestOnboarding({
    hasInviteToken: false,
    hasExplicitDisplayName: false,
    forced: true,
    disabled: false,
    avatarSandboxEnabled: false,
    botMode: "off"
  }), true);
});

test("guest onboarding validates display names", () => {
  assert.deepEqual(validateGuestDisplayName(" A "), {
    accepted: false,
    displayName: "A",
    error: "Enter at least 2 characters."
  });
  assert.deepEqual(validateGuestDisplayName("  Ada   Lovelace  "), {
    accepted: true,
    displayName: "Ada Lovelace",
    error: null
  });
});

test("guest onboarding renders device-aware hints and warnings", () => {
  assert.match(formatGuestControlsHint("desktop"), /WASD/);
  assert.match(formatGuestControlsHint("mobile"), /left drag/);
  assert.match(formatGuestControlsHint("vr"), /left stick/);
  assert.deepEqual(formatGuestCompatibilityWarnings({
    webGlAvailable: true,
    webSocketAvailable: false,
    audioInputSupported: false,
    screenShareSupported: true
  }), [
    "Realtime connection unavailable: presence may be limited.",
    "Microphone unsupported: you can still enter without audio."
  ]);
});
