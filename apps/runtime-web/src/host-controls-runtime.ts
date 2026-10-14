import type { PresenceState, RuntimeSessionControlResponse, fetchRoomSessionControl } from "./index.js";
import type { createRuntimeDebugState } from "./runtime-debug-state.js";
import { mergePresenceSources } from "./presence-sources.js";
import { canManageRoomControls, canTransferRoomOwnership, staleAuthorityResponse } from "./room-owner-controls.js";

type RuntimeDebugState = ReturnType<typeof createRuntimeDebugState>;
type Button = Pick<HTMLButtonElement, "disabled" | "addEventListener">;

export interface HostControlElements {
  hostControlsEl: Pick<HTMLElement, "hidden">;
  hostControlsStatusEl: Pick<HTMLElement, "textContent">;
  presenterLineEl: Pick<HTMLElement, "textContent">;
  hostParticipantSelect: Pick<HTMLSelectElement, "value" | "disabled" | "replaceChildren" | "appendChild" | "addEventListener">;
  lockRoomButton: Button;
  unlockRoomButton: Button;
  endSessionButton: Button;
  removeParticipantButton: Button;
  transferHostButton: Button;
  transferOwnerButton: Button & Pick<HTMLButtonElement, "hidden">;
  grantPresenterButton: Button;
  revokePresenterButton: Button;
}

export interface HostControlsContext extends HostControlElements {
  apiBaseUrl: string;
  roomId: string;
  readonly participantId: string;
  readonly roomStateAccessToken: string;
  readonly runtimeFlags: { hostControlsEnabled: boolean };
  readonly latestRealtimeParticipants: PresenceState[];
  readonly latestFallbackParticipants: PresenceState[];
  readonly sessionControlBlocked: boolean;
  readonly activeIdentityProtocolVersion: 2 | null;
  debugState: {
    access: Pick<RuntimeDebugState["access"], "canManageRoomSession">;
    hostControls: RuntimeDebugState["hostControls"];
    personalRoom: Pick<RuntimeDebugState["personalRoom"], "roomType" | "isOwner" | "ownerParticipantId">;
  };
  fetchRoomSessionControl: typeof fetchRoomSessionControl;
  applyAccessDebug(access: NonNullable<RuntimeSessionControlResponse["access"]>, token: string, expiresInSeconds?: number): void;
  disableRuntimeForSessionBlock(reason: string): void;
}

export const SESSION_CONTROL_REFRESH_INTERVAL_MS = 1000;

export function createHostControlsRuntime(context: HostControlsContext) {
  const {
    apiBaseUrl, roomId, hostControlsEl,
    hostControlsStatusEl, presenterLineEl, hostParticipantSelect,
    lockRoomButton, unlockRoomButton, endSessionButton, removeParticipantButton,
    transferHostButton, transferOwnerButton, grantPresenterButton, revokePresenterButton,
    fetchRoomSessionControl, applyAccessDebug, disableRuntimeForSessionBlock
  } = context;
  // These four values belong to this session controller. External runtime
  // state stays live through context getters, including across awaits.
  let latestSessionControl: RuntimeSessionControlResponse["state"] | null = null;
  let hostControlActionInFlight = false;
  let sessionControlRefreshInFlight = false;
  let lastSessionControlRefreshAtMs = 0;
  let latestIdentityAuthorityRevision: number | null = null;

  function canManageHostControls(): boolean {
    return !context.sessionControlBlocked && canManageRoomControls({ enabled: context.runtimeFlags.hostControlsEnabled,
      canManageSession: context.debugState.access.canManageRoomSession === true,
      identityProtocolVersion: context.activeIdentityProtocolVersion,
      roomType: context.debugState.personalRoom.roomType, isOwner: context.debugState.personalRoom.isOwner });
  }

  function currentVisibleParticipants(): PresenceState[] {
    return mergePresenceSources(context.latestRealtimeParticipants, context.latestFallbackParticipants)
      .sort((left, right) => (left.displayName || left.participantId).localeCompare(right.displayName || right.participantId));
  }

  function renderHostControls(statusMessage?: string): void {
    const participantId = context.participantId;
    const visible = canManageHostControls() && latestSessionControl?.endedAt == null;
    hostControlsEl.hidden = !visible;
    context.debugState.hostControls.enabled = context.runtimeFlags.hostControlsEnabled;
    context.debugState.hostControls.visible = visible;
    context.debugState.hostControls.locked = Boolean(latestSessionControl?.lockedAt);
    context.debugState.hostControls.ended = Boolean(latestSessionControl?.endedAt);
    context.debugState.hostControls.hostParticipantId = latestSessionControl?.hostParticipantId ?? null;
    context.debugState.hostControls.presenterParticipantId = latestSessionControl?.presenterParticipantId ?? null;
    const presenterParticipantId = latestSessionControl?.presenterParticipantId ?? null;
    const presenterParticipant = presenterParticipantId ? currentVisibleParticipants().find((item) => item.participantId === presenterParticipantId) : null;
    presenterLineEl.textContent = presenterParticipantId
      ? `Presenter: ${presenterParticipant?.displayName || presenterParticipantId}`
      : "Presenter: none";
    if (statusMessage) {
      hostControlsStatusEl.textContent = statusMessage;
      context.debugState.hostControls.status = statusMessage;
    } else if (visible) {
      const state = latestSessionControl?.lockedAt ? "locked" : "open";
      hostControlsStatusEl.textContent = `Room ${state}${latestSessionControl?.hostParticipantId ? `; host ${latestSessionControl.hostParticipantId}` : ""}${presenterParticipantId ? `; presenter ${presenterParticipantId}` : ""}`;
      context.debugState.hostControls.status = hostControlsStatusEl.textContent;
    }

    const previousSelection = hostParticipantSelect.value;
    hostParticipantSelect.replaceChildren();
    const participants = currentVisibleParticipants();
    for (const participant of participants) {
      const option = document.createElement("option");
      option.value = participant.participantId;
      option.textContent = `${participant.displayName || participant.participantId} (${participant.role ?? "guest"})`;
      option.selected = participant.participantId === previousSelection;
      hostParticipantSelect.appendChild(option);
    }
    if (presenterParticipantId && !participants.some((participant) => participant.participantId === presenterParticipantId)) {
      const option = document.createElement("option");
      option.value = presenterParticipantId;
      option.textContent = `${presenterParticipantId} (presenter offline)`;
      option.selected = presenterParticipantId === previousSelection;
      hostParticipantSelect.appendChild(option);
    }
    if (participants.length === 0 && !presenterParticipantId) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No participants";
      hostParticipantSelect.appendChild(option);
    }
    const selected = hostParticipantSelect.value || participants[0]?.participantId || "";
    if (selected) {
      hostParticipantSelect.value = selected;
    }
    context.debugState.hostControls.selectedParticipantId = selected || null;
    const selectedIsPresent = participants.some((participant) => participant.participantId === selected);

    hostParticipantSelect.disabled = !visible || (!participants.length && !presenterParticipantId) || hostControlActionInFlight;
    lockRoomButton.disabled = !visible || Boolean(latestSessionControl?.lockedAt) || hostControlActionInFlight;
    unlockRoomButton.disabled = !visible || !latestSessionControl?.lockedAt || hostControlActionInFlight;
    endSessionButton.disabled = !visible || hostControlActionInFlight;
    removeParticipantButton.disabled = !visible || !selected || !selectedIsPresent || selected === participantId || hostControlActionInFlight;
    transferHostButton.disabled = !visible || !selected || !selectedIsPresent || selected === latestSessionControl?.hostParticipantId || hostControlActionInFlight;
    transferOwnerButton.hidden = !(context.activeIdentityProtocolVersion === 2 && context.debugState.personalRoom.roomType === "personal" && context.debugState.personalRoom.isOwner);
    transferOwnerButton.disabled = !canTransferRoomOwnership({ controlsVisible: visible,
      identityProtocolVersion: context.activeIdentityProtocolVersion, roomType: context.debugState.personalRoom.roomType,
      isOwner: context.debugState.personalRoom.isOwner, selectedParticipantId: selected, localParticipantId: participantId,
      selectedIsPresent, authorityRevision: latestIdentityAuthorityRevision, actionInFlight: hostControlActionInFlight });
    grantPresenterButton.disabled = !visible || !selected || !selectedIsPresent || selected === presenterParticipantId || hostControlActionInFlight;
    revokePresenterButton.disabled = !visible || !selected || selected !== presenterParticipantId || hostControlActionInFlight;
  }

  function applySessionControlResponse(payload: RuntimeSessionControlResponse, statusMessage?: string): void {
    if (context.sessionControlBlocked) return;
    if (payload.participant?.status === "blocked" && payload.participant.reason) {
      latestSessionControl = payload.state;
      disableRuntimeForSessionBlock(payload.participant.reason);
      return;
    }
    const revision = payload.authorityRevision ?? payload.revision;
    if (staleAuthorityResponse(latestIdentityAuthorityRevision, revision)) return;
    if (revision !== undefined && Number.isSafeInteger(revision) && revision >= 0) latestIdentityAuthorityRevision = revision;
    latestSessionControl = payload.state;
    if (context.activeIdentityProtocolVersion === 2 && context.debugState.personalRoom.roomType === "personal") {
      if ("ownerParticipantId" in payload) {
        context.debugState.personalRoom.ownerParticipantId = payload.ownerParticipantId ?? null;
        context.debugState.personalRoom.isOwner = payload.ownerParticipantId === context.participantId;
      } else if (payload.participant?.isOwner !== undefined) context.debugState.personalRoom.isOwner = payload.participant.isOwner;
    }
    if (payload.access && payload.token) {
      applyAccessDebug(payload.access, payload.token, payload.expiresInSeconds);
    }
    renderHostControls(statusMessage);
  }

  async function refreshSessionControl(force = false): Promise<void> {
    const nowMs = Date.now();
    if (context.sessionControlBlocked || !context.runtimeFlags.hostControlsEnabled || !context.roomStateAccessToken || sessionControlRefreshInFlight || (!force && nowMs - lastSessionControlRefreshAtMs < SESSION_CONTROL_REFRESH_INTERVAL_MS)) {
      return;
    }
    sessionControlRefreshInFlight = true;
    lastSessionControlRefreshAtMs = nowMs;
    try {
      applySessionControlResponse(await fetchRoomSessionControl(apiBaseUrl, roomId, context.roomStateAccessToken));
    } catch (error) {
      console.warn("session_control_refresh_failed", error);
    } finally {
      sessionControlRefreshInFlight = false;
    }
  }

  async function runHostControlAction(action: () => Promise<RuntimeSessionControlResponse>, statusMessage: string): Promise<void> {
    if (hostControlActionInFlight) {
      return;
    }
    hostControlActionInFlight = true;
    renderHostControls("Applying host action...");
    try {
      applySessionControlResponse(await action(), statusMessage);
    } catch (error) {
      console.error(error);
      renderHostControls("Host action failed");
    } finally {
      hostControlActionInFlight = false;
      renderHostControls();
    }
  }

  return { renderHostControls, refreshSessionControl, runHostControlAction, canManageHostControls,
    authorityRevision: () => latestIdentityAuthorityRevision };
}
