type Root = { x: number; y: number; z: number };
export interface ReleaseSample {
  now: number; rafCount: number; receivedRoot: Root | null; lastPoseSeq: number | null;
  playbackDelayMs: number | null; readySince: number | null; settlingFrames: number;
  hasVisualEntity: boolean; hasPoseFrame: boolean;
}
export interface ReleaseEvidence {
  parkedRoot: Root; previousPoseSeq: number; timeoutMs: number;
  startedAt: number; finishedAt: number; last: ReleaseSample | null; trail: ReleaseSample[];
}
export type ReleaseResult = { error: string | null; evidence: ReleaseEvidence; remotePose: {
  receivedRoot: Root; lastPoseSeq: number; playbackDelayMs: number; settlingFrames: number; stableMs: number;
} | null };

/** Self-contained for page.evaluate; only the existing readiness RAF observes state. */
export function observeReleasedAvatar({ participantId, parkedRoot, previousPoseSeq, timeoutMs }: {
  participantId: string; parkedRoot: Root; previousPoseSeq: number; timeoutMs: number;
}): Promise<ReleaseResult> {
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
  const root = (value: any): Root | null => value && [value.x, value.y, value.z].every(v => number(v) !== null)
    ? { x: value.x, y: value.y, z: value.z } : null;
  const evidence: ReleaseEvidence = { parkedRoot: { x: parkedRoot.x, y: parkedRoot.y, z: parkedRoot.z },
    previousPoseSeq, timeoutMs, startedAt: performance.now(), finishedAt: 0, last: null, trail: [] };
  return new Promise(resolve => {
    let readySince: number | null = null, settlingFrames = 0, frame = 0, rafCount = 0;
    const record = (now: number, remote: any, transport: any) => {
      const current: ReleaseSample = { now, rafCount: ++rafCount, receivedRoot: root(remote?.root),
        lastPoseSeq: number(transport?.lastPoseSeq), playbackDelayMs: number(transport?.playbackDelayMs),
        hasVisualEntity: Boolean(remote?.hasVisualEntity), hasPoseFrame: Boolean(transport?.hasPoseFrame),
        readySince, settlingFrames };
      evidence.last = current;
      evidence.trail.push(current);
      if (evidence.trail.length > 32) evidence.trail.shift();
    };
    const timer = window.setTimeout(() => {
      cancelAnimationFrame(frame);
      evidence.finishedAt = performance.now();
      resolve({ error: "released_avatar_pose_not_settled_within_release_budget", evidence, remotePose: null });
    }, timeoutMs);
    const sample = (now: number) => {
      const d = (window as any).__VRATA_DEBUG__;
      // These are RECEIVED coordinates, not rendered mesh coordinates.
      const remote = d.remoteParticipants.find((value: any) => value.participantId === participantId);
      const transport = d.remoteAvatarParticipants.find((value: any) => value.participantId === participantId);
      const received = remote?.hasVisualEntity && transport?.hasPoseFrame && transport.lastPoseSeq > previousPoseSeq
        && Number.isFinite(transport.playbackDelayMs)
        && Math.hypot(remote.root.x - parkedRoot.x, remote.root.y - parkedRoot.y, remote.root.z - parkedRoot.z) < 0.02;
      if (!received) { readySince = null; settlingFrames = 0; record(now, remote, transport); }
      else {
        readySince ??= now;
        // Normal playback delay then real render frames; PNG review still decides occlusion.
        if (now - readySince >= 2 * transport.playbackDelayMs) settlingFrames++;
        record(now, remote, transport);
        if (settlingFrames >= 16) {
          window.clearTimeout(timer);
          evidence.finishedAt = now;
          resolve({ error: null, evidence, remotePose: {
            receivedRoot: root(remote.root)!, lastPoseSeq: transport.lastPoseSeq,
            playbackDelayMs: transport.playbackDelayMs, settlingFrames, stableMs: now - readySince } });
          return;
        }
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
  });
}

/** Save the browser's bounded outcome before rethrow; attachment failure cannot replace readiness failure. */
export async function finishReleasedAvatar(result: ReleaseResult,
  attach: (evidence: ReleaseEvidence) => Promise<unknown>) {
  const error = result.error ? new Error(result.error) : null;
  try { await attach(result.evidence); }
  catch (attachmentError) { if (!error) throw attachmentError; }
  if (error) throw error;
  return result.remotePose!;
}
