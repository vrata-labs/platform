import type { RuntimeFrameContext } from "./input/runtime-frame-context.js";
import type { createLocalPoseController } from "./local/local-pose.js";
import type { createRuntimeDebugState } from "./runtime-debug-state.js";

type RuntimeDebugState = ReturnType<typeof createRuntimeDebugState>;

export interface XrTelemetryContext {
  apiBaseUrl: string;
  roomId: string;
  participantId: string;
  renderer: { xr: { isPresenting: boolean } };
  avatarVrMockEnabled: boolean;
  readonly roomStateAccessToken: string;
  readonly syntheticXrState: {
    triggerPressed: boolean;
    axes: { turnX: number; turnY: number };
  } | null;
  readonly xrSelectEventCount: number;
  readonly debugState: Pick<RuntimeDebugState,
    "statusLine" | "currentSeatId" | "xrAxes" | "interactionRay" | "xrAvatarDebug"
  >;
  localPoseController: Pick<ReturnType<typeof createLocalPoseController>, "getYaw">;
}

export function createXrTelemetryReporter(context: XrTelemetryContext) {
  const { apiBaseUrl, roomId, participantId, renderer, avatarVrMockEnabled, localPoseController } = context;
  // The queue and throttle belong to this reporter; input sampling and pose stay outside.
  let lastXrTelemetryReportAt = 0;
  let lastXrTelemetryKinds: string[] = [];

  function markXrTelemetry(kind: string): void {
    if (!lastXrTelemetryKinds.includes(kind)) {
      lastXrTelemetryKinds.push(kind);
    }
    lastXrTelemetryReportAt = 0;
  }

  function reportXrTelemetry(frameContext: RuntimeFrameContext): void {
    if (!renderer.xr.isPresenting && !(avatarVrMockEnabled && context.syntheticXrState)) {
      return;
    }
    const now = performance.now();
    const inputSources = frameContext.xr?.inputSources ?? [];
    const xrRawInputs = context.syntheticXrState
      ? [{
          index: 0,
          handedness: "right",
          targetRayMode: "tracked-pointer",
          profiles: ["synthetic-right"],
          button0Pressed: context.syntheticXrState.triggerPressed,
          button1Pressed: false,
          axes: [
            context.syntheticXrState.axes.turnX,
            context.syntheticXrState.axes.turnY,
            context.syntheticXrState.axes.turnX,
            context.syntheticXrState.axes.turnY
          ]
        }]
      : inputSources.map((source, index) => ({
          index,
          handedness: source.handedness ?? null,
          targetRayMode: source.targetRayMode ?? null,
          profiles: Array.isArray(source.profiles) ? [...source.profiles] : [],
          button0Pressed: Boolean(source.gamepad?.buttons?.[0]?.pressed),
          button1Pressed: Boolean(source.gamepad?.buttons?.[1]?.pressed),
          axes: Array.isArray(source.gamepad?.axes) ? source.gamepad.axes.map((value) => Number(value.toFixed(3))) : []
        }));
    const rawInputActive = xrRawInputs.some((input) => input.button0Pressed || input.button1Pressed || input.axes.some((value) => Math.abs(value) > 0.01));
    const rayActive = Boolean(context.debugState.interactionRay.active);
    const reportIntervalMs = rawInputActive || rayActive ? 16 : 300;
    if (now - lastXrTelemetryReportAt < reportIntervalMs) {
      return;
    }
    lastXrTelemetryReportAt = now;
    const rightInputSource = inputSources.find((source) => source.handedness === "right")
      ?? inputSources[0]
      ?? null;
    const rightAxes = context.syntheticXrState
      ? [context.syntheticXrState.axes.turnX, context.syntheticXrState.axes.turnY, context.syntheticXrState.axes.turnX, context.syntheticXrState.axes.turnY]
      : rightInputSource?.gamepad?.axes ?? [];
    const payload = {
      participantId,
      roomId,
      updatedAt: new Date().toISOString(),
      kind: lastXrTelemetryKinds.at(-1) ?? null,
      kinds: [...lastXrTelemetryKinds],
      statusLine: context.debugState.statusLine ?? null,
      currentSeatId: context.debugState.currentSeatId ?? null,
      xrAxes: context.debugState.xrAxes,
      interactionRay: context.debugState.interactionRay,
      xrAvatarDebug: context.debugState.xrAvatarDebug ? {
        profile: context.debugState.xrAvatarDebug.profile ?? null,
        rightGrip: context.debugState.xrAvatarDebug.rightGrip ?? null,
        rightController: context.debugState.xrAvatarDebug.rightController ?? null,
        rightResolved: context.debugState.xrAvatarDebug.rightResolved ?? null,
        rightHandWorld: context.debugState.xrAvatarDebug.rightHandWorld ?? null,
        rightControllerWorld: context.debugState.xrAvatarDebug.rightControllerWorld ?? null
      } : null,
      xrRawInputs,
      xrTurnCandidates: {
        rightPrimaryX: typeof rightAxes[0] === "number" ? Number(rightAxes[0].toFixed(3)) : 0,
        rightPrimaryY: typeof rightAxes[1] === "number" ? Number(rightAxes[1].toFixed(3)) : 0,
        rightSecondaryX: typeof rightAxes[2] === "number" ? Number(rightAxes[2].toFixed(3)) : 0,
        rightSecondaryY: typeof rightAxes[3] === "number" ? Number(rightAxes[3].toFixed(3)) : 0,
        mappedTurnX: typeof context.debugState.xrAxes.turnX === "number" ? Number(context.debugState.xrAxes.turnX.toFixed(3)) : 0,
        mappedTurnY: typeof context.debugState.xrAxes.turnY === "number" ? Number(context.debugState.xrAxes.turnY.toFixed(3)) : 0,
        snapTurnFired: lastXrTelemetryKinds.includes("snap_turn"),
        playerYaw: Number(localPoseController.getYaw().toFixed(3)),
        selectEventCount: context.xrSelectEventCount
      }
    };
    void fetch(new URL(`/api/rooms/${roomId}/xr-telemetry/${participantId}`, apiBaseUrl), {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${context.roomStateAccessToken}`
      },
      body: JSON.stringify(payload)
    }).catch(() => undefined);
    lastXrTelemetryKinds = [];
  }

  return { markXrTelemetry, reportXrTelemetry };
}
