import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { finishReleasedAvatar, observeReleasedAvatar, type ReleaseEvidence } from "./seat-release-observation.ts";

// Execute the actual page.evaluate function with a finite manual RAF/timer clock.
// No browser, real timers, extra samples or duplicate readiness implementation.
async function clock(run: (c: ReturnType<typeof makeClock>) => Promise<void>) {
  const keys = ["window", "requestAnimationFrame", "cancelAnimationFrame"] as const;
  const saved = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const c = makeClock();
  Object.assign(globalThis, { window: c.window, requestAnimationFrame: c.request, cancelAnimationFrame: c.cancel });
  try { await run(c); }
  finally {
    keys.forEach((key, i) => {
      if (saved[i]) Object.defineProperty(globalThis, key, saved[i]!);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}
function makeClock() {
  let raf: FrameRequestCallback | null = null, timer: (() => void) | null = null, timeoutMs = 0;
  const remote = { participantId: "private-id", hasVisualEntity: true,
    root: { x: 1, y: 2, z: 3, secret: "raw-scene" }, url: "https://private.invalid" };
  const transport = { participantId: "private-id", hasPoseFrame: true, lastPoseSeq: 8, playbackDelayMs: 10,
    token: "private-token" };
  return {
    remote, transport,
    window: { __VRATA_DEBUG__: { remoteParticipants: [remote], remoteAvatarParticipants: [transport] },
      setTimeout: (callback: () => void, ms: number) => { timer = callback; timeoutMs = ms; return 2; },
      clearTimeout: () => { timer = null; } },
    request: (callback: FrameRequestCallback) => { raf = callback; return 1; },
    cancel: () => { raf = null; },
    tick(now: number) { assert.ok(raf, "exactly the existing RAF must be queued"); const callback = raf; raf = null; callback(now); },
    expire() { assert.ok(timer); const callback = timer; timer = null; callback(); },
    active() { return { raf: Boolean(raf), timer: Boolean(timer), timeoutMs }; }
  };
}
const args = { participantId: "private-id", parkedRoot: { x: 1, y: 2, z: 3 }, previousPoseSeq: 7, timeoutMs: 15000 };

test("release success waits twice the playback delay and all 16 settling frames; saves before returning", async () => clock(async c => {
  const pending = observeReleasedAvatar(args);
  c.tick(100); c.tick(119);
  for (let i = 0; i < 15; i++) c.tick(120 + i);
  assert.equal(c.active().raf, true);
  c.tick(135);
  const result = await pending;
  let saved: ReleaseEvidence | undefined;
  const pose = await finishReleasedAvatar(result, async evidence => { saved = structuredClone(evidence); });
  assert.equal(saved!.last!.settlingFrames, 16);
  assert.equal(saved!.last!.rafCount, 18);
  assert.equal(saved!.last!.readySince, 100);
  assert.deepEqual(pose, { receivedRoot: args.parkedRoot, lastPoseSeq: 8, playbackDelayMs: 10, settlingFrames: 16, stableMs: 35 });
  assert.deepEqual(c.active(), { raf: false, timer: false, timeoutMs: 15000 });
}));

for (const reason of ["staleSeq", "wrongRoot", "exact02m", "nonfiniteDelay", "noVisual", "noPose"] as const) {
  test(`release ${reason} never settles and timeout retains original last fields`, async () => clock(async c => {
    if (reason === "staleSeq") c.transport.lastPoseSeq = 7;
    if (reason === "wrongRoot") c.remote.root.z += 0.03;
    const input = reason === "exact02m" ? { ...args, parkedRoot: { ...args.parkedRoot, x: 0 } } : args;
    if (reason === "exact02m") c.remote.root.x = 0.02;
    if (reason === "nonfiniteDelay") c.transport.playbackDelayMs = NaN;
    if (reason === "noVisual") c.remote.hasVisualEntity = false;
    if (reason === "noPose") c.transport.hasPoseFrame = false;
    const pending = observeReleasedAvatar(input);
    for (let i = 0; i < 40; i++) c.tick(100 + i * 10);
    c.expire();
    const result = await pending;
    assert.equal(result.evidence.last!.settlingFrames, 0);
    assert.equal(result.evidence.last!.lastPoseSeq, c.transport.lastPoseSeq);
    assert.deepEqual(result.evidence.last!.receivedRoot, { x: c.remote.root.x, y: 2, z: c.remote.root.z });
    assert.equal(result.evidence.last!.playbackDelayMs, reason === "nonfiniteDelay" ? null : 10);
    assert.deepEqual(result.evidence.parkedRoot, input.parkedRoot);
    assert.equal(result.evidence.previousPoseSeq, 7);
    assert.equal(result.evidence.timeoutMs, 15000);
    assert.equal(result.evidence.trail.length, 32);
    assert.equal(result.evidence.trail[0]!.rafCount, 9);
    assert.equal(result.evidence.last!.rafCount, 40);
    assert.equal(result.evidence.last!.now, 490);
    assert.doesNotMatch(JSON.stringify(result), /private|token|url|secret|raw-scene|participantId/);
    let saved: ReleaseEvidence | undefined;
    await assert.rejects(finishReleasedAvatar(result, async evidence => {
      saved = structuredClone(evidence);
    }), /released_avatar_pose_not_settled_within_release_budget/);
    assert.deepEqual(saved, result.evidence, "original evidence is actually saved before rethrow");
    await assert.rejects(finishReleasedAvatar(result, async () => { throw new Error("attachment_failed"); }),
      /released_avatar_pose_not_settled_within_release_budget/);
    assert.deepEqual(c.active(), { raf: false, timer: false, timeoutMs: 15000 });
  }));
}

test("release reset clears both stable time and frame count; 15 frames cannot pass", async () => clock(async c => {
  const pending = observeReleasedAvatar(args);
  c.tick(100);
  for (let i = 0; i < 15; i++) c.tick(120 + i);
  c.transport.lastPoseSeq = 7; c.tick(200);
  c.transport.lastPoseSeq = 9; c.tick(300);
  for (let i = 0; i < 15; i++) c.tick(320 + i);
  c.expire();
  const { evidence, error } = await pending;
  assert.equal(error, "released_avatar_pose_not_settled_within_release_budget");
  assert.equal(evidence.last!.settlingFrames, 15);
  assert.equal(evidence.last!.readySince, 300);
  assert.equal(evidence.trail.find(sample => sample.now === 200)!.settlingFrames, 0);
  assert.equal(evidence.trail.find(sample => sample.now === 200)!.readySince, null);
}));

test("release timeout before first RAF saves null last and an empty trail", async () => clock(async c => {
  const pending = observeReleasedAvatar(args);
  c.expire();
  const result = await pending;
  assert.equal(result.evidence.last, null);
  assert.deepEqual(result.evidence.trail, []);
  assert.ok(Number.isFinite(result.evidence.startedAt));
  assert.ok(result.evidence.finishedAt >= result.evidence.startedAt);
}));

test("release trail copies root numbers, not mutable remote objects", async () => clock(async c => {
  const pending = observeReleasedAvatar(args);
  c.tick(100);
  c.remote.root.x = 99; c.transport.lastPoseSeq = 9;
  c.tick(120); c.expire();
  const { evidence } = await pending;
  assert.deepEqual(evidence.trail[0]!.receivedRoot, args.parkedRoot);
  assert.equal(evidence.trail[0]!.lastPoseSeq, 8);
  assert.equal(evidence.last!.receivedRoot!.x, 99);
  assert.equal(evidence.last!.lastPoseSeq, 9);
}));

test("release function survives page.evaluate-style serialization without module captures", async () => {
  const c = makeClock();
  const evaluate: typeof observeReleasedAvatar = runInNewContext(`(${observeReleasedAvatar.toString()})`, {
    window: c.window, performance, requestAnimationFrame: c.request, cancelAnimationFrame: c.cancel
  });
  const pending = evaluate(args);
  c.tick(100); c.expire();
  const result = await pending;
  assert.equal(result.evidence.last!.rafCount, 1);
  assert.equal(result.error, "released_avatar_pose_not_settled_within_release_budget");
});

// Execute the real spec block, not a duplicate orchestration implementation.
// Browser-only collaborators are replaced with finite assertions/event records;
// readiness itself still runs the actual helper and its existing RAF clock.
function releaseOrchestration(options: { failAt?: "view" | "deadline" | "png"; attachmentFails?: boolean } = {}) {
  const source = readFileSync(new URL("./seat-marker-visual.spec.ts", import.meta.url), "utf8");
  const start = source.indexOf("          const remainingMs = releaseDeadline - Date.now();");
  const end = source.indexOf('\n        }\n        await testInfo.attach("room-review-settings"', start);
  assert.ok(start >= 0 && end > start, "the actual visual release block must be selected");
  const code = ts.transpileModule(`(async () => {${source.slice(start, end)}\n})()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  let wallMs = 0;
  const events: string[] = [];
  const primaryError = new Error(`original_${options.failAt}_failure`);
  const attachmentError = new Error("attachment_failed");
  const fixedReviewView = { root: args.parkedRoot, pitch: 0.2, devicePixelRatio: 1, canvas: { width: 640, height: 480 } };
  let saved: ReleaseEvidence | undefined;
  const pending: Promise<void> = runInNewContext(code, {
    Date: { now: () => wallMs }, Math, JSON, releaseDeadline: 15000,
    observer: { evaluate: (fn: typeof observeReleasedAvatar, input: typeof args) => fn(input) },
    initial: { participantId: args.participantId, root: args.parkedRoot }, previousPoseSeq: args.previousPoseSeq,
    observeReleasedAvatar, finishReleasedAvatar, fixedReviewView,
    readReviewView: async () => { events.push("view"); return fixedReviewView; },
    expect: (actual: unknown) => ({
      toBeGreaterThan: (expected: number) => { assert.ok(Number(actual) > expected); },
      toEqual: (expected: unknown) => {
        events.push("view-assertion");
        if (options.failAt === "view") throw primaryError;
        assert.deepEqual(actual, expected);
      },
      toBeLessThan: (expected: number) => {
        events.push("deadline-assertion");
        if (options.failAt === "deadline") throw primaryError;
        assert.ok(Number(actual) < expected, `original deadline: ${actual} < ${expected}`);
      }
    }),
    capture: async (_observer: unknown, _info: unknown, name: string) => {
      assert.equal(name, "room-released-same-view"); events.push("png");
      if (options.failAt === "png") throw primaryError;
    },
    writeFile: async (path: string, body: string, mode: { mode: number; flag: string }) => {
      assert.equal(path, "room-release-readiness.json");
      assert.equal(mode.mode, 0o600); assert.equal(mode.flag, "wx");
      assert.doesNotMatch(body, /private|token|url|secret|raw-scene|participantId/);
      saved = JSON.parse(body); assert.ok(saved!.trail.length <= 32); events.push("write-readiness");
    },
    testInfo: { outputPath: (name: string) => name, attach: async (name: string) => {
      events.push(name);
      if (name === "room-release-readiness") {
        wallMs += 30;
        if (options.attachmentFails) throw attachmentError;
      }
    } }
  });
  return { pending, events, primaryError, attachmentError,
    setWall: (now: number) => { wallMs = now; }, wall: () => wallMs, saved: () => saved };
}

function settleAtOriginalBoundary(c: ReturnType<typeof makeClock>) {
  c.tick(14940);
  for (let i = 0; i < 16; i++) c.tick(14960 + i);
}

test("release spec delayed success attachment runs after the original deadline verdict and PNG", async () => clock(async c => {
  const run = releaseOrchestration();
  run.setWall(14975); settleAtOriginalBoundary(c);
  await run.pending;
  assert.equal(run.saved()!.finishedAt, 14975);
  assert.equal(run.saved()!.timeoutMs, 15000);
  assert.equal(run.wall(), 15005, "new I/O crosses the deadline only after the original verdict and PNG");
  assert.deepEqual(run.events, ["view", "view-assertion", "room-release-view", "deadline-assertion", "png",
    "write-readiness", "room-release-readiness"]);
}));

for (const failAt of ["view", "deadline", "png"] as const) {
  test(`release spec preserves original ${failAt} error and still saves evidence if attachment fails`, async () => clock(async c => {
    const run = releaseOrchestration({ failAt, attachmentFails: true });
    run.setWall(14975); settleAtOriginalBoundary(c);
    await assert.rejects(run.pending, error => error === run.primaryError);
    assert.equal(run.saved()!.last!.settlingFrames, 16);
    assert.ok(run.events.indexOf(failAt === "png" ? "png" : `${failAt}-assertion`) < run.events.indexOf("write-readiness"));
    assert.deepEqual(run.events.slice(-2), ["write-readiness", "room-release-readiness"]);
    if (failAt !== "png") assert.ok(!run.events.includes("png"), "original short-circuit order is preserved");
  }));
}

test("release spec timeout persists evidence before the exact readiness error despite attachment failure", async () => clock(async c => {
  const run = releaseOrchestration({ attachmentFails: true });
  c.transport.lastPoseSeq = 7; c.tick(100); c.expire();
  await assert.rejects(run.pending, error => error instanceof Error
    && error !== run.attachmentError && error.message === "released_avatar_pose_not_settled_within_release_budget");
  assert.equal(run.saved()!.last!.lastPoseSeq, 7);
  assert.equal(run.saved()!.last!.settlingFrames, 0);
  assert.deepEqual(run.events, ["write-readiness", "room-release-readiness"]);
}));
