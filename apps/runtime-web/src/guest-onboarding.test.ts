import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyMicrophoneCheckError,
  formatGuestCompatibilityWarnings,
  formatGuestControlsHint,
  microphoneCheckFailureMessage,
  shouldShowGuestOnboarding,
  validateGuestDisplayName
} from "./guest-onboarding.js";
import { setLocale } from "./i18n/i18n.js";

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

test("a failed microphone check tells a refusal from a missing device and from capture that does not work here", () => {
  assert.equal(classifyMicrophoneCheckError(new DOMException("denied", "NotAllowedError")), "blocked");
  assert.equal(classifyMicrophoneCheckError({ name: "SecurityError" }), "blocked");
  assert.equal(classifyMicrophoneCheckError(new DOMException("none", "NotFoundError")), "missing");
  assert.equal(classifyMicrophoneCheckError({ name: "OverconstrainedError" }), "missing");
  assert.equal(classifyMicrophoneCheckError(new DOMException("x", "NotSupportedError")), "unavailable");
  assert.equal(classifyMicrophoneCheckError(null), "unavailable");
  assert.equal(classifyMicrophoneCheckError("text"), "unavailable");
  assert.deepEqual(["blocked", "missing", "unavailable"].map((failure) => microphoneCheckFailureMessage(failure as "blocked")),
    ["onboarding.microphoneBlocked", "onboarding.microphoneMissing", "onboarding.microphoneDenied"]);
});

test("preflight texts follow the UI language", () => {
  setLocale("ru");
  try {
    assert.equal(validateGuestDisplayName("a").error, "Введите хотя бы 2 символа.");
    assert.match(formatGuestControlsHint("vr"), /левый стик/);
    assert.deepEqual(formatGuestCompatibilityWarnings({ webGlAvailable: true, webSocketAvailable: true, audioInputSupported: false, screenShareSupported: true }),
      ["Микрофон не поддерживается: можно войти без звука."]);
  } finally {
    setLocale("en");
  }
});
