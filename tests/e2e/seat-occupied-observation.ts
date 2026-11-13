type Point = { x: number; y: number; z: number };
export interface OccupiedSample {
  now: number; rafCount: number; receivedRoot: Point | null; targetBody: Point | null;
  renderedBody: (Point & { visible: boolean }) | null; playbackDelayMs: number | null;
  receivedSince: number | null; lagFrames: number;
}
export interface OccupiedEvidence {
  seatedRoot: Point; timeoutMs: number; maxLagFrames: number; maxLagMs: number;
  startedAt: number; finishedAt: number; drawnAt: number | null; last: OccupiedSample | null; trail: OccupiedSample[];
}
export type OccupiedResult = { error: string | null; evidence: OccupiedEvidence };

/**
 * Self-contained for page.evaluate. The observer must DRAW the seated participant at the
 * seat: the received seated root alone does not prove an occupied chair in the PNG.
 * Normal playback (2x delay) is allowed; a lag beyond both maxLagFrames and maxLagMs after
 * that fails, independently of the overall timeout.
 */
export function observeSeatedAvatar({ participantId, seatedRoot, timeoutMs, maxLagFrames, maxLagMs }: {
  participantId: string; seatedRoot: Point; timeoutMs: number; maxLagFrames: number; maxLagMs: number;
}): Promise<OccupiedResult> {
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
  const point = (value: any): Point | null => value && [value.x, value.y, value.z].every(v => number(v) !== null)
    ? { x: value.x, y: value.y, z: value.z } : null;
  const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const evidence: OccupiedEvidence = { seatedRoot: { x: seatedRoot.x, y: seatedRoot.y, z: seatedRoot.z }, timeoutMs,
    maxLagFrames, maxLagMs, startedAt: performance.now(), finishedAt: 0, drawnAt: null, last: null, trail: [] };
  return new Promise(resolve => {
    let receivedSince: number | null = null, lagFrames = 0, frame = 0, rafCount = 0;
    const finish = (now: number, error: string | null) => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      evidence.finishedAt = now;
      resolve({ error, evidence });
    };
    const timer = window.setTimeout(() => finish(performance.now(), "seated_avatar_not_drawn_within_budget"), timeoutMs);
    const sample = (now: number) => {
      const d = (window as any).__VRATA_DEBUG__;
      const remote = d.remoteParticipants.find((value: any) => value.participantId === participantId);
      const transport = d.remoteAvatarParticipants.find((value: any) => value.participantId === participantId);
      const receivedRoot = point(remote?.root), targetBody = point(remote?.body), drawn = point(remote?.renderedBody);
      const delay = number(transport?.playbackDelayMs);
      const received = Boolean(remote?.hasVisualEntity && transport?.hasPoseFrame && delay !== null
        && receivedRoot && targetBody && distance(receivedRoot, seatedRoot) < 0.02);
      if (!received) { receivedSince = null; lagFrames = 0; } else receivedSince ??= now;
      const atSeat = received && drawn !== null && remote.renderedBody.visible === true && distance(drawn, targetBody!) < 0.05;
      if (received && !atSeat && now - receivedSince! >= 2 * delay!) lagFrames++;
      const current: OccupiedSample = { now, rafCount: ++rafCount, receivedRoot, targetBody,
        renderedBody: drawn ? { ...drawn, visible: remote.renderedBody.visible === true } : null,
        playbackDelayMs: delay, receivedSince, lagFrames };
      evidence.last = current;
      evidence.trail.push(current);
      if (evidence.trail.length > 32) evidence.trail.shift();
      if (atSeat) { evidence.drawnAt = now; finish(now, null); return; }
      if (received && lagFrames > maxLagFrames && now - receivedSince! - 2 * delay! > maxLagMs) {
        finish(now, "seated_avatar_drawn_late_after_received_pose");
        return;
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
  });
}
