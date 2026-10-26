import { t, type MessageKey } from "./i18n/i18n.js";

export type RuntimeIssueCode =
  | "mic_denied"
  | "no_audio_device"
  | "audio_unsupported"
  | "livekit_failed"
  | "media_network_blocked"
  | "screen_share_denied"
  | "screen_share_unsupported"
  | "room_state_failed"
  | "room_access_denied"
  | "xr_unavailable"
  | "xr_enter_failed"
  | "runtime_unhandled_error";

export type RuntimeIssueSeverity = "info" | "warn" | "error";

export interface RuntimeIssue {
  code: RuntimeIssueCode;
  recoverable: boolean;
  retryable: boolean;
  severity: RuntimeIssueSeverity;
  /** In the current UI language. */
  readonly userMessage: string;
  messageKey: MessageKey;
  diagnosticsNote: string;
  suggestedAction: string;
}

type RuntimeIssueEntry = Omit<RuntimeIssue, "userMessage">;

function createRuntimeIssueMap(): Record<RuntimeIssueCode, RuntimeIssue> {
  const entries: Record<RuntimeIssueCode, RuntimeIssueEntry> = {
    mic_denied: {
      code: "mic_denied",
      recoverable: true,
      retryable: false,
      severity: "warn",
      messageKey: "issue.micDenied",
      diagnosticsNote: "mic_denied",
      suggestedAction: "Allow microphone access and retry audio"
    },
    no_audio_device: {
      code: "no_audio_device",
      recoverable: true,
      retryable: false,
      severity: "warn",
      messageKey: "issue.micNotFound",
      diagnosticsNote: "no_audio_device",
      suggestedAction: "Connect a microphone and retry audio"
    },
    audio_unsupported: {
      code: "audio_unsupported",
      recoverable: true,
      retryable: false,
      severity: "warn",
      messageKey: "issue.micUnsupported",
      diagnosticsNote: "audio_unsupported",
      suggestedAction: "Use a browser and device with WebRTC microphone support"
    },
    livekit_failed: {
      code: "livekit_failed",
      recoverable: true,
      retryable: true,
      severity: "error",
      messageKey: "issue.audioUnavailable",
      diagnosticsNote: "livekit_failed",
      suggestedAction: "Retry audio when connection recovers"
    },
    media_network_blocked: {
      code: "media_network_blocked",
      recoverable: true,
      retryable: true,
      severity: "warn",
      messageKey: "issue.mediaBlocked",
      diagnosticsNote: "media_network_blocked",
      suggestedAction: "Try Wi-Fi or a network that allows WebRTC traffic"
    },
    screen_share_denied: {
      code: "screen_share_denied",
      recoverable: true,
      retryable: false,
      severity: "warn",
      messageKey: "issue.shareDenied",
      diagnosticsNote: "screen_share_denied",
      suggestedAction: "Allow screen sharing and retry"
    },
    screen_share_unsupported: {
      code: "screen_share_unsupported",
      recoverable: true,
      retryable: false,
      severity: "warn",
      messageKey: "issue.shareUnsupported",
      diagnosticsNote: "screen_share_unsupported",
      suggestedAction: "Use a browser and device with getDisplayMedia screen capture support"
    },
    room_state_failed: {
      code: "room_state_failed",
      recoverable: true,
      retryable: true,
      severity: "error",
      messageKey: "issue.realtimeUnavailable",
      diagnosticsNote: "room_state_failed",
      suggestedAction: "Keep room open while realtime reconnects"
    },
    room_access_denied: {
      code: "room_access_denied",
      recoverable: false,
      retryable: false,
      severity: "warn",
      messageKey: "issue.accessDenied",
      diagnosticsNote: "room_access_denied",
      suggestedAction: "Use a valid invite link or ask the host for approval"
    },
    xr_unavailable: {
      code: "xr_unavailable",
      recoverable: true,
      retryable: false,
      severity: "info",
      messageKey: "issue.xrUnavailable",
      diagnosticsNote: "xr_unavailable",
      suggestedAction: "Continue on desktop or mobile"
    },
    xr_enter_failed: {
      code: "xr_enter_failed",
      recoverable: true,
      retryable: false,
      severity: "warn",
      messageKey: "issue.xrEnterFailed",
      diagnosticsNote: "xr_enter_failed",
      suggestedAction: "Retry Enter VR or continue on desktop"
    },
    runtime_unhandled_error: {
      code: "runtime_unhandled_error",
      recoverable: false,
      retryable: false,
      severity: "error",
      messageKey: "issue.runtimeError",
      diagnosticsNote: "runtime_unhandled_error",
      suggestedAction: "Reload the room and share the report ID if the issue repeats"
    }
  };
  for (const entry of Object.values(entries)) {
    Object.defineProperty(entry, "userMessage", { enumerable: true, get: () => t(entry.messageKey) });
  }
  return entries as Record<RuntimeIssueCode, RuntimeIssue>;
}

const runtimeIssueMap = createRuntimeIssueMap();

function isMediaTransportError(error: Error): boolean {
  const name = error.name.toLowerCase();
  const message = error.message.toLowerCase();
  return name.includes("connection")
    || name.includes("timeout")
    || message.includes("media_network_blocked")
    || message.includes("websocket")
    || message.includes("signal")
    || message.includes("ice")
    || message.includes("transport")
    || message.includes("network")
    || message.includes("timed out")
    || message.includes("timeout")
    || message.includes("failed to connect")
    || message.includes("connection failed");
}

export function getRuntimeIssue(code: RuntimeIssueCode): RuntimeIssue {
  return runtimeIssueMap[code];
}

export function shouldRetryConnection(code: RuntimeIssueCode): boolean {
  return runtimeIssueMap[code].retryable;
}

export function classifyMediaError(error: unknown): RuntimeIssue {
  if (error instanceof Error) {
    if (error.message.includes("audio_unsupported") || error.message.includes("getUserMedia") || error.name === "NotSupportedError") {
      return getRuntimeIssue("audio_unsupported");
    }
    if (error.name === "NotAllowedError" || error.message.includes("mic_denied")) {
      return getRuntimeIssue("mic_denied");
    }
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError" || error.message.includes("no_audio_device")) {
      return getRuntimeIssue("no_audio_device");
    }
    if (isMediaTransportError(error)) {
      return getRuntimeIssue("media_network_blocked");
    }
  }

  return getRuntimeIssue("livekit_failed");
}

export function classifyScreenShareError(error: unknown): RuntimeIssue {
  if (error instanceof Error) {
    if (error.name === "NotAllowedError" || error.name === "AbortError") {
      return getRuntimeIssue("screen_share_denied");
    }
    if (
      error.name === "NotSupportedError"
      || error.message.includes("screen_share_unsupported")
      || error.message.includes("getDisplayMedia")
      || error.message.includes("display media")
      || error.message.includes("screen capture")
    ) {
      return getRuntimeIssue("screen_share_unsupported");
    }
    if (isMediaTransportError(error)) {
      return getRuntimeIssue("media_network_blocked");
    }
  }

  return getRuntimeIssue("livekit_failed");
}

/** Only a definitive capture-stage result proves persistent lack of support.
 * SDK/transport messages can mention capture while describing a retryable fault. */
export function classifyScreenShareActionError(error: unknown, duringCapture: boolean): RuntimeIssue {
  const issue = classifyScreenShareError(error);
  if (issue.code !== "screen_share_unsupported" || duringCapture && error instanceof Error && error.name === "NotSupportedError") return issue;
  return getRuntimeIssue(error instanceof Error && isMediaTransportError(error) ? "media_network_blocked" : "livekit_failed");
}

export function classifyRoomStateError(error: unknown): RuntimeIssue {
  if (error instanceof Error && error.message.includes("room_state_failed")) {
    return getRuntimeIssue("room_state_failed");
  }
  return getRuntimeIssue("room_state_failed");
}

export function createFaultError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
