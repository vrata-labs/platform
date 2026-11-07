import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, stat, rm } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { collectedTransportFacts, finalizeFunctionalDiagnostics, guestSubscriptionFacts, mediaFacts, mediaParticipantFacts, observeFunctionalClient,
  observeGuestSubscriptionPoll, observeMeetingPanelPoll, installFunctionalBrowserObservation, writeFunctionalDiagnostics } from "./functional-diagnostics.ts";

test("media diagnostics correlate object/track/revision without retaining content or owner IDs", () => {
  const media = { surfaces: { wall: { surfaceId: "whiteboard-wall", activeObjectId: "object-private", textureId: 3 } },
    objects: { one: { objectId: "object-private", ownerParticipantId: "owner-private", surfaceId: "whiteboard-wall", revision: 4,
      type: "markdown-board", state: { status: "active", notes: [{ text: "private-note" }, {}], mediaTrackSid: "track-private", config: "secret-config" } } } };
  const facts = mediaFacts(media);
  assert.equal(facts.surfaces[0].object, facts.objects[0].object);
  assert.equal(facts.objects[0].notes, 2); assert.equal(facts.objects[0].revision, 4);
  assert.equal(facts.surfaces[0].hasTexture, true);
  assert.doesNotMatch(JSON.stringify(facts), /private|secret-config/);
  assert.deepEqual(mediaFacts(null), { surfaces: [], objects: [] });
});

test("server media bindings and object tracks share pseudonyms without raw attributes", () => {
  const participants = mediaParticipantFacts([{ identity: "identity-private", attributes: {
    vrataMediaBinding: JSON.stringify({ participantId: "participant-private", scope: "ms", token: "never-copy" }) },
    tracks: [{ sid: "track-private", source: 3, type: 1, muted: false }] }]);
  const media = mediaFacts({ objects: [{ state: { mediaTrackSid: "track-private" } }] });
  assert.equal(participants[0].tracks[0].track, media.objects[0].track);
  assert.equal(participants[0].scope, "ms");
  assert.doesNotMatch(JSON.stringify(participants), /private|never-copy|vrataMediaBinding/);
});

test("passive transport observation correlates sent target and ACK, without retaining the socket URL or payload", async () => {
  const cdp = Object.assign(new EventEmitter(), { send: async () => ({}), detach: async () => {} });
  const page = Object.assign(new EventEmitter(), { context: () => ({ newCDPSession: async () => cdp }),
    addInitScript: async () => {}, evaluate: async () => ({}), isClosed: () => false });
  const observation = await observeFunctionalClient(page as any);
  try {
    cdp.emit("Network.webSocketCreated", { requestId: "one", url: "ws://private.invalid/?roomId=room&accessToken=secret-proof" });
    const frame = (message: unknown) => ({ requestId: "one", response: { opcode: 1, payloadData: JSON.stringify(message) } });
    cdp.emit("Network.webSocketFrameSent", frame({ type: "surface_patch_object_state", commandId: "command-private", objectId: "object-private",
      surfaceId: "whiteboard-wall", expectedRevision: 1, patch: { type: "add-note", text: "private-colleague-note" } }));
    cdp.emit("Network.webSocketFrameReceived", frame({ type: "surface_command_result", result: { commandId: "command-private", accepted: true,
      objectId: "object-private", surfaceId: "whiteboard-wall", revision: 2 } }));
    const facts = await observation.snapshot(), commands = facts.events.filter((event: any) => event.kind === "command");
    assert.equal(commands.length, 2); assert.equal(commands[0].command, commands[1].command);
    assert.equal(commands[0].object, commands[1].object); assert.equal(commands[1].revision, 2);
    assert.equal(commands[1].accepted, true);
    assert.doesNotMatch(JSON.stringify(facts), /private|secret-proof|accessToken|payloadData/);
  } finally { await observation.close(); }
  assert.equal(cdp.listenerCount("Network.webSocketFrameReceived"), 0);
  assert.equal(page.listenerCount("response"), 0);
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("original panel evaluate late answer is logged after failure snapshot, never makes the predicate pass", async () => {
  const root = await mkdtemp("/tmp/opencode/panel-observation-unit-");
  const previous = process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR;
  process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR = root;
  try {
    let time = 100, calls = 0;
    const observation = observeMeetingPanelPoll({ actor: "member-2", section: "present", touch: false }, undefined, () => time++);
    const evaluate = deferred<any>(), deadline = deferred<never>();
    const original = observation.sample(() => { calls++; return evaluate.promise; });
    assert.equal(original, evaluate.promise);
    const assertion = Promise.race([original, deadline.promise]);
    deadline.reject(new Error("original 5s predicate deadline"));
    await assert.rejects(assertion, /original 5s/);
    observation.finish(false);
    const [file] = await readdir(root), attachment = await readFile(`${root}/${file}`, "utf8");
    evaluate.resolve({ open: true, focused: true, headingBelowNavigation: true, targetWideEnough: true, targetTallEnough: true,
      url: "https://private.invalid/invite?session=secret", headers: "private" });
    await original;
    await assert.rejects(assertion, /original 5s/); // late true cannot change the assertion outcome
    const raw = await readFile(`${root}/${file}`, "utf8"), rows = raw.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(calls, 1); assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(row => row.event), ["start", "predicate-finished", "resolve"]);
    assert.equal(rows[2].outcome, "failed"); assert.equal(rows[2].actor, "member-2");
    assert.equal(rows[2].section, "present"); assert.equal(rows[2].touch, false);
    assert.deepEqual(rows[2].booleans, { open: true, focused: true, headingBelowNavigation: true, targetWideEnough: true, targetTallEnough: true });
    assert.ok(rows[2].atMs > rows[2].startedAtMs);
    assert.doesNotMatch(attachment, /resolve/); assert.doesNotMatch(raw, /private|secret|https|headers/);
    assert.equal((await stat(`${root}/${file}`)).mode & 0o777, 0o600);
  } finally {
    if (previous === undefined) delete process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR;
    else process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR = previous;
    await rm(root, { recursive: true }); // only this test's mkdtemp directory
  }
});

test("panel observation preserves rejection, sanitizes labels/booleans and bounds the log", async () => {
  const rows: any[] = [];
  const observation = observeMeetingPanelPoll({ actor: "private-person", section: "https://private.invalid", touch: true }, row => rows.push(row));
  const failure = new Error("secret-header/session/invite");
  const rejected = Promise.reject(failure);
  assert.equal(observation.sample(() => rejected), rejected);
  await assert.rejects(rejected, error => error === failure);
  for (let index = 0; index < 100; index++) await observation.sample(() => Promise.resolve({ open: "private" }));
  observation.finish(false);
  assert.equal(rows.length, 128);
  assert.equal(rows[1].event, "reject");
  assert.equal(rows[0].actor, "unspecified"); assert.equal(rows[0].section, "other");
  assert.deepEqual(rows[3].booleans, { open: null, focused: null, headingBelowNavigation: null, targetWideEnough: null, targetTallEnough: null });
  assert.doesNotMatch(JSON.stringify(rows), /private|secret|invite|session|header/);
});

function browserObservation(enabled = true) {
  const pending = deferred<any>(), timers = new Set<() => void>();
  let time = 0;
  class Peer extends EventEmitter {
    connectionState = "connecting"; iceConnectionState = "checking"; signalingState = "stable"; statsCalls = 0;
    constructor(..._args: any[]) { super(); }
    addEventListener(event: string, listener: () => void) { this.on(event, listener); }
    getStats() { this.statsCalls++; return pending.promise; }
  }
  const window: any = { RTCPeerConnection: Peer };
  runInNewContext(`(${installFunctionalBrowserObservation.toString()})(${enabled})`, {
    window, performance: { now: () => ++time },
    setTimeout: (callback: () => void) => { timers.add(callback); return callback; },
    clearTimeout: (callback: () => void) => timers.delete(callback)
  });
  return { window, pending, timers, peer: () => new window.RTCPeerConnection(),
    facts: () => JSON.parse(JSON.stringify({ events: window.__functionalObservation.events, peers: window.__functionalObservation.peerConnections })) };
}

test("first ICE connected requests exactly one bounded native transport sample, no raw RTC fields", async () => {
  const browser = browserObservation(), peer = browser.peer();
  peer.emit("iceconnectionstatechange"); assert.equal(peer.statsCalls, 0);
  peer.iceConnectionState = "connected";
  peer.emit("iceconnectionstatechange"); peer.emit("iceconnectionstatechange");
  assert.equal(peer.statsCalls, 1);
  assert.equal(browser.facts().peers[0].pcConnectedAtMs, null);
  const report = new Map<string, any>([["private-pair-id", { type: "candidate-pair", state: "succeeded", nominated: true,
    bytesSent: 120, bytesReceived: 240, localCandidateId: "private-ip", remoteCandidateId: "private-ip", certificate: "secret" }],
    ["candidate", { type: "local-candidate", address: "private-ip", candidate: "secret-sdp" }]]);
  for (let index = 0; index < 8; index++) report.set(`transport-${index}`, { type: "transport", dtlsState: index ? "secret" : "connecting",
    selectedCandidatePairId: "private-pair-id", localCertificateId: "secret-certificate", sdp: "secret" });
  browser.pending.resolve(report); await browser.pending.promise;
  const sample = browser.facts().peers[0].transportSample;
  assert.equal(sample.status, "resolved"); assert.equal(sample.transports.length, 4);
  assert.equal(sample.connectionAtStart, "connecting"); assert.equal(sample.iceAtStart, "connected");
  assert.equal(sample.transports[0].dtlsState, "connecting"); assert.equal(sample.transports[1].dtlsState, null);
  assert.deepEqual(sample.transports[0].selectedPair, { type: "candidate-pair", state: "succeeded", nominated: true, bytesSent: 120, bytesReceived: 240 });
  assert.ok(sample.startedAtMs >= browser.facts().peers[0].firstIceConnectedAtMs);
  assert.ok(sample.resolvedAtMs > sample.startedAtMs);
  peer.connectionState = "connected"; peer.emit("connectionstatechange");
  const connectedAt = browser.facts().peers[0].pcConnectedAtMs;
  peer.emit("connectionstatechange"); assert.equal(browser.facts().peers[0].pcConnectedAtMs, connectedAt);
  peer.iceConnectionState = "disconnected"; peer.emit("iceconnectionstatechange");
  peer.iceConnectionState = "connected"; peer.emit("iceconnectionstatechange"); assert.equal(peer.statsCalls, 1);
  assert.equal(browser.timers.size, 0);
  assert.doesNotMatch(JSON.stringify(browser.facts()), /private|secret|address|Certificate|sdp|CandidateId/);
  for (let index = 0; index < 20; index++) {
    const extra = browser.peer(); extra.iceConnectionState = "connected"; extra.emit("iceconnectionstatechange");
    if (index >= 15) assert.equal(extra.statsCalls, 0);
  }
  assert.equal(browser.facts().peers.length, 16);
  for (const expire of [...browser.timers]) expire();
});

test("transport sample timeout/rejection never retries, and other scenarios do not request it", async () => {
  for (const reject of [false, true]) {
    const browser = browserObservation(), peer = browser.peer();
    peer.iceConnectionState = "connected"; peer.emit("iceconnectionstatechange");
    if (reject) browser.pending.reject(new Error("private-native-error"));
    else for (const expire of [...browser.timers]) expire();
    await Promise.resolve();
    assert.equal(browser.facts().peers[0].transportSample.status, reject ? "rejected" : "timed-out");
    if (!reject) { browser.pending.resolve(new Map()); await browser.pending.promise; }
    peer.emit("iceconnectionstatechange"); assert.equal(peer.statsCalls, 1);
    assert.equal(browser.facts().events.filter((row: any) => row.kind === "rtc-transport-result").length, 1);
    assert.doesNotMatch(JSON.stringify(browser.facts()), /private-native-error/);
  }
  const disabled = browserObservation(false), peer = disabled.peer();
  peer.iceConnectionState = "connected"; peer.emit("iceconnectionstatechange");
  assert.equal(peer.statsCalls, 0); assert.equal(disabled.timers.size, 0);
});

test("original Guest 20s predicate retains late true after failure independently, with private Node records", async () => {
  const root = await mkdtemp("/tmp/opencode/guest-poll-unit-"), previous = process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR;
  process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR = root;
  try {
    let time = 1000, calls = 0;
    const observation = observeGuestSubscriptionPoll(1, undefined, () => time);
    const evaluate = deferred<any>(), timeout = deferred<never>();
    const original = observation.sample(() => { calls++; return evaluate.promise; });
    assert.equal(original, evaluate.promise);
    const predicate = Promise.race([original.then(value => value.subscribed), timeout.promise]);
    time = 21000; timeout.reject(new Error("original predicate expired"));
    await assert.rejects(predicate, /original predicate expired/); observation.finish(false);
    const [file] = await readdir(root), attachment = await readFile(`${root}/${file}`, "utf8");
    time = 21001;
    evaluate.resolve({ subscribed: 1, passiveStartupCompleted: true, videoElements: 1,
      url: "https://private/invite?session=secret", participantId: "private", sdp: "secret" });
    await original;
    observation.lifecycle("media_connected_passive", time); observation.finish(true);
    await assert.rejects(predicate, /original predicate expired/);
    const raw = await readFile(`${root}/${file}`, "utf8"), rows = raw.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => row.event), ["poll-start", "sample-start", "predicate-finished", "sample-resolve", "passive-startup-report-observed"]);
    assert.equal(calls, 1); assert.equal(rows[0].startedAtMs, 1000); assert.equal(rows[0].deadlineAtMs, 21000);
    assert.equal(rows[2].afterDeadline, false); assert.equal(rows[3].afterDeadline, true);
    assert.equal(rows[3].outcome, "failed"); assert.equal(rows[3].facts.subscribed, 1);
    assert.equal(rows[3].facts.passiveStartupCompleted, true); assert.equal(rows[4].outcome, "failed");
    assert.doesNotMatch(attachment, /sample-resolve/); assert.doesNotMatch(raw, /private|secret|invite|session|sdp|participantId/);
    assert.equal((await stat(`${root}/${file}`)).mode & 0o777, 0o600);
  } finally {
    if (previous === undefined) delete process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR;
    else process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR = previous;
    await rm(root, { recursive: true });
  }
});

test("Guest samples preserve raw result/rejection, do not infer installation from negative/absent data, and bound records", async () => {
  let time = 0;
  const rows: any[] = [], observation = observeGuestSubscriptionPoll(999, row => rows.push(row), () => time);
  const error = new Error("private native/session error"), rejected = Promise.reject(error);
  assert.equal(observation.sample(() => rejected), rejected);
  await assert.rejects(rejected, value => value === error);
  assert.throws(() => observation.sample(() => { throw error; }), value => value === error);
  for (let index = 0; index < 100; index++) await observation.sample(() => Promise.resolve({ subscribed: 0, passiveStartupCompleted: false }));
  for (let index = 0; index < 100; index++) observation.lifecycle("media_connected_passive", time);
  observation.lifecycle("private", time);
  time = 20000; observation.finish(false);
  assert.equal(rows.length, 146); // start + 64 starts/results + 16 lifecycle + terminal
  assert.equal(rows.at(-1).omittedSamples, 38); assert.equal(rows.at(-1).afterDeadline, false);
  assert.equal(rows[1].presenter, null); assert.equal(rows[2].event, "sample-reject");
  assert.doesNotMatch(JSON.stringify(rows), /private|native\/session/);
  assert.deepEqual(guestSubscriptionFacts(null), { subscribed: null, browserNowMs: null, browserWallTimeMs: null,
    passiveStartupCompleted: null, passiveStartupFailed: null, shareErrorPresent: null, activeScreenPresent: null, surfaceHasTexture: null, videoElements: null });
  const facts = guestSubscriptionFacts({ subscribed: -1, browserNowMs: Infinity, browserWallTimeMs: NaN,
    passiveStartupCompleted: "private", passiveStartupFailed: false, videoElements: 999999, surfaceHasTexture: true, binding: "secret" });
  assert.equal(facts.subscribed, null); assert.equal(facts.browserNowMs, null); assert.equal(facts.passiveStartupCompleted, null);
  assert.equal(facts.passiveStartupFailed, false); assert.equal(facts.surfaceHasTexture, true); assert.equal(facts.videoElements, 1024);
});

test("Guest original success at the configured deadline remains success; diagnostic sink errors never replace result", async () => {
  let time = 0;
  const rows: any[] = [], observation = observeGuestSubscriptionPoll(2, row => rows.push(row), () => time);
  time = 20000;
  const value = { subscribed: 1 }, original = Promise.resolve(value);
  assert.equal(observation.sample(() => original), original); assert.equal(await original, value); observation.finish(true);
  assert.equal(rows.at(-1).outcome, "passed"); assert.equal(rows.at(-1).afterDeadline, false);
  const broken = observeGuestSubscriptionPoll(1, () => { throw new Error("disk failure"); });
  assert.equal(broken.sample(() => original), original); await original; broken.finish(true);
});

test("existing diagnostic request receipt is correlated with the Guest poll, not treated as an exact install timestamp", async () => {
  const root = await mkdtemp("/tmp/opencode/guest-lifecycle-unit-"), previous = process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR;
  process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR = root;
  const cdp = Object.assign(new EventEmitter(), { send: async () => ({}), detach: async () => {} });
  const page = Object.assign(new EventEmitter(), { context: () => ({ newCDPSession: async () => cdp }),
    addInitScript: async () => {}, evaluate: async () => ({}), isClosed: () => false });
  const observation = await observeFunctionalClient(page as any);
  try {
    const request = (note: string) => ({ method: () => "POST", url: () => "http://private/api/rooms/private/diagnostics",
      postDataJSON: () => ({ note, participantId: "private", authorization: "secret" }) });
    page.emit("request", request("media_connected_passive")); // before the original poll
    const poll = observation.observeGuestSubscription(1);
    poll.finish(false);
    page.emit("request", request("media_connected_passive")); // after the predicate failed
    page.emit("request", request("private"));
    const [file] = await readdir(root), raw = await readFile(`${root}/${file}`, "utf8");
    const rows = raw.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => row.event), ["poll-start", "passive-startup-report-observed", "predicate-finished", "passive-startup-report-observed"]);
    assert.ok(rows[1].observedAtMs <= rows[1].atMs); assert.equal(rows[3].outcome, "failed");
    assert.doesNotMatch(raw, /private|secret|authorization|participantId|http/);
  } finally {
    await observation.close(); assert.equal(page.listenerCount("request"), 0);
    if (previous === undefined) delete process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR;
    else process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR = previous;
    await rm(root, { recursive: true });
  }
});

test("F7 exports already collected one-shot transport outcomes, with bounds/redaction and no extra getStats", async () => {
  const browser = browserObservation(), peer = browser.peer();
  peer.iceConnectionState = "connected"; peer.emit("iceconnectionstatechange");
  browser.pending.resolve(new Map([["transport", { type: "transport", dtlsState: "connected" }]])); await browser.pending.promise;
  const cdp = Object.assign(new EventEmitter(), { send: async () => ({}), detach: async () => {} });
  let evaluates = 0;
  const page = Object.assign(new EventEmitter(), { context: () => ({ newCDPSession: async () => cdp }), addInitScript: async () => {},
    evaluate: async () => { evaluates++; return { peerConnections: browser.facts().peers }; }, isClosed: () => false });
  const observation = await observeFunctionalClient(page as any);
  try {
    const facts = await observation.collectedTransportSnapshot();
    assert.equal(facts.peerConnections[0].transportSample.status, "resolved");
    assert.equal(facts.peerConnections[0].transportSample.transports[0].dtlsState, "connected");
    assert.equal(peer.statsCalls, 1); assert.equal(evaluates, 1);
  } finally { await observation.close(); }
  const privateTransport = { dtlsState: "private", selectedPair: { state: "succeeded", nominated: true, bytesReceived: 12,
    localCandidateId: "private-ip", sdp: "secret", certificate: "secret" } };
  const projected = collectedTransportFacts({ peerConnections: Array.from({ length: 20 }, () => ({ index: "private", transportSample: {
    status: "resolved", transports: Array(8).fill(privateTransport), token: "secret" } })), events: ["secret"], url: "private" });
  assert.equal(projected.peerConnections.length, 16); assert.equal(projected.peerConnections[0].transportSample.transports.length, 4);
  assert.equal(projected.peerConnections[0].transportSample.transports[0].dtlsState, null);
  assert.doesNotMatch(JSON.stringify(projected), /private|secret|Candidate|certificate|sdp|token|url/);
  assert.deepEqual(collectedTransportFacts(null).peerConnections, []);
});

test("F7 success and primary-failure branches export once before cleanup; export/cleanup errors cannot hide primary failure", async () => {
  for (const failed of [false, true]) {
    const events: string[] = [];
    await finalizeFunctionalDiagnostics(failed, async () => { events.push("export"); }, async () => { events.push("close"); });
    assert.deepEqual(events, ["export", "close"]);
  }
  const primary = new Error("primary"), cleanup = new Error("cleanup");
  let closes = 0;
  async function scenario() {
    try { throw primary; }
    finally {
      await finalizeFunctionalDiagnostics(true, async () => { throw new Error("export"); }, async () => { closes++; throw cleanup; });
    }
  }
  await assert.rejects(scenario(), error => error === primary); assert.equal(closes, 1);
  await assert.rejects(finalizeFunctionalDiagnostics(false, async () => {}, async () => { throw cleanup; }), error => error === cleanup);
});

test("F7 pending export has a finite bound and still cleans up once without retry", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred<void>(); let writes = 0, closes = 0;
  const done = finalizeFunctionalDiagnostics(false, () => { writes++; return pending.promise; }, async () => { closes++; });
  await Promise.resolve(); context.mock.timers.tick(5000); await done;
  assert.equal(writes, 1); assert.equal(closes, 1);
  pending.resolve(); await pending.promise; assert.equal(writes, 1); assert.equal(closes, 1);
});

test("F7 success and failure collected DTO exports are private files written before cleanup", async () => {
  const root = await mkdtemp("/tmp/opencode/native-export-unit-"), previous = process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR;
  process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR = root;
  try {
    for (const failed of [false, true]) {
      let closed = false;
      await finalizeFunctionalDiagnostics(failed, async () => {
        assert.equal(closed, false);
        await writeFunctionalDiagnostics("F7-before-cleanup", { outcome: failed ? "failed" : "passed", clients: [collectedTransportFacts(null)] });
      }, async () => { closed = true; });
      assert.equal(closed, true);
    }
    const files = await readdir(root), outcomes: string[] = [];
    assert.equal(files.length, 2);
    for (const file of files) {
      const value = JSON.parse(await readFile(`${root}/${file}`, "utf8")); outcomes.push(value.facts.outcome);
      assert.equal((await stat(`${root}/${file}`)).mode & 0o777, 0o600);
    }
    assert.deepEqual(outcomes.sort(), ["failed", "passed"]);
  } finally {
    if (previous === undefined) delete process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR;
    else process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR = previous;
    await rm(root, { recursive: true });
  }
});
