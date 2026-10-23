import type { RemoteBrowserMediaSourceRect } from "@vrata/shared-types";

export interface RemoteBrowserMediaAnswerResult {
  ok: boolean;
  answer?: RTCSessionDescriptionInit;
  hasVideo?: boolean;
  hasAudio?: boolean;
  trackKinds?: string[];
  sourceFrameUrl?: string;
  sourceRect?: RemoteBrowserMediaSourceRect;
  errorCode?: string;
}

/** Per-frame slot on window.__VRATA_REMOTE_BROWSER_MEDIA__: at most one peer per frame. */
export interface RemoteBrowserPageMediaState {
  pc?: RTCPeerConnection;
  /** Tracks recorded as peer-owned for cleanup. Unset while searching or when the capture-time MediaStream check selects conservative detachment. */
  stream?: MediaStream;
  peerNonce?: string;
  expiryTimer?: number;
}

export interface RemoteBrowserPageMediaAnswerInput {
  offer: RTCSessionDescriptionInit;
  iceServers: RTCIceServer[];
  /** Server-private owner tag; never sent to the viewer. */
  nonce: string;
  /** Effective socket lease deadline. Node and Chromium read the same host clock. */
  expiresAtMs: number;
}

type RemoteBrowserMediaWindow = Window & { __VRATA_REMOTE_BROWSER_MEDIA__?: RemoteBrowserPageMediaState };

// The functions below run in page frames via frame.evaluate, which ships only their source text.
// Keep them self-contained: no imports or module-scope values, only erased types.

export async function remoteBrowserCreateMediaAnswerInPage(input: RemoteBrowserPageMediaAnswerInput): Promise<RemoteBrowserMediaAnswerResult> {
  type CapturableVideo = HTMLVideoElement & {
    captureStream?: () => MediaStream;
    mozCaptureStream?: () => MediaStream;
  };
  const mediaWindow = window as RemoteBrowserMediaWindow;
  const stopTracks = (stream: MediaStream | undefined): void => {
    for (const track of stream?.getTracks() ?? []) track.stop();
  };
  // The socket lease deadline as of now. A call can start long after it was sent (frame.evaluate queues behind
  // earlier page work), so a lapsed or invalid deadline must never reach the frame's slot.
  const leaseOpen = (): boolean => Number.isFinite(input.expiresAtMs) && Date.now() < input.expiresAtMs;
  if (!leaseOpen()) return { ok: false, errorCode: "media_answer_failed" };
  const state = mediaWindow.__VRATA_REMOTE_BROWSER_MEDIA__ ??= {};
  let pc: RTCPeerConnection;
  try {
    pc = new RTCPeerConnection({ iceServers: input.iceServers });
  } catch {
    return { ok: false, errorCode: "media_answer_failed" };
  }
  // Tracks this negotiation captured; stopped with its peer. Never the page's own MediaStream tracks.
  let ownedStream: MediaStream | undefined;
  const failClosed = (errorCode = "media_answer_failed"): RemoteBrowserMediaAnswerResult => {
    pc.close();
    stopTracks(ownedStream);
    if (state.pc === pc) {
      window.clearTimeout(state.expiryTimer);
      state.pc = undefined;
      state.stream = undefined;
      state.peerNonce = undefined;
      state.expiryTimer = undefined;
    }
    return { ok: false, errorCode };
  };
  const ownsPeer = (): boolean => state.pc === pc && state.peerNonce === input.nonce && leaseOpen();

  // Re-checked after the peer constructor, immediately before displacement: a lapsed call closes only its own
  // unclaimed peer and leaves the current owner, its tracks and its timer exactly as they are.
  if (!leaseOpen()) return failClosed();
  // One peer per frame: displace the previous owner with the tracks it captured, then claim the slot with
  // this nonce and deadline before the first await, so a newer offer, matched-nonce cleanup and the
  // deadline all reach this peer while the source search below is still pending.
  window.clearTimeout(state.expiryTimer);
  state.pc?.close();
  stopTracks(state.stream);
  state.pc = pc;
  state.stream = undefined;
  state.peerNonce = input.nonce;
  // Fallback if the server's matched-nonce cleanup never lands.
  state.expiryTimer = window.setTimeout(() => {
    if (state.pc === pc && state.peerNonce === input.nonce) failClosed();
  }, Math.max(0, input.expiresAtMs - Date.now()));

  const collectVideos = (root: ParentNode): CapturableVideo[] => {
    const videos = [...root.querySelectorAll("video")] as CapturableVideo[];
    for (const element of [...root.querySelectorAll("*")] as HTMLElement[]) {
      if (element.shadowRoot) {
        videos.push(...collectVideos(element.shadowRoot));
      }
    }
    return videos;
  };
  const pickVideo = (): CapturableVideo | null => {
    const candidates = collectVideos(document)
      .filter((video) => typeof video.captureStream === "function" || typeof video.mozCaptureStream === "function")
      .sort((left, right) => (right.videoWidth * right.videoHeight) - (left.videoWidth * left.videoHeight));
    return candidates[0] ?? null;
  };
  const waitForVideo = async (): Promise<CapturableVideo | null> => {
    const startedAt = Date.now();
    // A displaced, closed or expired peer stops searching at the next poll.
    while (ownsPeer() && Date.now() - startedAt < 5000) {
      const video = pickVideo();
      if (video) {
        return video;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
    return null;
  };
  const waitForIceGatheringComplete = async (pc: RTCPeerConnection): Promise<void> => {
    if (pc.iceGatheringState === "complete") {
      return;
    }
    await new Promise<void>((resolve) => {
      const timeout = window.setTimeout(() => {
        pc.removeEventListener("icegatheringstatechange", onStateChange);
        resolve();
      }, 2500);
      const onStateChange = () => {
        if (pc.iceGatheringState !== "complete") {
          return;
        }
        window.clearTimeout(timeout);
        pc.removeEventListener("icegatheringstatechange", onStateChange);
        resolve();
      };
      pc.addEventListener("icegatheringstatechange", onStateChange);
    });
  };

  try {
    const source = await waitForVideo();
    // Displaced, closed or expired while searching: capture nothing.
    if (!ownsPeer()) return failClosed();
    if (!source) return failClosed("media_source_missing");
    const captureStream = source.captureStream?.bind(source) ?? source.mozCaptureStream?.bind(source);
    if (!captureStream) return failClosed("media_capture_unsupported");
    const stream = captureStream();
    // Conservatively detach a MediaStream-backed capture rather than stopping potential source tracks.
    // Check after captureStream(): Chromium can adapt the wrapper to this realm during capture.
    if (!(typeof MediaStream === "function" && source.srcObject instanceof MediaStream)) {
      ownedStream = stream;
      state.stream = stream;
    }
    const tracks: MediaStreamTrack[] = stream.getTracks().filter((track: MediaStreamTrack) => track.readyState === "live");
    if (!tracks.some((track) => track.kind === "video")) return failClosed("media_video_track_missing");
    for (const track of tracks) {
      pc.addTrack(track, stream);
    }
    await pc.setRemoteDescription(input.offer);
    if (!ownsPeer()) return failClosed();
    const answer = await pc.createAnswer();
    if (!ownsPeer()) return failClosed();
    await pc.setLocalDescription(answer);
    if (!ownsPeer()) return failClosed();
    await waitForIceGatheringComplete(pc);
    if (!ownsPeer()) return failClosed();
    const rect = source.getBoundingClientRect();
    return {
      ok: true,
      answer: pc.localDescription ? { type: pc.localDescription.type, sdp: pc.localDescription.sdp } : undefined,
      hasVideo: tracks.some((track) => track.kind === "video"),
      hasAudio: tracks.some((track) => track.kind === "audio"),
      trackKinds: tracks.map((track) => track.kind),
      sourceFrameUrl: location.href,
      sourceRect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      }
    };
  } catch {
    return failClosed();
  }
}

/** Closes this frame's peer only if `nonce` still owns it; a newer viewer's peer is left alone. */
export function remoteBrowserCloseMediaPeerInPage(nonce: string): boolean {
  const state = (window as RemoteBrowserMediaWindow).__VRATA_REMOTE_BROWSER_MEDIA__;
  if (!state?.pc || state.peerNonce !== nonce) return false;
  window.clearTimeout(state.expiryTimer);
  state.pc.close();
  // Only tracks recorded as peer-owned are stopped here.
  for (const track of state.stream?.getTracks() ?? []) track.stop();
  state.pc = undefined;
  state.stream = undefined;
  state.peerNonce = undefined;
  state.expiryTimer = undefined;
  return true;
}
