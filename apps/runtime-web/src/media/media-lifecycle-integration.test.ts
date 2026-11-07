import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createMediaLifecycleDiagnostics } from "./media-lifecycle-diagnostics.js";

// Execute the actual composition-root callsites with inert SDK/render dependencies.
// The regular tsc + runtime test path builds and discovers these tests.
const source = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
function declaration(name: string): string {
  const node = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name
    || ts.isVariableStatement(statement) && statement.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === name));
  assert.ok(node, `missing runtime integration ${name}`);
  return node.getText(ast);
}
function load<T>(name: string, context: Record<string, unknown>, also: string[] = []): T {
  const text = [...also, name].map(declaration).join("\n") + `\nglobalThis.result = ${name};`;
  runInNewContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context);
  return context.result as T;
}
function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
type Room = { connect(...args: unknown[]): Promise<void>; disconnect(): Promise<void> };
type Connection = { create(): Room; connect(room: Room, plan?: unknown): Promise<void>; cleanupFailed(room: Room): Promise<void> };
function fixture(upgrade = false) {
  let now = 10;
  const mediaLifecycle = createMediaLifecycleDiagnostics(true, () => now);
  const connect = deferred(), devices = deferred(), calls: string[] = [];
  const context: Record<string, any> = {
    mediaLifecycle, livekitRoom: null, mediaRoomReady: false, mediaDiagnosticsTransports: [],
    Room: class { connect() { calls.push("connect"); return connect.promise; } async disconnect() { calls.push("disconnect"); } },
    faultConfig: {}, roomStateAccessToken: "private-token", sessionControlBlocked: false,
    debugState: { access: {}, media: {} }, runtimeSessionGate: { assertActive() {} },
    planBaseMedia: async () => ({ livekitUrl: "private-url", token: "private-token" }),
    planVoiceSession() { throw new Error("unused planning callback"); },
    createCoalescedConnection: (options: unknown) => options, createMediaSourceUpgrade: (options: unknown) => options,
    setupAudio() { calls.push("setup"); }, setupMediaTransportDiagnostics() {},
    applyPreferredAudioDevices() { calls.push("devices"); return devices.promise; },
    createUnavailableWebRtcDiagnostics: () => ({}), clearMediaRoomReference() {},
    createFaultError: (_name: string, reason: string) => new Error(reason),
    permitsScreenShare() {}, ensureBaseMediaRoom() {}, roomPermitsScreenShare() {}, installMediaRoom() {},
    disconnectMediaRoom() {},
    syncRemoteBrowserLiveKitTracks() { calls.push("browser-reconcile"); },
    syncScreenShareLiveKitTracks() { calls.push("screen-reconcile"); },
    reconcileRemoteAudioTracksWithPresence() { calls.push("audio-reconcile"); },
    refreshWebRtcDiagnostics: async () => {}, startShareButton: {}, canUseScreenShareControl: () => false
  };
  const options = load<Connection>(upgrade ? "mediaSourceUpgrade" : "mediaRoomConnection", context);
  return { context, options, connect, devices, calls, mediaLifecycle, time: (value: number) => { now = value; } };
}

for (const upgrade of [false, true]) test(`${upgrade ? "upgrade" : "base"} actual connect/devices awaits retain pending timing and original failures`, async () => {
  const f = fixture(upgrade), room = f.options.create();
  const pending = f.options.connect(room, { livekitUrl: "private-url", token: "private-token" });
  await tick();
  assert.equal(f.mediaLifecycle.snapshot()!.generations[0]!.stages.connect.status, "pending");
  assert.deepEqual(f.calls, ["setup", "connect"]);
  f.time(19); f.connect.resolve(); await tick();
  let snapshot = f.mediaLifecycle.snapshot()!;
  assert.equal(snapshot.generations[0]!.stages.connect.completedAtMs, 19);
  assert.equal(snapshot.generations[0]!.stages.devices.status, "pending");
  f.time(21); f.devices.resolve(); await pending;
  snapshot = f.mediaLifecycle.snapshot()!;
  assert.equal(snapshot.generations[0]!.stages.devices.completedAtMs, 21);
  assert.equal(snapshot.currentGeneration, null); // connect completion is not installation
  assert.deepEqual(f.calls, ["setup", "connect", "devices"]);
  for (const failAt of ["connect", "devices"] as const) {
    const failed = fixture(upgrade), rejectedRoom = failed.options.create(), error = new Error("private SDK failure");
    const attempt = failed.options.connect(rejectedRoom, {});
    const rejection = assert.rejects(attempt, actual => actual === error);
    if (failAt === "devices") { failed.connect.resolve(); await tick(); failed.devices.reject(error); }
    else failed.connect.reject(error);
    await rejection;
    assert.equal(failed.mediaLifecycle.snapshot()!.generations[0]!.stages[failAt].status, "failed");
    assert.doesNotMatch(JSON.stringify(failed.mediaLifecycle.snapshot()), /private SDK failure|private-token|private-url/);
  }
});

test("actual install observes current reference and exactly one ordered reconciliation; thrown errors propagate", () => {
  const f = fixture(), room = f.options.create();
  const install = load<(room: Room) => void>("installMediaRoom", f.context);
  install(room);
  assert.equal(f.context.livekitRoom, room);
  assert.equal(f.context.mediaRoomReady, true);
  let snapshot = f.mediaLifecycle.snapshot()!;
  assert.equal(snapshot.currentGeneration, 1);
  assert.equal(snapshot.generations[0]!.stages.install.status, "succeeded");
  assert.equal(snapshot.generations[0]!.stages.reconcile.status, "succeeded");
  assert.deepEqual(f.calls, ["browser-reconcile", "screen-reconcile", "audio-reconcile"]);
  const failed = fixture(), failedRoom = failed.options.create(), error = new Error("private reconcile failure");
  failed.context.syncScreenShareLiveKitTracks = () => { throw error; };
  assert.throws(() => load<(room: Room) => void>("installMediaRoom", failed.context)(failedRoom), actual => actual === error);
  snapshot = failed.mediaLifecycle.snapshot()!;
  assert.equal(snapshot.generations[0]!.stages.install.status, "succeeded");
  assert.equal(snapshot.generations[0]!.stages.reconcile.status, "failed");
  assert.deepEqual(failed.calls, ["browser-reconcile"]);
});

test("actual subscription ignores preinstall/stale callbacks and logs the unchanged binding verdict exactly once", () => {
  const f = fixture(), room = f.options.create();
  const handlers = new Map<string, (...args: any[]) => void>();
  Object.assign(room, { on(name: string, callback: (...args: any[]) => void) { handlers.set(name, callback); return room; } });
  Object.assign(f.context, {
    RoomEvent: { Disconnected: "disconnect", TrackSubscribed: "subscribe" }, Track: { Kind: { Video: "video", Audio: "audio" } },
    shouldHandleMediaRoomEvent: (current: Room | null, observed: Room) => current === observed,
    resolveRemoteBrowserObjectForTrack: () => null,
    resolveScreenShareObjectForTrack() { f.calls.push("binding"); f.mediaLifecycle.verdict(room, "screen-share-binding", false, "binding-media-only"); return null; }
  });
  load<(room: Room) => void>("setupAudio", f.context)(room);
  handlers.get("subscribe")!({ kind: "video" }, {}, {});
  assert.equal(f.calls.length, 0);
  assert.equal(f.mediaLifecycle.snapshot()!.events.at(-1)!.reason, "room-not-current");
  f.context.livekitRoom = room; f.mediaLifecycle.installed(room);
  handlers.get("subscribe")!({ kind: "video" }, {}, {});
  assert.deepEqual(f.calls, ["binding"]);
  assert.equal(f.mediaLifecycle.snapshot()!.events.at(-1)!.reason, "binding-media-only");
  f.context.livekitRoom = null;
  handlers.get("disconnect")!();
  assert.equal(f.mediaLifecycle.snapshot()!.currentGeneration, null);
  assert.equal(f.mediaLifecycle.snapshot()!.generations[0]!.invalidationReason, "disconnected");
});

test("actual private screen binding resolves once and exposes only the observed safe reason", () => {
  const f = fixture(), room = f.options.create();
  let binding: unknown = null, object: unknown = null, resolveCalls = 0, physicalCalls = 0;
  Object.assign(f.context, { livekitRoom: { ...room, name: "secret-room", remoteParticipants: new Map() },
    activeIdentityProtocolVersion: 2, roomMediaObjects: {}, mediaSurfaceViews: new Map(),
    resolveMediaPeer() { resolveCalls++; return binding; }, getPublicationTrackSid: () => "secret-track",
    physicalScreenShareObjectForMediaTrack() { physicalCalls++; return object; }, getPublicationName: () => "secret-name" });
  // Observe the same actual SDK key the binding function reads.
  f.mediaLifecycle.created(f.context.livekitRoom); f.mediaLifecycle.installed(f.context.livekitRoom);
  const resolve = load<(...args: unknown[]) => unknown>("resolveScreenShareObjectForTrack", f.context);
  for (const [value, reason] of [[null, "binding-not-user"], [{ kind: "user", scope: "m" }, "binding-media-only"],
    [{ kind: "user", scope: "ms", participantId: "secret-participant" }, "no-physical-object"]] as const) {
    binding = value; assert.equal(resolve("secret-identity", {}, {}, "video"), null);
    assert.equal(f.mediaLifecycle.snapshot()!.events.at(-1)!.reason, reason);
  }
  object = { objectId: "secret-object" };
  assert.equal(resolve("secret-identity", {}, {}, "video"), object);
  assert.equal(resolveCalls, 4); assert.equal(physicalCalls, 2);
  assert.equal(f.mediaLifecycle.snapshot()!.events.at(-1)!.reason, "matched");
  assert.doesNotMatch(JSON.stringify(f.mediaLifecycle.snapshot()), /secret-/);
});

test("actual attachment branches never repeat attach; a thrown SDK error is preserved", () => {
  for (const remoteBrowser of [false, true]) {
    const f = fixture(), room = f.options.create(); f.context.livekitRoom = room; f.mediaLifecycle.installed(room);
    let attachments = 0;
    const element = {}, error = new Error("private attach error");
    const track = { attach() { attachments++; return element; } };
    const object = { objectId: "secret-object", surfaceId: "secret-surface", state: {} };
    const options = { ...object, remote: true, mediaTrackSid: "secret-track" };
    const entries = new Map();
    Object.assign(f.context, { mediaSurfaceViews: new Map([[object.surfaceId, {}]]), roomMediaObjects: { surfaces: { [object.surfaceId]: {} } },
      screenShareRuntimeByObjectId: entries, remoteBrowserVideoByObjectId: entries,
      moveScreenShareEntryToSurface() {}, moveRemoteBrowserVideoEntryToSurface() {},
      getPublicationTrackSid: () => "secret-track", prepareHiddenVideoElement() {}, document: { body: { appendChild() {} } },
      startHiddenVideoPlayback() {}, createScreenShareVideoTexture() {}, createRemoteBrowserVideoTexture() {}, applySurfaceTexture() {},
      registerScreenShareEntry(entry: unknown) { entries.set(object.objectId, entry); }, remoteScreenShareTrackCount: () => entries.size,
      reconcileMediaRoomIdleDisconnect() {}, startRemoteBrowserExternalVideoFrameDiagnostics() {}, currentRemoteBrowserObject() {},
      createRemoteBrowserExternalVideoDebugSnapshot: () => ({}) });
    f.context.debugState.screenShare = {}; f.context.debugState.remoteBrowser = {};
    const attach = load<(...args: any[]) => void>(remoteBrowser ? "attachRemoteBrowserVideoTrack" : "attachVideoTrack", f.context);
    const args = remoteBrowser ? [track, object, {}] : [track, options];
    attach(...args); attach(...args);
    assert.equal(attachments, 1);
    assert.equal(f.mediaLifecycle.snapshot()!.events.at(-1)!.reason, "reused");
    entries.clear(); track.attach = () => { attachments++; throw error; };
    assert.throws(() => attach(...args), actual => actual === error);
    assert.equal(attachments, 2);
    assert.equal(f.mediaLifecycle.snapshot()!.events.at(-1)!.reason, "threw");
    f.context.mediaSurfaceViews.clear(); attach(...args);
    assert.equal(attachments, 2);
    assert.equal(f.mediaLifecycle.snapshot()!.events.at(-1)!.reason, "missing-surface");
    assert.doesNotMatch(JSON.stringify(f.mediaLifecycle.snapshot()), /secret-|private attach error/);
  }
});
