export interface RuntimeIssue {
  code:
    | "mic_denied"
    | "no_audio_device"
    | "livekit_failed"
    | "room_state_failed"
    | "xr_unavailable";
  recoverable: boolean;
}

export function createRuntimeIssue(code: RuntimeIssue["code"]): RuntimeIssue {
  return {
    code,
    recoverable: code !== "xr_unavailable"
  };
}

export function shouldRetryConnection(code: RuntimeIssue["code"]): boolean {
  return code === "livekit_failed" || code === "room_state_failed";
}
