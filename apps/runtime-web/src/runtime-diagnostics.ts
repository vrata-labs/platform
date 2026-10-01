import type * as THREE from "three";
import type { createRuntimeDebugState } from "./runtime-debug-state.js";
import type { captureCanvasDiagnostics, inspectSceneObject } from "./scene-debug.js";

type RuntimeDebugState = ReturnType<typeof createRuntimeDebugState>;

export interface RuntimeDiagnosticsContext {
  apiBaseUrl: string;
  roomId: string;
  participantId: string;
  readonly displayName: string;
  readonly roomStateAccessToken: string;
  readonly runtimeFlags: { remoteDiagnostics: boolean };
  readonly activeSceneBundleRoot: THREE.Object3D | null;
  readonly debugState: RuntimeDebugState;
  debugEnabled: boolean;
  camera: THREE.Camera;
  renderer: Pick<THREE.WebGLRenderer, "domElement">;
  reportLineEl: Pick<HTMLElement, "hidden" | "textContent">;
  debugPanel: Pick<HTMLElement, "textContent">;
  xrDebugPanelEl: Pick<HTMLElement, "textContent">;
  refreshWebRtcDiagnostics(): Promise<void>;
  captureCanvasDiagnostics: typeof captureCanvasDiagnostics;
  inspectSceneObject: typeof inspectSceneObject;
  setStatus(message: string): void;
}

export function createRuntimeDiagnostics(context: RuntimeDiagnosticsContext) {
  const {
    apiBaseUrl, roomId, participantId, debugEnabled, camera, renderer,
    reportLineEl, debugPanel, xrDebugPanelEl, refreshWebRtcDiagnostics,
    captureCanvasDiagnostics, inspectSceneObject, setStatus
  } = context;
  // Read mutable runtime state only at the original use sites, including after awaits.

  function createClientReportId(): string {
    return `rpt_${crypto.randomUUID()}`;
  }

  function showReportId(reportId: string | null): void {
    context.debugState.lastReportId = reportId;
    reportLineEl.hidden = !reportId;
    reportLineEl.textContent = reportId ? `Report ID: ${reportId}` : "";
  }

  function setReportRequestId(requestId: string | null): void {
    context.debugState.lastReportRequestId = requestId;
  }

  function renderDebugPanel(): void {
    if (!debugEnabled) {
      return;
    }

    debugPanel.textContent = JSON.stringify(context.debugState, null, 2);
    const xrAvatarDebug = context.debugState.xrAvatarDebug;
    const ray = context.debugState.interactionRay;
    const axes = context.debugState.xrAxes;
    xrDebugPanelEl.textContent = [
      `XR session: ${context.debugState.xrSession.sessionState} visible=${context.debugState.xrSession.enterVrVisible}`,
      `XR profile: ${xrAvatarDebug?.profile ?? "none"}`,
      `XR axes: turn=(${axes.turnX?.toFixed?.(2) ?? axes.turnX ?? 0}, ${axes.turnY?.toFixed?.(2) ?? axes.turnY ?? 0}) move=(${axes.moveX?.toFixed?.(2) ?? axes.moveX ?? 0}, ${axes.moveY?.toFixed?.(2) ?? axes.moveY ?? 0})`,
      `Ray active: ${ray.active} mode=${ray.mode} target=${ray.targetKind} seat=${ray.seatId ?? "-"}`,
      `Ray source: ${ray.source ? `${ray.source.handedness ?? "?"}#${ray.source.index}` : "-"}`,
      `Ray origin: ${ray.origin ? `${ray.origin.x}, ${ray.origin.y}, ${ray.origin.z}` : "-"}`,
      `Ray direction: ${ray.direction ? `${ray.direction.x}, ${ray.direction.y}, ${ray.direction.z}` : "-"}`,
      `Right grip: ${xrAvatarDebug?.rightGrip ? `${xrAvatarDebug.rightGrip.x}, ${xrAvatarDebug.rightGrip.y}, ${xrAvatarDebug.rightGrip.z}` : "-"}`,
      `Right controller: ${xrAvatarDebug?.rightController ? `${xrAvatarDebug.rightController.x}, ${xrAvatarDebug.rightController.y}, ${xrAvatarDebug.rightController.z}` : "-"}`,
      `Right resolved: ${xrAvatarDebug?.rightResolved ? `${xrAvatarDebug.rightResolved.x}, ${xrAvatarDebug.rightResolved.y}, ${xrAvatarDebug.rightResolved.z}` : "-"}`,
      `Right hand world: ${xrAvatarDebug?.rightHandWorld ? `${xrAvatarDebug.rightHandWorld.x}, ${xrAvatarDebug.rightHandWorld.y}, ${xrAvatarDebug.rightHandWorld.z}` : "-"}`,
      `Status: ${context.debugState.statusLine ?? "-"}`
    ].join("\n");
  }

  async function reportDiagnostics(note?: string, options: { reportId?: string } = {}): Promise<void> {
    if (!context.runtimeFlags.remoteDiagnostics) {
      return;
    }
    await refreshWebRtcDiagnostics();
    if (context.activeSceneBundleRoot) {
      context.debugState.sceneDebug = inspectSceneObject({
        root: context.activeSceneBundleRoot,
        camera,
        previous: context.debugState.sceneDebug
      });
    }
    const includeImage = false;
    const screenshot = captureCanvasDiagnostics({
      canvas: renderer.domElement,
      includeImage
    });
    context.debugState.sceneDebug.screenshot = screenshot;
    const response = await fetch(new URL(`/api/rooms/${roomId}/diagnostics`, apiBaseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${context.roomStateAccessToken}`
      },
      body: JSON.stringify({
        reportId: options.reportId,
        participantId,
        displayName: context.displayName,
        mode: context.debugState.mode,
        userAgent: navigator.userAgent,
        statusLine: context.debugState.statusLine,
        locomotionMode: context.debugState.locomotionMode,
        roomStateConnected: context.debugState.roomStateConnected,
        roomStateUrl: context.debugState.roomStateUrl,
        roomStateMode: context.debugState.roomStateMode,
        audioState: context.debugState.audioState,
        localMicLevel: context.debugState.localMicLevel,
        speakerOutputLevel: context.debugState.speakerOutputLevel,
        media: context.debugState.media,
        access: context.debugState.access,
        surfaceInput: context.debugState.surfaceInput,
        screenShareState: context.debugState.screenShareState,
        mediaCapabilities: context.debugState.mediaCapabilities,
        clientCompatibility: context.debugState.clientCompatibility,
        localPose: context.debugState.localPose,
        localPosition: context.debugState.localPosition,
        spatialAudioState: context.debugState.spatialAudioState,
        spatialAudio: context.debugState.spatialAudio,
        xrSession: context.debugState.xrSession,
        xrAxes: context.debugState.xrAxes,
        remoteAvatarCount: context.debugState.remoteAvatarCount,
        remoteTargets: context.debugState.remoteTargets,
        remoteParticipants: context.debugState.remoteParticipants,
        remoteAvatarReliableStates: context.debugState.remoteAvatarReliableStates,
        remoteAvatarPoseFrames: context.debugState.remoteAvatarPoseFrames,
        remoteAvatarParticipants: context.debugState.remoteAvatarParticipants,
        issueCode: context.debugState.issueCode,
        issueSeverity: context.debugState.issueSeverity,
        degradedMode: context.debugState.degradedMode,
        retryCount: context.debugState.retryCount,
        lastRecoveryAction: context.debugState.lastRecoveryAction,
        lastPresenceSyncAt: context.debugState.lastPresenceSyncAt,
        lastPresenceRefreshAt: context.debugState.lastPresenceRefreshAt,
        featureFlags: context.debugState.featureFlags,
        faultInjection: context.debugState.faultInjection,
        avatarDebug: context.debugState.avatarDebug,
        avatarSnapshot: context.debugState.avatarSnapshot,
        avatarTransportPreview: context.debugState.avatarTransportPreview,
        avatarPoseTransport: context.debugState.avatarPoseTransport,
        xrAvatarDebug: context.debugState.xrAvatarDebug,
        sceneDebug: {
          ...context.debugState.sceneDebug,
          template: context.debugState.template,
          missingAssetCount: context.debugState.sceneDebug.missingAssets.length,
          screenshot
        },
        note,
        createdAt: new Date().toISOString()
      })
    });
    const responseRequestId = response.headers.get("x-request-id");
    if (responseRequestId) {
      setReportRequestId(responseRequestId);
    }
    if (response.ok) {
      const payload = await response.json().catch(() => null) as { reportId?: string; requestId?: string } | null;
      if (payload?.requestId) {
        setReportRequestId(payload.requestId);
      }
      if (payload?.reportId) {
        showReportId(payload.reportId);
      }
    }
  }

  function reportUnhandledRuntimeError(error: unknown, note: string): void {
    const reportId = createClientReportId();
    const message = error instanceof Error ? error.message : String(error ?? "unknown");
    showReportId(reportId);
    setStatus(`Runtime error. Report ID: ${reportId}`);
    context.debugState.issueCode = "runtime_unhandled_error";
    context.debugState.issueSeverity = "error";
    context.debugState.lastRecoveryAction = "report_runtime_error";
    void reportDiagnostics(`${note}:${message.slice(0, 160)}`, { reportId }).catch(() => undefined);
  }

  return { renderDebugPanel, reportDiagnostics, reportUnhandledRuntimeError };
}
