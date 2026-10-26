import { t, type MessageKey } from "./i18n/i18n.js";

export type GuestOnboardingMode = "desktop" | "mobile" | "vr";

export interface GuestOnboardingPolicyInput {
  hasInviteToken: boolean;
  hasExplicitDisplayName: boolean;
  forced: boolean;
  disabled: boolean;
  avatarSandboxEnabled: boolean;
  botMode: string;
}

export interface DisplayNameValidationResult {
  accepted: boolean;
  displayName: string;
  error: string | null;
}

export interface CompatibilityWarningInput {
  webGlAvailable: boolean;
  webSocketAvailable: boolean;
  audioInputSupported: boolean;
  screenShareSupported: boolean;
}

export function shouldShowGuestOnboarding(input: GuestOnboardingPolicyInput): boolean {
  if (input.disabled || input.avatarSandboxEnabled || input.botMode !== "off") {
    return false;
  }
  if (input.forced) {
    return true;
  }
  return input.hasInviteToken && !input.hasExplicitDisplayName;
}

export function validateGuestDisplayName(value: string): DisplayNameValidationResult {
  const displayName = value.trim().replace(/\s+/g, " ");
  if (displayName.length < 2) {
    return { accepted: false, displayName, error: t("onboarding.nameTooShort") };
  }
  if (displayName.length > 40) {
    return { accepted: false, displayName, error: t("onboarding.nameTooLong") };
  }
  return { accepted: true, displayName, error: null };
}

export function formatGuestControlsHint(mode: GuestOnboardingMode): string {
  if (mode === "mobile") {
    return t("onboarding.controlsMobile");
  }
  if (mode === "vr") {
    return t("onboarding.controlsVr");
  }
  return t("onboarding.controlsDesktop");
}

export function formatGuestCompatibilityWarnings(input: CompatibilityWarningInput): string[] {
  const warnings: string[] = [];
  if (!input.webGlAvailable) warnings.push(t("onboarding.warningWebGl"));
  if (!input.webSocketAvailable) warnings.push(t("onboarding.warningWebSocket"));
  if (!input.audioInputSupported) warnings.push(t("onboarding.warningMicrophone"));
  if (!input.screenShareSupported) warnings.push(t("onboarding.warningScreenShare"));
  return warnings;
}

export type MicrophoneCheckFailure = "blocked" | "missing" | "unavailable";

/** Why a microphone check failed: the browser or the user refused, there is no device, or capture does not work here. */
export function classifyMicrophoneCheckError(error: unknown): MicrophoneCheckFailure {
  const name = typeof (error as { name?: unknown } | null)?.name === "string" ? (error as { name: string }).name : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "blocked";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "missing";
  return "unavailable";
}

export function microphoneCheckFailureMessage(failure: MicrophoneCheckFailure): MessageKey {
  return failure === "blocked" ? "onboarding.microphoneBlocked" : failure === "missing" ? "onboarding.microphoneMissing" : "onboarding.microphoneDenied";
}
