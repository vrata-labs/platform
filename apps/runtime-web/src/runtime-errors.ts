export type RuntimeIssueCode =
  | "mic_denied"
  | "no_audio_device"
  | "livekit_failed"
  | "room_state_failed"
  | "xr_unavailable";

export type RuntimeIssueSeverity = "info" | "warn" | "error";

export interface RuntimeIssue {
  code: RuntimeIssueCode;
  recoverable: boolean;
  retryable: boolean;
  severity: RuntimeIssueSeverity;
  userMessage: string;
  diagnosticsNote: string;
  suggestedAction: string;
}

function createRuntimeIssueMap(): Record<RuntimeIssueCode, RuntimeIssue> {
  return {
    mic_denied: {
      code: "mic_denied",
      recoverable: true,
      retryable: false,
      severity: "warn",
      userMessage: "Microphone blocked; room continues without audio",
      diagnosticsNote: "mic_denied",
      suggestedAction: "Allow microphone access and retry audio"
    },
    no_audio_device: {
      code: "no_audio_device",
      recoverable: true,
      retryable: false,
      severity: "warn",
      userMessage: "No microphone found; room continues without audio",
      diagnosticsNote: "no_audio_device",
      suggestedAction: "Connect a microphone and retry audio"
    },
    livekit_failed: {
      code: "livekit_failed",
      recoverable: true,
      retryable: true,
      severity: "error",
      userMessage: "Audio service unavailable; room continues in presence-only mode",
      diagnosticsNote: "livekit_failed",
      suggestedAction: "Retry audio when connection recovers"
    },
    room_state_failed: {
      code: "room_state_failed",
      recoverable: true,
      retryable: true,
      severity: "error",
      userMessage: "Realtime sync unavailable; using API fallback",
      diagnosticsNote: "room_state_failed",
      suggestedAction: "Keep room open while realtime reconnects"
    },
    xr_unavailable: {
      code: "xr_unavailable",
      recoverable: true,
      retryable: false,
      severity: "info",
      userMessage: "VR unavailable on this device or disabled for this environment",
      diagnosticsNote: "xr_unavailable",
      suggestedAction: "Continue on desktop or mobile"
    }
  };
}

const runtimeIssueMap = createRuntimeIssueMap();

export function getRuntimeIssue(code: RuntimeIssueCode): RuntimeIssue {
  return runtimeIssueMap[code];
}

export function shouldRetryConnection(code: RuntimeIssueCode): boolean {
  return runtimeIssueMap[code].retryable;
}

export function classifyMediaError(error: unknown): RuntimeIssue {
  if (error instanceof Error) {
    if (error.name === "NotAllowedError" || error.message.includes("mic_denied")) {
      return getRuntimeIssue("mic_denied");
    }
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError" || error.message.includes("no_audio_device")) {
      return getRuntimeIssue("no_audio_device");
    }
  }

  return getRuntimeIssue("livekit_failed");
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
