import assert from "node:assert/strict";
import test from "node:test";
import { attachFrameSocketLifetime, type FrameSocketPort } from "./frame-socket-lifetime.js";
import type { FrameMediaPeerBinding } from "./frame-media-peer.js";

// Stands in for an accepted ws socket: like an EventEmitter, an 'error' with no listener throws.
function fakeSocket() {
  const errorListeners: Array<() => void> = [];
  const closeListeners: Array<() => void> = [];
  const registered: string[] = [];
  const calls: string[] = [];
  let open = true;
  const port: FrameSocketPort = {
    isOpen: () => open,
    close: (code, reason) => { calls.push(`close:${code}:${reason}`); open = false; },
    terminate: () => { calls.push("terminate"); open = false; },
    onError: listener => { registered.push("error"); errorListeners.push(listener); },
    onClose: listener => { registered.push("close"); closeListeners.push(listener); }
  };
  return {
    port,
    calls,
    registered,
    emitError() {
      if (errorListeners.length === 0) throw new Error("unhandled socket error");
      for (const listener of errorListeners) listener();
    },
    emitClose() {
      open = false;
      for (const listener of closeListeners) listener();
    }
  };
}

// One socket whose lease ends at 10 s; every socket's peers close into the shared `closed` log.
function admit(closed: string[], clock: { now: number }, isCurrent: () => boolean = () => true) {
  const socket = fakeSocket();
  let detached = 0;
  let disconnects = 0;
  let timer: (() => void) | undefined;
  const lifetime = attachFrameSocketLifetime<string>({
    socket: socket.port,
    leaseExpiresAtSeconds: 10,
    isCurrent,
    closePeer: (frame, nonce) => { closed.push(`${frame}/${nonce}`); },
    detach: () => { detached += 1; },
    onDisconnect: () => { disconnects += 1; },
    now: () => clock.now,
    schedule: callback => { timer = callback; return () => { timer = undefined; }; }
  });
  return { socket, lifetime, detached: () => detached, disconnects: () => disconnects, fireTimer: () => timer?.() };
}

function installPeer(peer: FrameMediaPeerBinding<string>, frame: string): string {
  const negotiation = peer.begin()!;
  assert.equal(negotiation.complete(frame), true);
  return negotiation.nonce;
}

test("token expiry retires the socket's peer and client entries at the next live check, before any close event", () => {
  const closed: string[] = [];
  const clock = { now: 9_000 };
  const viewer = admit(closed, clock);
  assert.equal(viewer.socket.registered[0], "error");
  const nonce = installPeer(viewer.lifetime!.peer, "frame-a");
  assert.equal(viewer.lifetime!.isLive(), true);
  clock.now = 10_000;
  // The lease timer has not fired (delayed event loop); the send gate must still retire now.
  assert.equal(viewer.lifetime!.isLive(), false);
  assert.deepEqual(closed, [`frame-a/${nonce}`]);
  assert.equal(viewer.detached(), 1);
  assert.deepEqual(viewer.socket.calls, ["close:1008:frame_token_expired"]);
  // The timer, a protocol error during the close handshake and the close event retire nothing more.
  viewer.fireTimer();
  viewer.socket.emitError();
  viewer.socket.emitClose();
  assert.deepEqual(closed, [`frame-a/${nonce}`]);
  assert.equal(viewer.detached(), 1);
  assert.deepEqual(viewer.socket.calls, ["close:1008:frame_token_expired", "terminate"]);
  assert.equal(viewer.disconnects(), 1);
  assert.equal(viewer.lifetime!.peer.begin(), null);
});

test("a protocol error retires and terminates only its own socket, before the close event", () => {
  const closed: string[] = [];
  const clock = { now: 9_000 };
  const rogue = admit(closed, clock);
  const viewer = admit(closed, clock);
  const rogueNonce = installPeer(rogue.lifetime!.peer, "frame-a");
  installPeer(viewer.lifetime!.peer, "frame-a");
  assert.doesNotThrow(() => rogue.socket.emitError());
  assert.deepEqual(closed, [`frame-a/${rogueNonce}`]);
  assert.deepEqual(rogue.socket.calls, ["terminate"]);
  assert.equal(rogue.detached(), 1);
  assert.equal(rogue.lifetime!.isLive(), false);
  // The other viewer in the same frame keeps its peer, client entries and socket.
  assert.equal(viewer.lifetime!.isLive(), true);
  assert.equal(viewer.detached(), 0);
  assert.deepEqual(viewer.socket.calls, []);
  rogue.socket.emitClose();
  rogue.fireTimer();
  assert.deepEqual(closed, [`frame-a/${rogueNonce}`]);
  assert.equal(rogue.detached(), 1);
  assert.equal(rogue.disconnects(), 1);
});

test("a socket refused as inactive arms no lease and still handles a later protocol error", () => {
  const closed: string[] = [];
  const refused = admit(closed, { now: 9_000 }, () => false);
  assert.equal(refused.lifetime, null);
  assert.deepEqual(refused.socket.registered, ["error"]);
  assert.deepEqual(refused.socket.calls, ["close:1008:frame_session_inactive"]);
  assert.doesNotThrow(() => refused.socket.emitError());
  assert.deepEqual(refused.socket.calls, ["close:1008:frame_session_inactive", "terminate"]);
  assert.deepEqual(closed, []);
});

test("a lease already lapsed at the handshake retires once, and its error and close retire nothing more", () => {
  const closed: string[] = [];
  const lapsed = admit(closed, { now: 10_000 });
  assert.equal(lapsed.lifetime, null);
  assert.equal(lapsed.socket.registered[0], "error");
  assert.deepEqual(lapsed.socket.calls, ["close:1008:frame_token_expired"]);
  assert.equal(lapsed.detached(), 1);
  assert.doesNotThrow(() => lapsed.socket.emitError());
  lapsed.socket.emitClose();
  assert.equal(lapsed.detached(), 1);
  assert.deepEqual(lapsed.socket.calls, ["close:1008:frame_token_expired", "terminate"]);
  assert.deepEqual(closed, []);
});

test("a replaced executor fails the send gate, and its stale negotiation cannot install or close after retirement", () => {
  const closed: string[] = [];
  let current = true;
  const viewer = admit(closed, { now: 9_000 }, () => current);
  const pending = viewer.lifetime!.peer.begin()!;
  assert.equal(pending.attach("frame-a"), true);
  current = false;
  assert.equal(viewer.lifetime!.isLive(), false);
  // The gate only decides sends; replacement closes the socket through stopSession, whose close event retires it.
  assert.deepEqual(closed, []);
  assert.deepEqual(viewer.socket.calls, []);
  viewer.socket.emitClose();
  assert.deepEqual(closed, [`frame-a/${pending.nonce}`]);
  assert.equal(viewer.detached(), 1);
  assert.equal(pending.isCurrent(), false);
  assert.equal(pending.complete("frame-a"), false);
  pending.discard("frame-a");
  assert.deepEqual(closed, [`frame-a/${pending.nonce}`]);
});
