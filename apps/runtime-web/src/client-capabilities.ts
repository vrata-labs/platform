import type { BrowserMediaCapabilities } from "./media-capabilities.js";
import type { XrSupport } from "./xr.js";

export type ClientJoinMode = "desktop" | "mobile" | "vr";

export type ClientCompatibilityWarningCode =
  | "webgl_unavailable"
  | "websocket_unavailable"
  | "touch_controls_unavailable"
  | "audio_input_unavailable"
  | "screen_share_unavailable"
  | "xr_unavailable";

export type ClientCompatibilityDegradedMode =
  | "none"
  | "webgl_unavailable"
  | "realtime_limited"
  | "touch_limited"
  | "media_limited"
  | "xr_disabled";

export interface ClientCompatibilitySummary {
  resolvedJoinMode: ClientJoinMode;
  modeSource: "user_agent" | "xr_mock" | "xr_session";
  entryBlocked: boolean;
  degradedMode: ClientCompatibilityDegradedMode;
  warnings: ClientCompatibilityWarningCode[];
  webgl: {
    supported: boolean;
  };
  websocket: {
    supported: boolean;
  };
  touchControls: {
    supported: boolean;
    required: boolean;
  };
  media: BrowserMediaCapabilities;
  xr: XrSupport & {
    enterVrVisible: boolean;
    mocked: boolean;
  };
}

export function resolveClientCompatibility(input: {
  resolvedJoinMode: ClientJoinMode;
  media: BrowserMediaCapabilities;
  xr: XrSupport;
  enterVrFeatureEnabled: boolean;
  webGlAvailable: boolean;
  webSocketAvailable: boolean;
  touchInputAvailable: boolean;
  xrMockEnabled?: boolean;
  xrSessionActive?: boolean;
}): ClientCompatibilitySummary {
  const modeSource = input.xrMockEnabled ? "xr_mock" : input.xrSessionActive ? "xr_session" : "user_agent";
  const touchRequired = input.resolvedJoinMode === "mobile";
  const enterVrVisible = input.enterVrFeatureEnabled && input.xr.canEnterVr;
  const warnings: ClientCompatibilityWarningCode[] = [];

  if (!input.webGlAvailable) warnings.push("webgl_unavailable");
  if (!input.webSocketAvailable) warnings.push("websocket_unavailable");
  if (touchRequired && !input.touchInputAvailable) warnings.push("touch_controls_unavailable");
  if (!input.media.audioInput.supported) warnings.push("audio_input_unavailable");
  if (!input.media.screenShare.supported) warnings.push("screen_share_unavailable");
  if (!enterVrVisible && !input.xrMockEnabled) warnings.push("xr_unavailable");

  return {
    resolvedJoinMode: input.resolvedJoinMode,
    modeSource,
    entryBlocked: !input.webGlAvailable,
    degradedMode: resolveCompatibilityDegradedMode(warnings),
    warnings,
    webgl: {
      supported: input.webGlAvailable
    },
    websocket: {
      supported: input.webSocketAvailable
    },
    touchControls: {
      supported: input.touchInputAvailable,
      required: touchRequired
    },
    media: input.media,
    xr: {
      ...input.xr,
      enterVrVisible,
      mocked: Boolean(input.xrMockEnabled)
    }
  };
}

function resolveCompatibilityDegradedMode(warnings: ClientCompatibilityWarningCode[]): ClientCompatibilityDegradedMode {
  if (warnings.includes("webgl_unavailable")) return "webgl_unavailable";
  if (warnings.includes("websocket_unavailable")) return "realtime_limited";
  if (warnings.includes("touch_controls_unavailable")) return "touch_limited";
  if (warnings.includes("audio_input_unavailable") || warnings.includes("screen_share_unavailable")) return "media_limited";
  if (warnings.includes("xr_unavailable")) return "xr_disabled";
  return "none";
}

function formatWarning(code: ClientCompatibilityWarningCode): string {
  switch (code) {
    case "webgl_unavailable":
      return "WebGL unavailable";
    case "websocket_unavailable":
      return "realtime limited";
    case "touch_controls_unavailable":
      return "touch controls unavailable";
    case "audio_input_unavailable":
      return "microphone unavailable";
    case "screen_share_unavailable":
      return "screen share unavailable";
    case "xr_unavailable":
      return "VR unavailable";
  }
}

export function formatClientCompatibilityStatus(summary: ClientCompatibilitySummary): string {
  const modeLabel = summary.resolvedJoinMode === "vr" ? "VR" : summary.resolvedJoinMode;
  if (summary.warnings.length === 0) {
    return `Compatibility: ${modeLabel} mode ready`;
  }

  const warnings = summary.warnings.map(formatWarning).join(", ");
  return `Compatibility: ${modeLabel} mode, degraded: ${warnings}`;
}
