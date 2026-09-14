import {
  createRoomAccessDebugState,
  getMediaExtensionDebugSnapshot,
  type PdfPresentationState,
  type RemoteBrowserErrorCode,
  type RemoteBrowserExecutorInputState,
  type RemoteBrowserObjectState,
  type ScreenShareErrorCode,
  type SurfaceInputSource
} from "@vrata/shared-types";

import { createEmptyAvatarDiagnostics } from "./avatar/avatar-debug.js";
import type { AvatarLipsyncSourceState } from "./avatar/avatar-lipsync.js";
import type { AvatarOutboundPayload } from "./avatar/avatar-publish.js";
import type { LocalAvatarSnapshotV1 } from "./avatar/avatar-types.js";
import type { ClientCompatibilitySummary } from "./client-capabilities.js";
import type { PresenceState, RuntimeNoteScope } from "./index.js";
import { createSurfaceInputDebugState } from "./input/surface-input.js";
import type { BrowserMediaCapabilities } from "./media-capabilities.js";
import type { NotesSaveState } from "./notes.js";
import type { SurfaceCommandResult } from "./room-state-client.js";
import type { RuntimeIssue } from "./runtime-errors.js";
import { createEmptySceneDiagnostics } from "./scene-debug.js";
import { createUnavailableWebRtcDiagnostics } from "./webrtc-diagnostics.js";
import type { XrRendererWiringDebug } from "./xr.js";

export interface RuntimeDebugStateInput<FeatureFlags extends Record<string, boolean>> {
  participantId: string;
  latestMode: PresenceState["mode"];
  displayNameFromQuery: string | null;
  joinMutedPreference: boolean;
  activeNotesScope: RuntimeNoteScope;
  notesSaveState: NotesSaveState;
  selectedDocumentId: string;
  debugSurfaceId: string;
  shareMockEnabled: boolean;
  browserMediaCapabilities: BrowserMediaCapabilities;
  clientCompatibility: ClientCompatibilitySummary;
  spatialAudioQueryEnabled: boolean;
  initialLocalPosition: { x: number; y: number; z: number };
  xrSessionDebug: XrRendererWiringDebug;
  botMode: string;
  runtimeFlags: FeatureFlags;
  faultConfig: {
    audio: RuntimeIssue["code"] | null;
    roomState: boolean;
    xrUnavailable: boolean;
  };
}

// Keep caller-owned references intact; only the initial diagnostic state is created here.
export function createRuntimeDebugState<FeatureFlags extends Record<string, boolean>>({
  participantId,
  latestMode,
  displayNameFromQuery,
  joinMutedPreference,
  activeNotesScope,
  notesSaveState,
  selectedDocumentId,
  debugSurfaceId: DEBUG_SURFACE_ID,
  shareMockEnabled,
  browserMediaCapabilities,
  clientCompatibility,
  spatialAudioQueryEnabled,
  initialLocalPosition,
  xrSessionDebug,
  botMode,
  runtimeFlags,
  faultConfig
}: RuntimeDebugStateInput<FeatureFlags>) {
  return {
    participantId,
    mode: latestMode,
    remoteAvatarCount: 0,
    remoteAvatarReliableCount: 0,
    remoteAvatarPoseCount: 0,
    statusLine: "Connecting...",
    lastReportId: null as string | null,
    lastReportRequestId: null as string | null,
    locomotionMode: "desktop",
    roomStateConnected: false,
    roomStateUrl: "",
    roomStateMode: "disconnected",
    audioState: "idle",
    localMicLevel: 0,
    speakerOutputLevel: 0,
    media: {
      audioState: "not_joined" as "not_joined" | "joining" | "joined" | "muted" | "degraded" | "failed",
      audioJoined: false,
      muted: true,
      speaking: false,
      publishedAudio: false,
      audioSource: "none" as "none" | "microphone" | "mock",
      subscribedAudioCount: 0,
      webrtc: createUnavailableWebRtcDiagnostics()
    },
    access: {
      ...createRoomAccessDebugState("guest"),
      token: "",
      expiresInSeconds: 0,
      roleQueryAllowed: false,
      lastDeniedPermission: null as string | null,
      lastSurfaceCommandAccepted: null as boolean | null
    },
    guestOnboarding: {
      required: false,
      completed: false,
      displayNameProvided: Boolean(displayNameFromQuery),
      joinMuted: joinMutedPreference,
      audioMode: "not_checked" as "not_checked" | "microphone_ok" | "microphone_denied" | "without_audio",
      controlsHint: "",
      warnings: [] as string[]
    },
    hostControls: {
      enabled: false,
      visible: false,
      locked: false,
      ended: false,
      hostParticipantId: null as string | null,
      presenterParticipantId: null as string | null,
      selectedParticipantId: null as string | null,
      status: "idle" as string,
      lastReason: null as string | null
    },
    personalRoom: {
      enabled: true,
      roomType: "standard" as "standard" | "personal",
      ownerParticipantId: null as string | null,
      isOwner: false,
      openState: "idle" as "idle" | "opening" | "failed",
      lastPoseRestored: false,
      lastPoseSavedAt: null as string | null,
      errorCode: null as string | null
    },
    notes: {
      enabled: true,
      scope: activeNotesScope,
      saveState: notesSaveState as NotesSaveState,
      canEdit: false,
      contentLength: 0,
      versionCount: 0,
      exportInFlight: false,
      updatedAt: null as string | null,
      errorCode: null as string | null
    },
    documents: {
      enabled: true,
      count: 0,
      selectedDocumentId,
      selectedFilename: null as string | null,
      selectedSurfaceId: null as string | null,
      lastStatus: "idle" as string,
      errorCode: null as string | null
    },
    pdfPresentation: {
      surfaceId: DEBUG_SURFACE_ID,
      objectId: null as string | null,
      documentId: null as string | null,
      page: 1,
      pageCount: 0,
      displayMode: "normal" as PdfPresentationState["displayMode"],
      loadState: "idle" as string,
      renderState: "idle" as string,
      lastRenderMs: null as number | null,
      renderedThumbnailCount: 0,
      errorCode: null as string | null,
      errorDetail: null as string | null
    },
    documentMedia: {
      kind: null as "image" | "video" | null,
      surfaceId: DEBUG_SURFACE_ID,
      objectId: null as string | null,
      documentId: null as string | null,
      renderState: "idle" as string,
      playbackState: "paused" as string,
      actualPositionMs: 0,
      driftMs: 0,
      correctionMode: "none" as string,
      muted: true,
      errorCode: null as string | null
    },
    screenShareState: "idle",
    screenShare: {
      supported: shareMockEnabled || browserMediaCapabilities.screenShare.supported,
      active: false,
      localPublishing: false,
      selectedSurfaceId: null as string | null,
      publishedTrackSid: null as string | null,
      remoteSubscribedTrackCount: 0,
      mediaAudioEnabled: false,
      errorCode: null as ScreenShareErrorCode | null
    },
    remoteBrowser: {
      enabled: false,
      experimental: true,
      objectId: null as string | null,
      surfaceId: DEBUG_SURFACE_ID,
      active: false,
      status: "idle" as RemoteBrowserObjectState["status"] | "idle",
      currentUrl: null as string | null,
      controllerParticipantId: null as string | null,
      executorSessionId: null as string | null,
      frameStreamId: null as string | null,
      mediaParticipantId: null as string | null,
      mediaTrackSid: null as string | null,
      audioTrackSid: null as string | null,
      streamStartedAtMs: null as number | null,
      streamUpdatedAtMs: null as number | null,
      frameConnected: false,
      frameStreamUrl: null as string | null,
      lastFrameAtMs: 0,
      frameSize: null as { width: number; height: number } | null,
      localCanOpen: false,
      localCanInput: false,
      localHasControl: false,
      lastInputSeq: 0,
      lastExecutorInput: null as RemoteBrowserExecutorInputState | null,
      errorCode: null as RemoteBrowserErrorCode | string | null,
      mediaState: "idle" as string,
      mediaConnected: false,
      mediaHasVideo: false,
      mediaHasAudio: false,
      mediaPeerConnectionState: null as RTCPeerConnectionState | null,
      mediaErrorCode: null as string | null,
      mediaSourceRect: null as null | { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number },
      mediaCompositeHoldActive: false,
      externalVideoAttached: false,
      externalVideoObjectId: null as string | null,
      externalVideoTrackSid: null as string | null,
      externalVideoPaused: null as boolean | null,
      externalVideoReadyState: null as number | null,
      externalVideoCurrentTime: null as number | null,
      externalVideoWidth: 0,
      externalVideoHeight: 0,
      externalVideoMuted: null as boolean | null,
      externalVideoAutoplay: null as boolean | null,
      externalVideoPlayError: null as string | null,
      externalVideoFrameCount: 0,
      externalVideoLastFrameAtMs: 0,
      externalVideoPresentedFrames: 0,
      xrKeyboardToggleVisible: false,
      xrKeyboardVisible: false,
      xrKeyboardOpen: false,
      xrKeyboardLayout: "en-US" as string,
      xrKeyboardHoveredKey: null as string | null,
      xrKeyboardHoveredTarget: null as string | null,
      xrKeyboardPressedTarget: null as string | null,
      xrKeyboardLastKey: null as string | null
    },
    surfaceAudio: {
      surfaceId: DEBUG_SURFACE_ID,
      mediaAudioEnabled: false,
      canConfigure: false,
      pending: false,
      subscribedAudioCount: 0
    },
    whiteboard: {
      objectId: null as string | null,
      surfaceId: DEBUG_SURFACE_ID,
      active: false,
      strokeCount: 0,
      revision: 0,
      localCanDraw: false,
      localCanClear: false,
      drawToolActive: false,
      xrPointerActive: false,
      xrPencilVisible: false,
      localPreviewPointCount: 0,
      lastInputSource: null as SurfaceInputSource | null,
      lastPoint: null as null | { u: number; v: number },
      errorCode: null as string | null
    },
    markdownBoard: {
      objectId: null as string | null,
      surfaceId: DEBUG_SURFACE_ID,
      active: false,
      noteCount: 0,
      revision: 0,
      localCanEdit: false,
      lastInputEventId: null as string | null,
      errorCode: null as string | null,
      notes: [] as Array<{ noteId: string; text: string; x: number; y: number; width: number; height: number }>
    },
    mediaCapabilities: browserMediaCapabilities,
    clientCompatibility,
    spatialAudioState: "idle",
    spatialAudio: {
      enabled: spatialAudioQueryEnabled,
      fallback: !spatialAudioQueryEnabled,
      mode: spatialAudioQueryEnabled ? "idle" : "disabled",
      fallbackReason: spatialAudioQueryEnabled ? null as string | null : "query_disabled",
      listener: { x: 0, y: 1.6, z: 6, yaw: 0 },
      remoteSources: [] as Array<{
        participantId: string;
        x: number;
        y: number;
        z: number;
        attachedTo: "head" | "body" | "root";
        hasAudioNode: boolean;
        pannerActive: boolean;
        fallbackReason: string | null;
        audioLevel: number;
      }>
    },
    localPosition: { x: initialLocalPosition.x, z: initialLocalPosition.z },
    localPose: {
      root: { x: initialLocalPosition.x, y: initialLocalPosition.y, z: initialLocalPosition.z, yaw: 0 },
      head: { x: initialLocalPosition.x, y: initialLocalPosition.y + 1.6, z: initialLocalPosition.z, yaw: 0, pitch: 0 }
    },
    xrSession: xrSessionDebug,
    xrAxes: { moveX: 0, moveY: 0, turnX: 0, turnY: 0 },
    botMode,
    issueCode: null as RuntimeIssue["code"] | null,
    issueSeverity: null as RuntimeIssue["severity"] | null,
    degradedMode: "none",
    retryCount: 0,
    lastRecoveryAction: "none",
    featureFlags: runtimeFlags,
    faultInjection: faultConfig,
    lastPresenceSyncAt: 0,
    lastPresenceRefreshAt: 0,
    remoteTargets: [] as Array<{ id: string; x: number; z: number }>,
    remoteParticipants: [] as Array<{
      participantId: string;
      mode: PresenceState["mode"];
      root: { x: number; y: number; z: number; yaw: number };
      body: { x: number; y: number; z: number; yaw: number };
      head: { x: number; y: number; z: number; yaw: number; pitch: number };
      lastSeq: number;
      staleMs: number;
      updateHz: number;
      interpolationDelayMs: number;
      maxObservedJumpM: number;
      audioJoined: boolean;
      muted: boolean;
      speaking: boolean;
      activeAudio: boolean;
      hasVisualEntity: boolean;
      hasAudioNode: boolean;
      appliedRootYaw: number;
      appliedHeadYaw: number;
    }>,
    sceneBundleUrl: null as string | null,
    sceneBundleState: "fallback" as "fallback" | "loaded" | "failed",
    sceneDebug: createEmptySceneDiagnostics(),
    spaceSelectorState: "loading" as "loading" | "ready" | "empty" | "unavailable",
    availableSpaceCount: 0,
    avatarDebug: createEmptyAvatarDiagnostics(),
    avatarPresenceMode: "baseline" as "baseline" | "experimental-leg-ik",
    avatarSnapshot: null as LocalAvatarSnapshotV1 | null,
    avatarTransportPreview: null as AvatarOutboundPayload | null,
    avatarPoseTransport: {
      targetHz: 0,
      effectiveHz: 0,
      sendsInLastSecond: 0,
      lastPoseSentAtMs: 0,
      lastPoseSeq: 0,
      reconnectRepublishCount: 0,
      frameBudgetMs: 0,
      adaptivePlaybackDelayMs: 100
    },
    xrAvatarDebug: null as null | {
      profile: string | null;
      playerRoot: { x: number; y: number; z: number; yaw: number };
      headWorld: { x: number; y: number; z: number };
      leftGrip: { x: number; y: number; z: number } | null;
      rightGrip: { x: number; y: number; z: number } | null;
      leftController: { x: number; y: number; z: number } | null;
      rightController: { x: number; y: number; z: number } | null;
      leftResolved: { x: number; y: number; z: number } | null;
      rightResolved: { x: number; y: number; z: number } | null;
      rightHandWorld: { x: number; y: number; z: number } | null;
      rightControllerWorld: { x: number; y: number; z: number } | null;
    },
    remoteAvatarReliableStates: [] as Array<{ participantId: string; avatarId: string; inputMode: string; updatedAt: string }>,
    remoteAvatarPoseFrames: [] as Array<{ participantId: string; seq: number; locomotionMode: number; sentAtMs: number }>,
    currentSeatId: null as string | null,
    pendingSeatId: null as string | null,
    seatOccupancy: {} as Record<string, string>,
    interactionRay: {
      active: false,
      mode: "none" as "none" | "cursor" | "xr-right-stick",
      targetKind: "none" as "none" | "floor" | "seat" | "surface" | "keyboard",
      seatId: null as string | null,
      point: null as null | { x: number; y: number; z: number },
      origin: null as null | { x: number; y: number; z: number },
      direction: null as null | { x: number; y: number; z: number },
      source: null as null | { index: number; handedness: string | null }
    },
    surfaceInput: createSurfaceInputDebugState(DEBUG_SURFACE_ID),
    mediaObjects: {
      selectedSurfaceId: DEBUG_SURFACE_ID,
      physicalSurfaceIdsWithoutLogicalState: [] as string[],
      logicalSurfaceIdsWithoutPhysicalView: [] as string[],
      unrenderedObjectIds: [] as string[],
      runtimeResetCount: 0,
      lastRuntimeResetSurfaceIds: [] as string[],
      lastRuntimeResetSurfaceIdsWithCachedRuntimes: [] as string[],
      surfaces: [] as Array<{
        surfaceId: string;
        label?: string;
        allowedObjectTypes: string[];
        activeObjectId: string | null;
        activeObjectType: string | null;
        inputEnabled: boolean;
        mediaAudioEnabled: boolean;
        lockedByParticipantId: string | null;
        visible: boolean;
        runtimeVisible: boolean;
        widthM: number;
        heightM: number;
        widthPx: number;
        heightPx: number;
        maxDistanceM: number;
        position: { x: number; y: number; z: number };
        yaw: number;
        pitch: number;
        roll: number;
        manifestPosition: { x: number; y: number; z: number } | null;
        manifestYaw: number | null;
        manifestFormat: "default" | "f3" | "legacy";
        worldPosition: { x: number; y: number; z: number };
        worldYaw: number;
        textureId: number | null;
      }>,
      objects: [] as Array<{
        objectId: string;
        type: string;
        surfaceId: string;
        ownerParticipantId: string;
        state: unknown;
        revision: number;
        status: string;
      }>,
      extensions: getMediaExtensionDebugSnapshot(),
      availableObjectTypes: [] as string[],
      lastCommand: null as SurfaceCommandResult | null,
      blockedReason: null as string | null,
      activeTestCardClickCount: null as number | null
    },
    remoteAvatarParticipants: [] as Array<{
      participantId: string;
      avatarId: string | null;
      inputMode: string | null;
      presenceSeen: boolean;
      hasReliableState: boolean;
      hasPoseFrame: boolean;
      leftHandVisible: boolean;
      rightHandVisible: boolean;
      poseBufferDepth: number;
      droppedStaleCount: number;
      droppedReorderCount: number;
      lastPoseSeq: number | null;
      poseAgeMs: number | null;
      playbackDelayMs: number;
      mouthAmount: number;
      speakingActive: boolean;
      lipsyncSourceState: AvatarLipsyncSourceState | null;
    }>
  };
}
