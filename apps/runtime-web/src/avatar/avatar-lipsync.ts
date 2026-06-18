export type AvatarLipsyncSourceState = "idle" | "active" | "muted" | "missing";

export interface AvatarLipsyncState {
  mouthAmount: number;
  speakingActive: boolean;
  sourceState: AvatarLipsyncSourceState;
}

export interface AvatarLipsyncDriver extends AvatarLipsyncState {
  silenceThreshold: number;
  attackPerSecond: number;
  releasePerSecond: number;
  speakingThreshold: number;
}

export function createAvatarLipsyncDriver(input?: Partial<Pick<AvatarLipsyncDriver, "silenceThreshold" | "attackPerSecond" | "releasePerSecond" | "speakingThreshold">>): AvatarLipsyncDriver {
  return {
    mouthAmount: 0,
    speakingActive: false,
    sourceState: "idle",
    silenceThreshold: input?.silenceThreshold ?? 0.05,
    attackPerSecond: input?.attackPerSecond ?? 16,
    releasePerSecond: input?.releasePerSecond ?? 9,
    speakingThreshold: input?.speakingThreshold ?? 0.09
  };
}

export function sampleAvatarLipsyncLevel(analyser: AnalyserNode, scratch: Uint8Array): number {
  analyser.getByteTimeDomainData(scratch as Uint8Array<ArrayBuffer>);
  if (scratch.length === 0) {
    return 0;
  }

  let sumSquares = 0;
  for (const value of scratch) {
    const normalized = (value - 128) / 128;
    sumSquares += normalized * normalized;
  }

  const rms = Math.sqrt(sumSquares / scratch.length);
  return Math.min(1, Math.max(0, rms * 3.2));
}

export function updateAvatarLipsyncDriver(driver: AvatarLipsyncDriver, input: {
  deltaSeconds: number;
  level: number;
  sourceState: AvatarLipsyncSourceState;
}): AvatarLipsyncState {
  const deltaSeconds = Math.max(0, input.deltaSeconds);
  const clampedLevel = Math.min(1, Math.max(0, input.level));
  const activeSource = input.sourceState === "active";
  const targetAmount = activeSource && clampedLevel > driver.silenceThreshold
    ? Math.min(1, (clampedLevel - driver.silenceThreshold) / Math.max(0.001, 1 - driver.silenceThreshold))
    : 0;
  const speed = targetAmount > driver.mouthAmount ? driver.attackPerSecond : driver.releasePerSecond;
  const alpha = 1 - Math.exp(-speed * deltaSeconds);
  driver.mouthAmount += (targetAmount - driver.mouthAmount) * alpha;
  if (driver.mouthAmount < 0.001) {
    driver.mouthAmount = 0;
  }
  driver.speakingActive = activeSource && clampedLevel >= driver.speakingThreshold;
  driver.sourceState = input.sourceState;
  return {
    mouthAmount: driver.mouthAmount,
    speakingActive: driver.speakingActive,
    sourceState: driver.sourceState
  };
}
