import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { remoteBrowserCloseMediaPeerInPage, remoteBrowserCreateMediaAnswerInPage, type RemoteBrowserPageMediaState } from "./frame-media-page.js";

// Node stand-ins for the page globals; real Chromium coverage follows separately.
class FakePeer {
  static created: FakePeer[] = [];
  static gates: Array<Promise<void> | undefined> = [];
  /** Runs inside the constructor, e.g. to let the clock pass a deadline while the peer is built. */
  static onConstruct: (() => void) | undefined;
  closed = false;
  iceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null;
  private readonly gate = FakePeer.gates[FakePeer.created.length];
  constructor() {
    FakePeer.created.push(this);
    FakePeer.onConstruct?.();
  }
  addTrack(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  async setRemoteDescription(offer: RTCSessionDescriptionInit): Promise<void> {
    await this.gate;
    if (offer.sdp === "reject") throw new Error("fake_invalid_offer");
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "fake-answer" };
  }
  async setLocalDescription(answer: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = answer;
  }
  close(): void {
    this.closed = true;
  }
}

class FakeTrack {
  readyState = "live";
  constructor(readonly kind: string) {}
  stop(): void {
    this.readyState = "ended";
  }
}

class FakeStream {
  constructor(private readonly tracks: FakeTrack[]) {}
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

const offer: RTCSessionDescriptionInit = { type: "offer", sdp: "fake-offer" };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const trackStates = (stream: FakeStream | undefined) => stream?.getTracks().map((track) => track.readyState);
const answer = (nonce: string, expiresAtMs: number, sdp = "fake-offer") =>
  remoteBrowserCreateMediaAnswerInPage({ offer: { type: "offer", sdp }, iceServers: [], nonce, expiresAtMs });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Drives the page's window timers and Date.now, so deadlines and source polls run deterministically.
function fakeClock(t: TestContext) {
  let now = 1_000_000;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  t.mock.method(Date, "now", () => now);
  return {
    setTimeout: (callback: () => void, delay = 0) => {
      timers.set(++nextId, { at: now + delay, callback });
      return nextId;
    },
    clearTimeout: (id?: number) => {
      if (id !== undefined) timers.delete(id);
    },
    pending: () => timers.size,
    /** Moves the clock without running timers, as time passing inside one synchronous call would. */
    jump(ms: number) {
      now += ms;
    },
    async advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers].sort(([, left], [, right]) => left.at - right.at)) {
        if (timer.at > now || !timers.has(id)) continue;
        timers.delete(id);
        timer.callback();
        await flush();
      }
    }
  };
}

function installPage(clock: ReturnType<typeof fakeClock>, gates: Array<Promise<void> | undefined> = []) {
  FakePeer.created = [];
  FakePeer.gates = gates;
  FakePeer.onConstruct = undefined;
  const fakeWindow: Record<string, unknown> = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, innerWidth: 1280, innerHeight: 720 };
  const captured: FakeStream[] = [];
  const video = {
    videoWidth: 640,
    videoHeight: 360,
    srcObject: null as FakeStream | null,
    // Each element capture is a fresh stream with its own tracks.
    captureStream: () => {
      const stream = new FakeStream([new FakeTrack("video"), new FakeTrack("audio")]);
      captured.push(stream);
      return stream;
    },
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 640, height: 360 })
  };
  let videoPresent = true;
  const globals: Record<string, unknown> = {
    window: fakeWindow,
    document: { querySelectorAll: (selector: string) => (selector === "video" && videoPresent ? [video] : []) },
    location: { href: "https://media.example.test/" },
    MediaStream: FakeStream,
    RTCPeerConnection: FakePeer
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const state = () => fakeWindow.__VRATA_REMOTE_BROWSER_MEDIA__ as RemoteBrowserPageMediaState | undefined;
  return {
    state,
    video,
    captured,
    showVideo: (present: boolean) => { videoPresent = present; },
    restore: () => {
      FakePeer.onConstruct = undefined;
      const nonce = state()?.peerNonce;
      if (nonce) remoteBrowserCloseMediaPeerInPage(nonce);
      for (const key of Object.keys(globals)) delete (globalThis as Record<string, unknown>)[key];
    }
  };
}

test("a negotiation displaced mid-await closes only its own peer and keeps the newer owner", async (t) => {
  const gate = deferred();
  const page = installPage(fakeClock(t), [gate.promise]);
  try {
    const expiresAtMs = Date.now() + 60_000;
    const first = remoteBrowserCreateMediaAnswerInPage({ offer, iceServers: [], nonce: "nonce-1", expiresAtMs });
    await flush();
    assert.equal(FakePeer.created.length, 1);
    assert.equal(page.state()?.peerNonce, "nonce-1");
    const second = await remoteBrowserCreateMediaAnswerInPage({ offer, iceServers: [], nonce: "nonce-2", expiresAtMs });
    assert.equal(second.ok, true);
    const [older, newer] = FakePeer.created;
    assert.equal(older.closed, true);
    gate.resolve();
    const stale = await first;
    assert.equal(stale.ok, false);
    assert.equal(stale.errorCode, "media_answer_failed");
    assert.equal(newer.closed, false);
    assert.equal(page.state()?.peerNonce, "nonce-2");
    assert.equal(remoteBrowserCloseMediaPeerInPage("nonce-1"), false);
    assert.equal(newer.closed, false);
    assert.equal(remoteBrowserCloseMediaPeerInPage("nonce-2"), true);
    assert.equal(newer.closed, true);
    assert.equal(page.state()?.pc, undefined);
  } finally {
    page.restore();
  }
});

test("an offer whose deadline lapsed before it reached the slot leaves the current peer, tracks and timer untouched", async (t) => {
  const clock = fakeClock(t);
  const page = installPage(clock);
  try {
    assert.equal((await answer("nonce-current", Date.now() + 60_000)).ok, true);
    const [current] = FakePeer.created;
    const before = { ...page.state() };
    const assertSlotUnchanged = () => {
      const after = page.state();
      assert.equal(after?.pc, current);
      assert.equal(after?.stream, before.stream);
      assert.equal(after?.peerNonce, "nonce-current");
      assert.equal(after?.expiryTimer, before.expiryTimer);
      assert.equal(current.closed, false);
      assert.deepEqual(trackStates(page.captured[0]), ["live", "live"]);
      assert.equal(page.captured.length, 1);
      assert.equal(clock.pending(), 1);
    };
    // Lapsed or invalid when the call starts: no peer is even constructed.
    for (const expiresAtMs of [Date.now() - 1, Date.now(), Number.NaN, Number.POSITIVE_INFINITY]) {
      const lapsed = await answer("nonce-lapsed", expiresAtMs);
      assert.equal(lapsed.errorCode, "media_answer_failed");
      assert.equal(lapsed.answer, undefined);
      assertSlotUnchanged();
    }
    assert.equal(FakePeer.created.length, 1);
    // Lapsing while its peer is constructed: only that new local peer closes.
    FakePeer.onConstruct = () => clock.jump(10);
    const late = await answer("nonce-late", Date.now() + 10);
    assert.equal(late.errorCode, "media_answer_failed");
    assert.equal(late.answer, undefined);
    assert.equal(FakePeer.created.length, 2);
    assert.equal(FakePeer.created[1]?.closed, true);
    assertSlotUnchanged();
  } finally {
    page.restore();
  }
});

test("the in-page deadline closes the matching peer and its captured tracks when server cleanup never lands", async (t) => {
  const clock = fakeClock(t);
  const page = installPage(clock);
  try {
    const result = await remoteBrowserCreateMediaAnswerInPage({ offer, iceServers: [], nonce: "nonce-1", expiresAtMs: Date.now() + 100 });
    assert.equal(result.ok, true);
    const [peer] = FakePeer.created;
    assert.equal(peer.closed, false);
    await clock.advance(100);
    assert.equal(peer.closed, true);
    assert.equal(page.state()?.peerNonce, undefined);
    assert.deepEqual(trackStates(page.captured[0]), ["ended", "ended"]);
  } finally {
    page.restore();
  }
});

test("a negotiation whose deadline passes during an await fails closed", async (t) => {
  const gate = deferred();
  const clock = fakeClock(t);
  const page = installPage(clock, [gate.promise]);
  try {
    const pending = remoteBrowserCreateMediaAnswerInPage({ offer, iceServers: [], nonce: "nonce-1", expiresAtMs: Date.now() + 50 });
    await flush();
    await clock.advance(50);
    gate.resolve();
    const result = await pending;
    assert.equal(result.errorCode, "media_answer_failed");
    assert.equal(FakePeer.created[0]?.closed, true);
    assert.equal(page.state()?.pc, undefined);
    assert.deepEqual(trackStates(page.captured[0]), ["ended", "ended"]);
  } finally {
    page.restore();
  }
});

test("a driver rejection closes the negotiation's own peer and clears its timer", async (t) => {
  const page = installPage(fakeClock(t));
  try {
    const result = await remoteBrowserCreateMediaAnswerInPage({ offer: { type: "offer", sdp: "reject" }, iceServers: [], nonce: "nonce-1",
      expiresAtMs: Date.now() + 60_000 });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "media_answer_failed");
    assert.equal(FakePeer.created[0]?.closed, true);
    assert.equal(page.state()?.expiryTimer, undefined);
    assert.deepEqual(trackStates(page.captured[0]), ["ended", "ended"]);
  } finally {
    page.restore();
  }
});

test("a negotiation still searching for its source is displaced by a newer offer and never closes it", async (t) => {
  const clock = fakeClock(t);
  const page = installPage(clock);
  page.showVideo(false);
  try {
    const expiresAtMs = Date.now() + 60_000;
    const first = answer("nonce-1", expiresAtMs);
    await flush();
    // Peer, nonce and deadline are claimed before the source search's first await.
    assert.equal(FakePeer.created.length, 1);
    assert.equal(page.state()?.pc, FakePeer.created[0]);
    assert.equal(page.state()?.peerNonce, "nonce-1");
    assert.notEqual(page.state()?.expiryTimer, undefined);
    page.showVideo(true);
    const second = await answer("nonce-2", expiresAtMs);
    assert.equal(second.ok, true);
    const [older, newer] = FakePeer.created;
    assert.equal(older.closed, true);
    await clock.advance(250);
    const stale = await first;
    assert.equal(stale.errorCode, "media_answer_failed");
    // The displaced search captured nothing and left the newer owner, its tracks and its deadline alone.
    assert.equal(page.captured.length, 1);
    assert.equal(newer.closed, false);
    assert.equal(page.state()?.peerNonce, "nonce-2");
    assert.deepEqual(trackStates(page.captured[0]), ["live", "live"]);
    assert.equal(clock.pending(), 1);
  } finally {
    page.restore();
  }
});

test("matched-nonce cleanup closes a peer whose source search is still pending", async (t) => {
  const clock = fakeClock(t);
  const page = installPage(clock);
  page.showVideo(false);
  try {
    const pending = answer("nonce-1", Date.now() + 60_000);
    await flush();
    assert.equal(remoteBrowserCloseMediaPeerInPage("nonce-2"), false);
    assert.equal(FakePeer.created[0]?.closed, false);
    assert.equal(remoteBrowserCloseMediaPeerInPage("nonce-1"), true);
    assert.equal(FakePeer.created[0]?.closed, true);
    assert.equal(page.state()?.pc, undefined);
    page.showVideo(true);
    await clock.advance(250);
    const result = await pending;
    assert.equal(result.errorCode, "media_answer_failed");
    assert.equal(page.captured.length, 0);
    assert.equal(clock.pending(), 0);
  } finally {
    page.restore();
  }
});

test("a source that never appears reports media_source_missing and closes its own peer", async (t) => {
  const clock = fakeClock(t);
  const page = installPage(clock);
  page.showVideo(false);
  try {
    const pending = answer("nonce-1", Date.now() + 60_000);
    await flush();
    for (let elapsed = 0; elapsed < 5000; elapsed += 250) await clock.advance(250);
    const result = await pending;
    assert.equal(result.errorCode, "media_source_missing");
    assert.equal(FakePeer.created[0]?.closed, true);
    assert.equal(page.state()?.pc, undefined);
    assert.equal(clock.pending(), 0);
  } finally {
    page.restore();
  }
});

test("the deadline closes a peer still searching for its source", async (t) => {
  const clock = fakeClock(t);
  const page = installPage(clock);
  page.showVideo(false);
  try {
    const pending = answer("nonce-1", Date.now() + 1000);
    await flush();
    for (let elapsed = 0; elapsed < 1000; elapsed += 250) await clock.advance(250);
    const result = await pending;
    assert.equal(result.errorCode, "media_answer_failed");
    assert.equal(FakePeer.created[0]?.closed, true);
    assert.equal(page.state()?.pc, undefined);
    assert.equal(page.captured.length, 0);
    assert.equal(clock.pending(), 0);
  } finally {
    page.restore();
  }
});

test("cleanup stops only the tracks this peer captured, never a newer owner's", async (t) => {
  const page = installPage(fakeClock(t));
  try {
    const expiresAtMs = Date.now() + 60_000;
    assert.equal((await answer("nonce-1", expiresAtMs)).ok, true);
    assert.equal(remoteBrowserCloseMediaPeerInPage("nonce-1"), true);
    assert.deepEqual(trackStates(page.captured[0]), ["ended", "ended"]);
    assert.equal((await answer("nonce-2", expiresAtMs)).ok, true);
    assert.equal((await answer("nonce-3", expiresAtMs)).ok, true);
    // Displacement tears down the displaced peer with its own capture; stale cleanup leaves the newer one alone.
    assert.deepEqual(trackStates(page.captured[1]), ["ended", "ended"]);
    assert.equal(remoteBrowserCloseMediaPeerInPage("nonce-2"), false);
    assert.deepEqual(trackStates(page.captured[2]), ["live", "live"]);
    const failed = await answer("nonce-4", expiresAtMs, "reject");
    assert.equal(failed.errorCode, "media_answer_failed");
    assert.deepEqual(trackStates(page.captured[3]), ["ended", "ended"]);
  } finally {
    page.restore();
  }
});

test("a MediaStream-backed source keeps the page's own tracks live through cleanup", async (t) => {
  const page = installPage(fakeClock(t));
  try {
    page.video.srcObject = new FakeStream([]);
    assert.equal((await answer("nonce-1", Date.now() + 60_000)).ok, true);
    assert.equal(page.state()?.stream, undefined);
    assert.equal(remoteBrowserCloseMediaPeerInPage("nonce-1"), true);
    assert.equal(FakePeer.created[0]?.closed, true);
    assert.deepEqual(trackStates(page.captured[0]), ["live", "live"]);
  } finally {
    page.restore();
  }
});
