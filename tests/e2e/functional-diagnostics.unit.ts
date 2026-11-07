import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, readdir, stat, rm } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { collectedTransportFacts, finalizeFunctionalDiagnostics, guestSubscriptionFacts, mediaFacts, mediaParticipantFacts, observeFunctionalClient,
  observeGuestSubscriptionPoll, observeMeetingPanelPoll, installFunctionalBrowserObservation, readGuestSubscriptionSample, writeFunctionalDiagnostics } from "./functional-diagnostics.ts";

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
    const original = observation.start(() => observation.sample(() => { calls++; return evaluate.promise; }));
    assert.equal(original, evaluate.promise);
    const predicate = Promise.race([original.then(value => value.subscribed), timeout.promise]);
    time = 21000; timeout.reject(new Error("original predicate expired"));
    await assert.rejects(predicate, /original predicate expired/); observation.finish(false);
    assert.deepEqual(await readdir(root), []); // no filesystem work in the protected lifecycle
    await observation.flush();
    const [file] = await readdir(root), attachment = await readFile(`${root}/${file}`, "utf8");
    time = 21001;
    evaluate.resolve({ subscribed: 1, passiveStartupCompleted: true, videoElements: 1,
      url: "https://private/invite?session=secret", participantId: "private", sdp: "secret" });
    await original;
    observation.lifecycle("media_connected_passive", time); observation.finish(true);
    await observation.flush();
    await assert.rejects(predicate, /original predicate expired/);
    const raw = await readFile(`${root}/${file}`, "utf8"), rows = raw.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => row.event), ["poll-start", "sample-start", "predicate-finished", "sample-resolve", "passive-startup-report-observed"]);
    assert.equal(calls, 1); assert.equal(rows[0].configuredStartAtMs, 1000); assert.equal(rows[0].configuredDeadlineAtMs, 21000);
    assert.equal(rows[2].afterConfiguredDeadline, false); assert.equal(rows[3].afterConfiguredDeadline, true);
    assert.equal(rows[1].afterPredicateFinished, false); assert.equal(rows[3].afterPredicateFinished, true);
    assert.equal(rows[3].predicateFinishedAtMs, 21000);
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
  observation.start(() => {});
  const error = new Error("private native/session error"), rejected = Promise.reject(error);
  assert.equal(observation.sample(() => rejected), rejected);
  await assert.rejects(rejected, value => value === error);
  assert.throws(() => observation.sample(() => { throw error; }), value => value === error);
  for (let index = 0; index < 100; index++) await observation.sample(() => Promise.resolve({ subscribed: 0, passiveStartupCompleted: false }));
  for (let index = 0; index < 100; index++) observation.lifecycle("media_connected_passive", time);
  observation.lifecycle("private", time);
  time = 20000; observation.finish(false);
  assert.equal(rows.length, 0); await observation.flush();
  assert.equal(rows.length, 146); // start + 64 starts/results + 16 lifecycle + terminal
  assert.equal(rows.at(-1).omittedSamples, 38); assert.equal(rows.at(-1).afterConfiguredDeadline, false);
  assert.equal(rows[1].presenter, null); assert.equal(rows[2].event, "sample-reject");
  assert.doesNotMatch(JSON.stringify(rows), /private|native\/session/);
  assert.deepEqual(guestSubscriptionFacts(null), { subscribed: null, browserNowMs: null, browserWallTimeMs: null,
    browserTimeOriginMs: null, browserClockDomain: "browser:performance.now", mediaLifecycle: readGuestSubscriptionSample({ project: null }).mediaLifecycle,
    passiveStartupCompleted: null, passiveStartupFailed: null, shareErrorPresent: null, activeScreenPresent: null, surfaceHasTexture: null, videoElements: null });
  const facts = guestSubscriptionFacts({ subscribed: -1, browserNowMs: Infinity, browserWallTimeMs: NaN,
    passiveStartupCompleted: "private", passiveStartupFailed: false, videoElements: 999999, surfaceHasTexture: true, binding: "secret" });
  assert.equal(facts.subscribed, null); assert.equal(facts.browserNowMs, null); assert.equal(facts.passiveStartupCompleted, null);
  assert.equal(facts.passiveStartupFailed, false); assert.equal(facts.surfaceHasTexture, true); assert.equal(facts.videoElements, 1024);
});

test("Guest configured boundary begins at original expect invocation, not observation/preconstruction; sink failure is separate", async () => {
  let time = 0;
  const rows: any[] = [], observation = observeGuestSubscriptionPoll(2, row => rows.push(row), () => time);
  time = 3000; // construction/preparation is outside the configured poll budget
  let actualInvocationAtMs = 0;
  observation.start(() => { actualInvocationAtMs = time; });
  time = 23000;
  const value = { subscribed: 1 }, original = Promise.resolve(value);
  assert.equal(observation.sample(() => original), original); assert.equal(await original, value); observation.finish(true);
  assert.equal(rows.length, 0); await observation.flush();
  assert.equal(rows[0].configuredStartAtMs, actualInvocationAtMs); assert.equal(rows[0].configuredDeadlineAtMs, 23000);
  assert.equal(rows[0].clockBasis, "node-before-expect-poll-call"); assert.equal(rows[0].deadlineAtMs, undefined);
  assert.equal(rows.at(-1).outcome, "passed"); assert.equal(rows.at(-1).afterConfiguredDeadline, false);
  const broken = observeGuestSubscriptionPoll(1, () => { throw new Error("disk failure"); });
  assert.equal(broken.sample(() => original), original); await original; broken.finish(true);
  await assert.rejects(broken.flush(), /guest_subscription_diagnostic_persistence_failed/);
});

test("Guest slow sink cannot run before original evaluate, predicate consumer or next protected assertion", async () => {
  let sinkCalls = 0, calls = 0, consumerCalls = 0, protectedDone = false;
  const gate = deferred<void>(), rows: any[] = [];
  const observation = observeGuestSubscriptionPoll(1, row => {
    sinkCalls++; assert.equal(protectedDone, true);
    return gate.promise.then(() => { rows.push(row); });
  });
  assert.equal(sinkCalls, 0, "construction must not invoke the sink");
  observation.start(() => {});
  for (let index = 0; index < 2; index++) {
    const value = { subscribed: index }, original = Promise.resolve(value);
    const result = observation.sample(() => { calls++; assert.equal(sinkCalls, 0); return original; });
    assert.equal(result, original);
    await result.then(actual => { consumerCalls++; assert.equal(actual, value); assert.equal(sinkCalls, 0); });
  }
  observation.finish(true);
  await Promise.resolve(); // stand-in for the next protected assertion, not a diagnostic flush
  assert.equal(sinkCalls, 0); assert.equal(calls, 2); assert.equal(consumerCalls, 2);
  protectedDone = true;
  const flushed = observation.flush();
  await Promise.resolve(); assert.equal(sinkCalls, 1);
  gate.resolve(); await flushed;
  assert.equal(rows.length, 6); assert.equal(rows.at(-1).outcome, "passed");
});

test("Guest original evaluate runs without synchronous filesystem access, including the resolve reaction", async () => {
  const previous = process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR;
  const root = await mkdtemp("/tmp/opencode/guest-no-sync-unit-");
  process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR = root;
  const mkdirSync = fs.mkdirSync, appendFileSync = fs.appendFileSync;
  let syncCalls = 0, calls = 0;
  try {
    fs.mkdirSync = (() => { syncCalls++; throw new Error("sync mkdir in protected lifecycle"); }) as typeof fs.mkdirSync;
    fs.appendFileSync = (() => { syncCalls++; throw new Error("sync append in protected lifecycle"); }) as typeof fs.appendFileSync;
    syncBuiltinESMExports();
    const observation = observeGuestSubscriptionPoll(1);
    const original = observation.start(() => observation.sample(() => { calls++; assert.equal(syncCalls, 0); return Promise.resolve({ subscribed: 1 }); }));
    await original.then(value => { assert.equal(value.subscribed, 1); assert.equal(syncCalls, 0); });
    observation.finish(true);
    assert.equal(calls, 1); assert.equal(syncCalls, 0); assert.deepEqual(await readdir(root), []);
    await observation.flush(); assert.equal(syncCalls, 0);
    assert.equal((await readdir(root)).length, 1);
  } finally {
    fs.mkdirSync = mkdirSync; fs.appendFileSync = appendFileSync; syncBuiltinESMExports();
    if (previous === undefined) delete process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR;
    else process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR = previous;
    await rm(root, { recursive: true });
  }
});

test("Guest pending queue stays bounded with a stalled writer and 64 late promises; late true before configured deadline is not PASS", async () => {
  let time = 0, writes = 0;
  const gate = deferred<void>(), rows: any[] = [], evaluations = Array.from({ length: 100 }, () => deferred<any>());
  const observation = observeGuestSubscriptionPoll(1, async row => { writes++; await gate.promise; rows.push(row); }, () => time);
  observation.start(() => {});
  for (const evaluate of evaluations) assert.equal(observation.sample(() => evaluate.promise), evaluate.promise);
  for (let index = 0; index < 100; index++) observation.lifecycle("media_connected_passive", time);
  time = 100; observation.finish(false);
  const flushed = observation.flush(); await Promise.resolve(); assert.equal(writes, 1);
  time = 101;
  for (const evaluate of evaluations) evaluate.resolve({ subscribed: 1, token: "secret" });
  await Promise.all(evaluations.map(value => value.promise));
  observation.finish(true); assert.equal(writes, 1);
  gate.resolve(); await flushed;
  assert.equal(rows.length, 146); assert.equal(writes, 146);
  const finish = rows.find(row => row.event === "predicate-finished");
  assert.equal(finish.omittedSamples, 36); assert.equal(finish.attempts, 100);
  const late = rows.filter(row => row.event === "sample-resolve");
  assert.equal(late.length, 64);
  for (const row of late) {
    assert.equal(row.outcome, "failed"); assert.equal(row.afterPredicateFinished, true);
    assert.equal(row.predicateFinishedAtMs, 100); assert.equal(row.afterConfiguredDeadline, false);
  }
  assert.doesNotMatch(JSON.stringify(rows), /secret|token/);
});

test("Guest late result automatically persists after initial failure flush, with handled late output rejection", async () => {
  for (const broken of [false, true]) {
    const evaluate = deferred<any>(), lateWrite = deferred<void>(), rows: any[] = [];
    const observation = observeGuestSubscriptionPoll(1, row => {
      rows.push(row);
      if ((row as any).event === "sample-resolve") {
        lateWrite.resolve();
        if (broken) return Promise.reject(new Error("private late output error"));
      }
    });
    const original = observation.start(() => observation.sample(() => evaluate.promise));
    observation.finish(false); await observation.flush();
    assert.doesNotMatch(JSON.stringify(rows), /sample-resolve/); // failure attachment is already exported
    evaluate.resolve({ subscribed: 1 }); await original;
    await lateWrite.promise; // no second flush needed to initiate the late write
    assert.equal(rows.at(-1).outcome, "failed"); assert.equal(rows.at(-1).afterPredicateFinished, true);
    if (broken) await assert.rejects(observation.flush(), /guest_subscription_diagnostic_persistence_failed/);
    else await observation.flush();
  }
});

test("Guest without a configured file exports allowlisted console records only after the protected lifecycle", async context => {
  const previous = process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR;
  delete process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR;
  const messages: unknown[][] = [];
  context.mock.method(console, "warn", (...args: unknown[]) => { messages.push(args); });
  try {
    const observation = observeGuestSubscriptionPoll(1);
    const original = observation.start(() => observation.sample(() => Promise.resolve({ subscribed: 1, token: "secret" })));
    await original; observation.finish(true);
    assert.equal(messages.length, 0);
    await observation.flush();
    assert.equal(messages.length, 4); assert.equal(messages[0][0], "guest_subscription_diagnostic");
    assert.doesNotMatch(JSON.stringify(messages), /secret|token/);
  } finally {
    if (previous === undefined) delete process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR;
    else process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR = previous;
  }
});

test("Guest persistence errors surface only outside assertions; async failure/timeout are handled and cleanup detaches", async context => {
  const primary = new Error("original predicate failure"), seen: string[] = [];
  for (const sink of [() => { throw new Error("private output error"); }, async () => { throw new Error("private async error"); }]) {
    const observation = observeGuestSubscriptionPoll(1, sink);
    observation.start(() => {}); observation.finish(false);
    await assert.rejects((async () => {
      try { throw primary; }
      finally { try { await observation.flush(); } catch { seen.push("diagnostic-failure"); } }
    })(), error => error === primary);
    await assert.rejects(observation.flush(), /guest_subscription_diagnostic_persistence_failed/);
  }
  assert.equal(seen.length, 2);
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const stalled = deferred<void>(); let writes = 0;
  const observation = observeGuestSubscriptionPoll(1, () => { writes++; return stalled.promise; });
  observation.start(() => {}); observation.finish(true);
  const flushed = observation.flush(); await Promise.resolve();
  const rejected = assert.rejects(flushed, /guest_subscription_diagnostic_persistence_failed/);
  context.mock.timers.tick(5000); await rejected;
  stalled.resolve(); await stalled.promise; await Promise.resolve(); assert.equal(writes, 1);
  context.mock.timers.reset();

  const root = await mkdtemp("/tmp/opencode/guest-output-error-"), previous = process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR;
  await fs.promises.writeFile(`${root}/not-directory`, "occupied");
  process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR = `${root}/not-directory`;
  let detached = 0;
  const cdp = Object.assign(new EventEmitter(), { send: async () => ({}), detach: async () => { detached++; } });
  const page = Object.assign(new EventEmitter(), { context: () => ({ newCDPSession: async () => cdp }), addInitScript: async () => {}, isClosed: () => false });
  try {
    const client = await observeFunctionalClient(page as any), poll = client.observeGuestSubscription(1);
    await poll.start(() => poll.sample(() => Promise.resolve({ subscribed: 1 }))); poll.finish(true);
    await assert.rejects(client.close(), /guest_subscription_diagnostic_persistence_failed/);
    assert.equal(detached, 1); assert.equal(page.listenerCount("request"), 0);
    assert.equal(cdp.listenerCount("Network.webSocketFrameReceived"), 0);
  } finally {
    if (previous === undefined) delete process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR;
    else process.env.VRATA_FUNCTIONAL_DIAGNOSTICS_DIR = previous;
    await rm(root, { recursive: true });
  }
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
    poll.start(() => {});
    poll.finish(false);
    page.emit("request", request("media_connected_passive")); // after the predicate failed
    page.emit("request", request("private"));
    await poll.flush();
    const [file] = await readdir(root), raw = await readFile(`${root}/${file}`, "utf8");
    const rows = raw.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => row.event), ["passive-startup-report-observed", "poll-start", "predicate-finished", "passive-startup-report-observed"]);
    assert.equal(rows[0].configuredStartAtMs, null);
    assert.ok(rows[0].observedAtMs <= rows[0].atMs); assert.equal(rows[3].outcome, "failed");
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

function lifecycleFixture() {
  const generation = (id: number, relation = "attempt") => ({ generation: id, relation, createdAtMs: 1,
    invalidatedAtMs: null as number | null, invalidationReason: null as string | null,
    stages: Object.fromEntries(["connect", "devices", "install", "reconcile"].map(stage => [stage,
      { execution: null as number | null, status: "not-started", startedAtMs: null as number | null, completedAtMs: null as number | null }])) });
  return { schema: 1, clock: "performance.now", clockValid: true, observedAtMs: 100 as number | null,
    currentGeneration: 1 as number | null, latestGeneration: 2 as number | null, droppedGenerations: 0, droppedEvents: 0,
    generations: [generation(1, "current"), generation(2)], events: [] as any[] };
}

function compiledGuestEvaluator() {
  const source = fs.readFileSync(resolve("tests/e2e/functional-diagnostics.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const ast = ts.createSourceFile("compiled.js", compiled, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "readGuestSubscriptionSample");
  assert.ok(declaration);
  return declaration.getText(ast).replace(/^export /, "");
}

function evaluateGuest(debug: any, now = 100, evaluator = compiledGuestEvaluator()) {
  // Deliberately no imports, Node helpers, SDK, RTC, timers or network globals.
  return JSON.parse(JSON.stringify(runInNewContext(`(${evaluator})(undefined)`, {
    window: { __VRATA_DEBUG__: debug }, performance: { now: () => now, timeOrigin: 1_000_000 },
    Date: { now: () => 1_000_100 }, document: { querySelectorAll: () => [] }
  })));
}

test("compiled original Guest evaluator reads lifecycle getter once, preserves app count, and contains no imported closure", () => {
  let reads = 0;
  const lifecycle = lifecycleFixture(), debug = { screenShare: { remoteSubscribedTrackCount: 0 }, audioState: "connected-passive",
    get mediaLifecycle() { reads++; return lifecycle; },
    get nativePC() { throw new Error("must not inspect RTC or SDK"); } };
  const evaluator = compiledGuestEvaluator(), result = evaluateGuest(debug, 100, evaluator);
  assert.equal(reads, 1); assert.equal(result.subscribed, 0);
  assert.equal(result.browserNowMs, 100); assert.equal(result.browserTimeOriginMs, 1_000_000);
  assert.equal(result.mediaLifecycle.availability, "present");
  assert.equal(result.mediaLifecycle.selection, "current"); assert.equal(result.mediaLifecycle.summaryGeneration, 1);
  assert.equal(result.mediaLifecycle.latestGeneration, 2); // newer attempt is not installed
  debug.screenShare.remoteSubscribedTrackCount = 1;
  assert.equal(evaluateGuest(debug, 100, evaluator).subscribed, 1); assert.equal(reads, 2);
  assert.equal(evaluateGuest({}, 100, evaluator).mediaLifecycle.availability, "missing");
  const throwing = { screenShare: { remoteSubscribedTrackCount: 1 }, get mediaLifecycle() { throw new Error("private-token"); } };
  const bad = evaluateGuest(throwing, 100, evaluator);
  assert.equal(bad.subscribed, 1); assert.equal(bad.mediaLifecycle.availability, "invalid");
  assert.doesNotMatch(JSON.stringify(bad), /private-token/);
  assert.equal(evaluateGuest({ mediaLifecycle: { schema: 999 } }, 100, evaluator).mediaLifecycle.availability, "invalid");
});

test("Guest chooses current relation, retains invalidated history without claiming current or readiness", () => {
  const lifecycle = lifecycleFixture();
  lifecycle.currentGeneration = null;
  lifecycle.generations[0].relation = "invalidated"; lifecycle.generations[0].invalidatedAtMs = 80;
  lifecycle.generations[0].invalidationReason = "disconnected";
  let facts = guestSubscriptionFacts({ subscribed: 0, browserNowMs: 100, passiveStartupCompleted: true, mediaLifecycle: lifecycle });
  assert.equal(facts.mediaLifecycle.selection, "latest-history-no-current"); assert.equal(facts.mediaLifecycle.currentGeneration, null);
  assert.equal(facts.mediaLifecycle.generations[0].invalidationReason, "disconnected");
  lifecycle.generations[1].relation = "invalidated"; lifecycle.generations[1].invalidationReason = "failed";
  facts = guestSubscriptionFacts({ browserNowMs: 100, mediaLifecycle: lifecycle });
  assert.equal(facts.mediaLifecycle.selection, "latest-history-no-current");
  lifecycle.currentGeneration = 2; // corrupt/stale pointer cannot restore an invalidated generation
  facts = guestSubscriptionFacts({ browserNowMs: 100, mediaLifecycle: lifecycle });
  assert.equal(facts.mediaLifecycle.selection, "unknown");
  assert.doesNotMatch(JSON.stringify(facts), /"ready"|"passed"/);
});

test("Guest phase summary uses latest STARTED execution, never a stale completion from another execution/generation/stage", () => {
  const lifecycle = lifecycleFixture(), phase = lifecycle.generations[0].stages.install;
  Object.assign(phase, { execution: 2, status: "pending", startedAtMs: 80 });
  lifecycle.events.push({ generation: 1, execution: 1, relation: "current", atMs: 90, stage: "install", outcome: "succeeded", reason: null });
  const facts = () => guestSubscriptionFacts({ browserNowMs: 100, mediaLifecycle: lifecycle }).mediaLifecycle.generations[0].stages.install;
  assert.equal(facts().atSample, "pending-at-sample"); assert.equal(facts().matchingCompletionEventAtMs, null);
  Object.assign(phase, { status: "failed", completedAtMs: 95 });
  assert.equal(facts().atSample, "unknown");
  const completion = { generation: 1, execution: 2, relation: "current", atMs: 95, stage: "install", outcome: "failed", reason: null };
  lifecycle.events.push({ ...completion, generation: 2 }, { ...completion, stage: "connect" });
  assert.equal(facts().atSample, "unknown");
  lifecycle.events.push(completion);
  assert.equal(facts().atSample, "completed-before-or-at-sample"); assert.equal(facts().status, "failed");
  assert.equal(facts().execution, 2); assert.equal(facts().matchingCompletionEventAtMs, 95);
  lifecycle.events.push({ ...completion, execution: 1, outcome: "succeeded", atMs: 99 });
  assert.equal(facts().status, "failed"); assert.equal(facts().matchingCompletionEventAtMs, 95);
});

test("Guest browser-clock boundaries, null/exhausted ordinals and lost history stay explicit uncertainty", () => {
  const cases = [
    { time: 99, expected: "completed-before-or-at-sample" }, { time: 100, expected: "completed-before-or-at-sample" },
    { time: 101, expected: "unknown" }, { time: null, expected: "unknown" }, { time: Infinity, expected: "unknown" },
    { time: 99, clockValid: false, expected: "unknown" }, { time: 99, observed: null, expected: "unknown" },
    { time: 99, observed: 101, expected: "unknown" }, { time: 99, browser: null, expected: "unknown" },
    { time: 99, execution: null, expected: "unknown" }, { time: 99, execution: Number.MAX_SAFE_INTEGER + 1, expected: "unknown" },
    { time: 99, execution: Number.MAX_SAFE_INTEGER, expected: "completed-before-or-at-sample" },
    { time: 99, droppedEvents: 1, expected: "unknown" }, { time: 99, droppedGenerations: 1, expected: "unknown" }
  ];
  for (const c of cases) {
    const lifecycle = lifecycleFixture(), execution = "execution" in c ? c.execution : 1;
    Object.assign(lifecycle.generations[0].stages.connect, { execution, status: "succeeded", startedAtMs: 10, completedAtMs: c.time });
    Object.assign(lifecycle, { clockValid: c.clockValid ?? true, observedAtMs: "observed" in c ? c.observed : 100,
      droppedEvents: c.droppedEvents ?? 0, droppedGenerations: c.droppedGenerations ?? 0 });
    lifecycle.events.push({ generation: 1, execution, relation: "attempt", atMs: c.time, stage: "connect", outcome: "succeeded", reason: null });
    const result = guestSubscriptionFacts({ browserNowMs: "browser" in c ? c.browser : 100, mediaLifecycle: lifecycle }).mediaLifecycle;
    assert.equal(result.generations[0].stages.connect.atSample, c.expected, JSON.stringify(c));
    assert.equal(result.historyComplete, !c.droppedEvents && !c.droppedGenerations);
  }
});

test("Guest lifecycle projection deep-copies strict allowlists with finite bounds and safe verdict reasons", () => {
  const lifecycle: any = lifecycleFixture();
  lifecycle.events.push({ generation: 1, execution: null, relation: "current", atMs: 90, stage: "screen-share-sdk-attach", outcome: "accepted", reason: "returned",
    participantId: "private-person", url: "https://private", token: "secret" });
  lifecycle.events.push({ generation: 1, execution: null, relation: "current", atMs: 91, stage: "screen-share-attach", outcome: "accepted", reason: "registered" });
  const value = { browserNowMs: 100, mediaLifecycle: lifecycle };
  const original = guestSubscriptionFacts(value);
  lifecycle.events[0].reason = "threw"; lifecycle.generations[0].stages.connect.status = "failed";
  assert.equal(original.mediaLifecycle.events[0].reason, "returned");
  assert.equal(original.mediaLifecycle.generations[0].stages.connect.status, "not-started");
  assert.doesNotMatch(JSON.stringify(original), /private|secret|participantId|token|https|"ready"/);
  lifecycle.events[0].reason = "private-error-token";
  let projected = guestSubscriptionFacts(value).mediaLifecycle;
  assert.equal(projected.availability, "invalid"); assert.equal(projected.events[0].reason, null);
  assert.equal(projected.generations[0].stages.install.atSample, "unknown");
  lifecycle.generations = Array(20).fill(lifecycle.generations[0]); lifecycle.events = Array(100).fill(lifecycle.events[0]);
  projected = guestSubscriptionFacts(value).mediaLifecycle;
  assert.equal(projected.generations.length, 8); assert.equal(projected.events.length, 64);
  assert.equal(projected.projectionDroppedGenerations, 12); assert.equal(projected.projectionDroppedEvents, 36);
  assert.equal(projected.availability, "invalid"); assert.equal(projected.historyComplete, false);
  for (const broken of [false, "private", { schema: 1, clock: "performance.now" }, { get schema() { throw new Error("secret"); } }]) {
    const facts = guestSubscriptionFacts({ subscribed: 1, mediaLifecycle: broken });
    assert.equal(facts.subscribed, 1); assert.equal(facts.mediaLifecycle.availability, "invalid");
    assert.doesNotMatch(JSON.stringify(facts), /private|secret/);
  }
});

test("actual F1 callsite serializes the standalone evaluator in its SAME original count1/20s poll promise", async () => {
  const spec = fs.readFileSync(resolve("tests/e2e/media-source-grants.spec.ts"), "utf8");
  const ast = ts.createSourceFile("spec.ts", spec, ts.ScriptTarget.ES2022, true);
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(ast) === "guestPoll.start") calls.push(node); ts.forEachChild(node, visit); };
  visit(ast); assert.equal(calls.length, 1);
  const source = calls[0].getText(ast);
  assert.equal((source.match(/\.evaluate\(/g) ?? []).length, 1); assert.doesNotMatch(source, /intervals|flush|mediaLifecycle|await/);
  const evaluator = compiledGuestEvaluator(), lifecycle = lifecycleFixture();
  let reads = 0, evaluations = 0, sinkCalls = 0, protectedDone = false, original: Promise<any> | null = null;
  const rows: any[] = [], gate = deferred<void>();
  const guestPoll = observeGuestSubscriptionPoll(1, async row => { sinkCalls++; assert.equal(protectedDone, true); await gate.promise; rows.push(row); });
  const debug = { screenShare: { remoteSubscribedTrackCount: 1 }, get mediaLifecycle() { reads++; return lifecycle; } };
  const invocation = runInNewContext(source, { guestPoll, readGuestSubscriptionSample,
    guest: { page: { evaluate: (fn: unknown) => { assert.equal(fn, readGuestSubscriptionSample); evaluations++; original = Promise.resolve(evaluateGuest(debug, 100, evaluator)); return original; } } },
    expect: { poll: (predicate: () => Promise<number>, options: any) => {
      assert.deepEqual(JSON.parse(JSON.stringify(options)), { timeout: 20_000 });
      return { toBe: async (expected: number) => { assert.equal(expected, 1); assert.equal(await predicate(), 1); assert.equal(sinkCalls, 0); } };
    } } });
  await invocation; guestPoll.finish(true);
  await Promise.resolve(); // following protected assertion, not an earlier diagnostic flush
  assert.equal(sinkCalls, 0); assert.equal(evaluations, 1); assert.equal(reads, 1); assert.ok(original);
  protectedDone = true;
  const flushed = guestPoll.flush(); await Promise.resolve(); assert.equal(sinkCalls, 1); gate.resolve(); await flushed;
  assert.equal(rows.find(row => row.event === "sample-resolve").facts.mediaLifecycle.summaryGeneration, 1);
  assert.equal(rows.at(-1).outcome, "passed");
});

test("Guest Node sample interval only brackets configured boundary; browser-clock lifecycle cannot turn late failure into PASS", async () => {
  for (const [start, end, expected] of [[1000, 20999, "before-or-at-configured-deadline"], [21000, 21000, "before-or-at-configured-deadline"],
    [20999, 21001, "unknown"], [21001, 21002, "after-configured-deadline"], [1000, 999, "unknown"]] as const) {
    let time = 1000;
    const rows: any[] = [], pending = deferred<any>(), deadline = deferred<never>();
    const observer = observeGuestSubscriptionPoll(1, row => rows.push(row), () => time);
    observer.start(() => {}); time = start;
    const original = observer.sample(() => pending.promise); assert.equal(original, pending.promise);
    const predicate = Promise.race([original.then(value => value.subscribed), deadline.promise]);
    deadline.reject(new Error("primary configured predicate failure")); await assert.rejects(predicate, /primary/);
    observer.finish(false); time = end;
    pending.resolve(evaluateGuest({ screenShare: { remoteSubscribedTrackCount: 1 }, mediaLifecycle: lifecycleFixture() }, 100)); await original;
    assert.equal(rows.length, 0); await observer.flush();
    const resolved = rows.find(row => row.event === "sample-resolve");
    assert.equal(resolved.sampleWindowVsConfiguredDeadline, expected); assert.equal(resolved.sampleStartedAtMs, start); assert.equal(resolved.sampleResolvedAtMs, end);
    assert.equal(resolved.clockDomain, "node:Date.now"); assert.equal(resolved.facts.browserClockDomain, "browser:performance.now");
    assert.equal(resolved.outcome, "failed"); assert.equal(resolved.afterPredicateFinished, true);
    assert.equal(resolved.facts.browserNowMs, 100); assert.equal(resolved.facts.mediaLifecycle.availability, "present");
    assert.equal(resolved.deadlineAtMs, undefined); await assert.rejects(predicate, /primary/);
  }
});
