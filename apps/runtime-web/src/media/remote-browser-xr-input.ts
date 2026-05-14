import type { SurfaceInputKind } from "@noah/shared-types";

export interface RemoteBrowserXrPointerPlanInput {
  browserActive: boolean;
  pointerActive: boolean;
  triggerPressed: boolean;
  confirmInteraction: boolean;
  hasHit: boolean;
  hasLastHit: boolean;
}

export interface RemoteBrowserXrPointerPlan {
  kind: SurfaceInputKind | null;
  nextPointerActive: boolean;
  useLastHit: boolean;
}

export function planRemoteBrowserXrPointer(input: RemoteBrowserXrPointerPlanInput): RemoteBrowserXrPointerPlan {
  if (!input.browserActive) {
    return {
      kind: input.pointerActive && input.hasLastHit ? "pointer-up" : null,
      nextPointerActive: false,
      useLastHit: true
    };
  }

  if (!input.pointerActive) {
    return {
      kind: input.confirmInteraction && input.hasHit ? "pointer-down" : null,
      nextPointerActive: input.confirmInteraction && input.hasHit,
      useLastHit: false
    };
  }

  if (!input.triggerPressed) {
    return {
      kind: input.hasHit || input.hasLastHit ? "pointer-up" : null,
      nextPointerActive: false,
      useLastHit: !input.hasHit
    };
  }

  return {
    kind: input.hasHit ? "pointer-move" : null,
    nextPointerActive: true,
    useLastHit: false
  };
}
