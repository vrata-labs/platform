import { createFrameMediaPeerBinding, type FrameMediaPeerBinding } from "./frame-media-peer.js";
import { attachFrameTokenLease } from "./frame-socket-lease.js";

/** What a frame socket's lifetime needs from the accepted WebSocket. Listeners receive no error or close payload. */
export interface FrameSocketPort {
  isOpen(): boolean;
  close(code: number, reason: string): void;
  terminate(): void;
  onError(listener: () => void): void;
  onClose(listener: () => void): void;
}

/** Per-socket send gate and peer binding of one admitted frame socket. */
export interface FrameSocketLifetime<F> {
  readonly expiresAtMs: number;
  readonly peer: FrameMediaPeerBinding<F>;
  /** Open, unexpired and on the current executor instance; an expiry found here retires the socket at once. */
  isLive(): boolean;
}

/** Composes one accepted frame socket's lifetime. Lease expiry, a socket error and the close event each retire it
 * exactly once: its own peers are released by matched nonce and it leaves the session's client sets, so other
 * viewers' peers and sockets are untouched. Null when the socket is refused at once; do not register it. */
export function attachFrameSocketLifetime<F>(input: {
  socket: FrameSocketPort;
  leaseExpiresAtSeconds: number;
  /** The admitted executor instance is still the session's current one. */
  isCurrent: () => boolean;
  closePeer: (frame: F, nonce: string) => unknown;
  /** Removes the socket from the session's frame and media client sets. */
  detach: () => void;
  onDisconnect: () => void;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
}): FrameSocketLifetime<F> | null {
  const { socket } = input;
  const peer = createFrameMediaPeerBinding<F>({ closePeer: input.closePeer });
  let retired = false;
  const retire = (): void => {
    if (retired) return;
    retired = true;
    peer.release();
    input.detach();
  };
  // First, before any early return: ws reports a protocol violation (e.g. an unmasked client frame) as an
  // 'error' event before any message, and an unhandled 'error' would crash every session in the process.
  socket.onError(() => {
    retire();
    socket.terminate();
  });
  // The handshake can outlive admission: a replaced or expired executor must not gain a socket.
  if (!input.isCurrent()) {
    socket.close(1008, "frame_session_inactive");
    return null;
  }
  // Expiry releases the peer now; the WebSocket close handshake may take much longer.
  const lease = attachFrameTokenLease({ expiresAtSeconds: input.leaseExpiresAtSeconds, now: input.now, schedule: input.schedule,
    close: (code, reason) => { retire(); socket.close(code, reason); }, onClose: callback => socket.onClose(callback) });
  socket.onClose(() => {
    input.onDisconnect();
    retire();
  });
  if (lease.closeIfExpired()) return null;
  return {
    expiresAtMs: input.leaseExpiresAtSeconds * 1000,
    peer,
    isLive: () => socket.isOpen() && !lease.closeIfExpired() && input.isCurrent()
  };
}
