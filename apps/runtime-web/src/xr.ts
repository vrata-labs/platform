export interface XrSupport {
  available: boolean;
  canEnterVr: boolean;
}

export type XrSessionLifecycleState = "disabled" | "unsupported" | "idle" | "entering" | "active" | "exiting" | "failed";

export interface XrRendererWiringDebug {
  rendererXrEnabled: boolean;
  animationLoop: "xr_compatible" | "disabled";
  cameraRig: "local_pose_controller";
  pointer: "controller_or_gaze";
  transformSync: "room_state_presence";
  sessionState: XrSessionLifecycleState;
  featureEnabled: boolean;
  enterVrVisible: boolean;
  active: boolean;
  sessionStartedAtMs: number | null;
  sessionEndedAtMs: number | null;
  lastEnterAttemptAtMs: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  transformThrottleMs: number;
  lastTransformSyncAtMs: number;
  transformSyncCount: number;
}

export const XR_TRANSFORM_SYNC_INTERVAL_MS = 80;

export function detectXrSupport(input: { navigatorXr?: unknown; immersiveVrSupported?: boolean }): XrSupport {
  const available = Boolean(input.navigatorXr);
  return {
    available,
    canEnterVr: available && Boolean(input.immersiveVrSupported)
  };
}

export function getEnterVrVisibility(support: XrSupport, featureEnabled: boolean): boolean {
  return featureEnabled && support.canEnterVr;
}

export function createXrRendererWiringDebug(input: {
  featureEnabled: boolean;
  support: XrSupport;
  rendererXrEnabled: boolean;
  animationLoopConfigured: boolean;
  presenting: boolean;
  previous?: XrRendererWiringDebug | null;
  sessionState?: XrSessionLifecycleState;
}): XrRendererWiringDebug {
  const enterVrVisible = getEnterVrVisibility(input.support, input.featureEnabled);
  return {
    rendererXrEnabled: input.rendererXrEnabled,
    animationLoop: input.animationLoopConfigured ? "xr_compatible" : "disabled",
    cameraRig: "local_pose_controller",
    pointer: "controller_or_gaze",
    transformSync: "room_state_presence",
    sessionState: input.sessionState ?? resolveXrSessionLifecycle({
      featureEnabled: input.featureEnabled,
      support: input.support,
      presenting: input.presenting
    }),
    featureEnabled: input.featureEnabled,
    enterVrVisible,
    active: input.presenting,
    sessionStartedAtMs: input.previous?.sessionStartedAtMs ?? null,
    sessionEndedAtMs: input.previous?.sessionEndedAtMs ?? null,
    lastEnterAttemptAtMs: input.previous?.lastEnterAttemptAtMs ?? null,
    lastErrorCode: input.previous?.lastErrorCode ?? null,
    lastErrorMessage: input.previous?.lastErrorMessage ?? null,
    transformThrottleMs: input.previous?.transformThrottleMs ?? XR_TRANSFORM_SYNC_INTERVAL_MS,
    lastTransformSyncAtMs: input.previous?.lastTransformSyncAtMs ?? 0,
    transformSyncCount: input.previous?.transformSyncCount ?? 0
  };
}

export function markXrSessionEntering(state: XrRendererWiringDebug, nowMs: number): XrRendererWiringDebug {
  return {
    ...state,
    sessionState: "entering",
    lastEnterAttemptAtMs: nowMs,
    lastErrorCode: null,
    lastErrorMessage: null
  };
}

export function markXrSessionStarted(state: XrRendererWiringDebug, nowMs: number): XrRendererWiringDebug {
  return {
    ...state,
    sessionState: "active",
    active: true,
    sessionStartedAtMs: nowMs,
    lastErrorCode: null,
    lastErrorMessage: null
  };
}

export function markXrSessionEnded(state: XrRendererWiringDebug, nowMs: number): XrRendererWiringDebug {
  return {
    ...state,
    sessionState: state.featureEnabled && state.enterVrVisible ? "idle" : state.sessionState,
    active: false,
    sessionEndedAtMs: nowMs
  };
}

export function markXrSessionFailed(state: XrRendererWiringDebug, error: unknown, nowMs: number): XrRendererWiringDebug {
  return {
    ...state,
    sessionState: "failed",
    active: false,
    sessionEndedAtMs: nowMs,
    lastErrorCode: getXrErrorCode(error),
    lastErrorMessage: getXrErrorMessage(error)
  };
}

export function shouldSyncXrTransform(input: {
  presenting: boolean;
  nowMs: number;
  lastSyncAtMs: number;
  minIntervalMs?: number;
  force?: boolean;
}): boolean {
  if (!input.presenting) return false;
  if (input.force) return true;
  return input.lastSyncAtMs <= 0 || input.nowMs - input.lastSyncAtMs >= (input.minIntervalMs ?? XR_TRANSFORM_SYNC_INTERVAL_MS);
}

export function recordXrTransformSync(state: XrRendererWiringDebug, nowMs: number): XrRendererWiringDebug {
  return {
    ...state,
    lastTransformSyncAtMs: nowMs,
    transformSyncCount: state.transformSyncCount + 1
  };
}

function resolveXrSessionLifecycle(input: { featureEnabled: boolean; support: XrSupport; presenting: boolean }): XrSessionLifecycleState {
  if (!input.featureEnabled) return "disabled";
  if (!input.support.canEnterVr) return "unsupported";
  return input.presenting ? "active" : "idle";
}

function getXrErrorCode(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return "xr_enter_failed";
}

function getXrErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 160);
  return String(error ?? "unknown").slice(0, 160);
}
