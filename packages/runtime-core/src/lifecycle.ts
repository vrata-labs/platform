export type RuntimeStage = "boot" | "manifest-loaded" | "assets-preloaded" | "scene-mounted" | "disposed";

export interface RuntimeLifecycleState {
  roomId: string;
  stage: RuntimeStage;
}

export function createLifecycleState(roomId: string): RuntimeLifecycleState {
  return {
    roomId,
    stage: "boot"
  };
}

export function advanceLifecycle(
  state: RuntimeLifecycleState,
  nextStage: Exclude<RuntimeStage, "boot">
): RuntimeLifecycleState {
  return {
    ...state,
    stage: nextStage
  };
}
