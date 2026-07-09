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
    return { accepted: false, displayName, error: "Enter at least 2 characters." };
  }
  if (displayName.length > 40) {
    return { accepted: false, displayName, error: "Use 40 characters or fewer." };
  }
  return { accepted: true, displayName, error: null };
}

export function formatGuestControlsHint(mode: GuestOnboardingMode): string {
  if (mode === "mobile") {
    return "Controls: left drag moves, right drag looks around, tap the panel title to hide controls.";
  }
  if (mode === "vr") {
    return "Controls: left stick moves, right stick snap-turns, controller ray selects seats and panels.";
  }
  return "Controls: WASD or arrows move, Shift sprints, drag the scene to look around.";
}

export function formatGuestCompatibilityWarnings(input: CompatibilityWarningInput): string[] {
  const warnings: string[] = [];
  if (!input.webGlAvailable) warnings.push("WebGL unavailable: the room may not render on this browser.");
  if (!input.webSocketAvailable) warnings.push("Realtime connection unavailable: presence may be limited.");
  if (!input.audioInputSupported) warnings.push("Microphone unsupported: you can still enter without audio.");
  if (!input.screenShareSupported) warnings.push("Screen share unsupported on this device.");
  return warnings;
}
