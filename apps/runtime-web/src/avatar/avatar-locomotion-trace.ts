import {
  mapAvatarLocomotionModeToState,
  resolveAvatarLocomotion,
  type AvatarLocomotionSnapshot,
  type AvatarLocomotionState
} from "./avatar-locomotion.js";

export interface AvatarLocomotionTraceInput {
  moveX: number;
  moveZ: number;
  turnRate: number;
}

export interface AvatarLocomotionTraceFrame extends AvatarLocomotionTraceInput {
  index: number;
  snapshot: AvatarLocomotionSnapshot;
}

export interface AvatarLocomotionReplayFrame {
  index: number;
  expectedState: AvatarLocomotionState;
  actualState: AvatarLocomotionState;
  matches: boolean;
}

export function recordAvatarLocomotionTrace(
  inputs: AvatarLocomotionTraceInput[]
): AvatarLocomotionTraceFrame[] {
  let previousState: AvatarLocomotionState | null = null;
  return inputs.map((input, index) => {
    const snapshot = resolveAvatarLocomotion({ ...input, previousState });
    previousState = snapshot.state;
    return {
      index,
      ...input,
      snapshot
    };
  });
}

export function replayAvatarLocomotionTraceFromInputs(
  trace: AvatarLocomotionTraceFrame[]
): AvatarLocomotionReplayFrame[] {
  let previousState: AvatarLocomotionState | null = null;
  return trace.map((frame) => {
    const replayed = resolveAvatarLocomotion({
      moveX: frame.moveX,
      moveZ: frame.moveZ,
      turnRate: frame.turnRate,
      previousState
    });
    previousState = replayed.state;
    return {
      index: frame.index,
      expectedState: frame.snapshot.state,
      actualState: replayed.state,
      matches: frame.snapshot.state === replayed.state
    };
  });
}

export function replayAvatarLocomotionTraceFromRemoteModes(
  trace: AvatarLocomotionTraceFrame[],
  remoteModes: number[]
): AvatarLocomotionReplayFrame[] {
  return trace.map((frame, index) => {
    const actualState = mapAvatarLocomotionModeToState(remoteModes[index] ?? 0);
    return {
      index: frame.index,
      expectedState: frame.snapshot.state,
      actualState,
      matches: frame.snapshot.state === actualState
    };
  });
}
