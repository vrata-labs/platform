import { randomUUID } from "node:crypto";

/** One offer on one viewer socket. The nonce is server-private and never sent to the viewer. */
export interface FrameMediaPeerNegotiation<F> {
  readonly nonce: string;
  /** Still the latest offer on an unreleased binding. */
  isCurrent(): boolean;
  /** Records `frame` before its page call can claim a peer, so release, a newer offer or discard can close
   * that peer while the answer is pending; moving to another frame closes the previous frame's claim.
   * False once released or superseded: do not evaluate in `frame`. */
  attach(frame: F): boolean;
  /** Installs the answered peer; a released or superseded negotiation closes its own peer instead. */
  complete(frame: F): boolean;
  /** Abandons this negotiation, closing its own peer in `frame` and in its attached frame. */
  discard(frame?: F): void;
}

export interface FrameMediaPeerBinding<F> {
  /** Starts an offer and closes this socket's previous peer, whichever frame holds it. Null once released. */
  begin(): FrameMediaPeerNegotiation<F> | null;
  /** Idempotent: closes the installed peer and fences outstanding negotiations. */
  release(): void;
}

interface PendingPeer<F> {
  readonly nonce: string;
  frame?: F;
  /** The binding already closed this nonce's peer in `frame` (superseded or released). */
  closed: boolean;
}

/** Per-socket ownership of in-page media peers. Cleanup is always by (frame, nonce), so it can
 * never close a peer another viewer installed in the same frame. */
export function createFrameMediaPeerBinding<F>(options: {
  closePeer: (frame: F, nonce: string) => unknown;
  createNonce?: () => string;
}): FrameMediaPeerBinding<F> {
  const createNonce = options.createNonce ?? randomUUID;
  let released = false;
  // The current offer and the frame its page call may already hold a peer in, known before the answer.
  let pending: PendingPeer<F> | null = null;
  let installed: { frame: F; nonce: string } | null = null;
  const closePeer = (frame: F, nonce: string): void => {
    // Best effort: the page also closes the peer at the lease deadline if this never lands.
    try {
      void Promise.resolve(options.closePeer(frame, nonce)).catch(() => undefined);
    } catch {
      // Detached frames and closed contexts may throw synchronously.
    }
  };
  const closePending = (): void => {
    const current = pending;
    pending = null;
    if (!current) return;
    current.closed = true;
    if (current.frame !== undefined) closePeer(current.frame, current.nonce);
  };
  const closeInstalled = (): void => {
    const current = installed;
    installed = null;
    if (current) closePeer(current.frame, current.nonce);
  };
  return {
    begin() {
      if (released) return null;
      closeInstalled();
      closePending();
      const entry: PendingPeer<F> = { nonce: createNonce(), closed: false };
      pending = entry;
      const { nonce } = entry;
      const isCurrent = () => !released && pending === entry;
      // Closes this nonce's peer in `frame` unless the binding already closed it there.
      const closeOwn = (frame: F | undefined): void => {
        if (frame === undefined || (entry.closed && frame === entry.frame)) return;
        closePeer(frame, nonce);
      };
      return {
        nonce,
        isCurrent,
        attach(frame) {
          if (!isCurrent()) return false;
          if (entry.frame !== frame) closeOwn(entry.frame);
          entry.frame = frame;
          return true;
        },
        complete(frame) {
          if (!isCurrent()) {
            closeOwn(frame);
            return false;
          }
          if (entry.frame !== frame) closeOwn(entry.frame);
          pending = null;
          installed = { frame, nonce };
          return true;
        },
        discard(frame) {
          if (pending === entry) {
            pending = null;
            if (entry.frame !== frame) closeOwn(entry.frame);
          }
          if (installed?.nonce === nonce) installed = null;
          closeOwn(frame);
        }
      };
    },
    release() {
      if (released) return;
      released = true;
      closePending();
      closeInstalled();
    }
  };
}
