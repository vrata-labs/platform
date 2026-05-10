export type MediaCapabilityReason =
  | "supported"
  | "insecure_context"
  | "webrtc_missing"
  | "media_devices_missing"
  | "get_user_media_missing"
  | "get_display_media_missing";

export interface MediaDevicesLike {
  enumerateDevices?: unknown;
  getDisplayMedia?: unknown;
  getUserMedia?: unknown;
}

export interface BrowserMediaCapabilities {
  secureContext: boolean;
  mediaDevices: boolean;
  enumerateDevices: boolean;
  getUserMedia: boolean;
  getDisplayMedia: boolean;
  rtcPeerConnection: boolean;
  audioInput: {
    supported: boolean;
    reason: MediaCapabilityReason;
  };
  screenShare: {
    supported: boolean;
    reason: MediaCapabilityReason;
  };
}

function isFunction(value: unknown): boolean {
  return typeof value === "function";
}

function resolveAudioInputReason(input: {
  secureContext: boolean;
  mediaDevices: boolean;
  getUserMedia: boolean;
  rtcPeerConnection: boolean;
}): MediaCapabilityReason {
  if (!input.secureContext) return "insecure_context";
  if (!input.rtcPeerConnection) return "webrtc_missing";
  if (!input.mediaDevices) return "media_devices_missing";
  if (!input.getUserMedia) return "get_user_media_missing";
  return "supported";
}

function resolveScreenShareReason(input: {
  secureContext: boolean;
  mediaDevices: boolean;
  getDisplayMedia: boolean;
  rtcPeerConnection: boolean;
}): MediaCapabilityReason {
  if (!input.secureContext) return "insecure_context";
  if (!input.rtcPeerConnection) return "webrtc_missing";
  if (!input.mediaDevices) return "media_devices_missing";
  if (!input.getDisplayMedia) return "get_display_media_missing";
  return "supported";
}

export function detectBrowserMediaCapabilities(input: {
  isSecureContext: boolean;
  mediaDevices?: MediaDevicesLike | null;
  rtcPeerConnection?: unknown;
}): BrowserMediaCapabilities {
  const mediaDevices = Boolean(input.mediaDevices);
  const getUserMedia = isFunction(input.mediaDevices?.getUserMedia);
  const getDisplayMedia = isFunction(input.mediaDevices?.getDisplayMedia);
  const enumerateDevices = isFunction(input.mediaDevices?.enumerateDevices);
  const rtcPeerConnection = isFunction(input.rtcPeerConnection);
  const audioReason = resolveAudioInputReason({
    secureContext: input.isSecureContext,
    mediaDevices,
    getUserMedia,
    rtcPeerConnection
  });
  const screenShareReason = resolveScreenShareReason({
    secureContext: input.isSecureContext,
    mediaDevices,
    getDisplayMedia,
    rtcPeerConnection
  });

  return {
    secureContext: input.isSecureContext,
    mediaDevices,
    enumerateDevices,
    getUserMedia,
    getDisplayMedia,
    rtcPeerConnection,
    audioInput: {
      supported: audioReason === "supported",
      reason: audioReason
    },
    screenShare: {
      supported: screenShareReason === "supported",
      reason: screenShareReason
    }
  };
}

export function describeMediaCapabilityReason(reason: MediaCapabilityReason): string {
  switch (reason) {
    case "insecure_context":
      return "HTTPS or localhost required";
    case "webrtc_missing":
      return "WebRTC unavailable";
    case "media_devices_missing":
      return "mediaDevices API missing";
    case "get_user_media_missing":
      return "getUserMedia missing";
    case "get_display_media_missing":
      return "getDisplayMedia missing";
    case "supported":
      return "supported";
  }
}

export function formatUnsupportedMediaCapabilities(capabilities: BrowserMediaCapabilities): string {
  const messages: string[] = [];
  if (!capabilities.audioInput.supported) {
    messages.push(`Microphone unsupported: ${describeMediaCapabilityReason(capabilities.audioInput.reason)}`);
  }
  if (!capabilities.screenShare.supported) {
    messages.push(`Screen share unsupported: ${describeMediaCapabilityReason(capabilities.screenShare.reason)}`);
  }
  return messages.join("; ");
}
