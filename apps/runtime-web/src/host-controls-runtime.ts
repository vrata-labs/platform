import type { PresenceState, RuntimeSessionControlResponse, fetchRoomSessionControl } from "./index.js";
import type { createRuntimeDebugState } from "./runtime-debug-state.js";
import { mergePresenceSources } from "./presence-sources.js";
import { canManageRoomControls, canTransferRoomOwnership, staleAuthorityResponse } from "./room-owner-controls.js";
import { parseAuthorityRevision, parseAuthoritySlots, parseParticipantAuthority, participantAuthorityKey, type AuthoritySlots, type ParticipantAuthorityProjection } from "./participant-authority.js";
import type { RoomAccessDebugState, RoomPermission, RoomRole } from "@vrata/shared-types";
import { meetingDisplayName, meetingPersonRole, meetingRoleLabel, type MeetingPeopleAuthority } from "./meeting/meeting-people.js";

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
    access: Pick<RuntimeDebugState["access"], "canManageRoomSession"> & { role?: RoomRole };
    hostControls: RuntimeDebugState["hostControls"];
    personalRoom: Pick<RuntimeDebugState["personalRoom"], "roomType" | "isOwner" | "ownerParticipantId">;
  };
  fetchRoomSessionControl: typeof fetchRoomSessionControl;
  applyAccessDebug(access: NonNullable<RuntimeSessionControlResponse["access"]>, token: string, expiresInSeconds?: number): void;
  applyAuthorityAccess(access: RoomAccessDebugState): void;
  disableRuntimeForSessionBlock(reason: string): void;
  onAuthorityChanged?(): void;
}

export const SESSION_CONTROL_REFRESH_INTERVAL_MS = 1000;

export function createHostControlsRuntime(context: HostControlsContext) {
  const {
    apiBaseUrl, roomId, hostControlsEl,
    hostControlsStatusEl, presenterLineEl, hostParticipantSelect,
    lockRoomButton, unlockRoomButton, endSessionButton, removeParticipantButton,
    transferHostButton, transferOwnerButton, grantPresenterButton, revokePresenterButton,
    fetchRoomSessionControl, applyAccessDebug, applyAuthorityAccess, disableRuntimeForSessionBlock
  } = context;
  // These four values belong to this session controller. External runtime
  // state stays live through context getters, including across awaits.
  let latestSessionControl: RuntimeSessionControlResponse["state"] | null = null;
  let hostControlActionInFlight = false;
  let sessionControlRefreshInFlight = false;
  let lastSessionControlRefreshAtMs = 0;
  let latestIdentityAuthorityRevision: number | null = null;
  let latestAuthoritySlots: AuthoritySlots | undefined;
  let latestAccessKey: string | null = null;
  let latestAccessRevision: number | null = null;
  let controlEpoch = 0;
  let refreshAfterAction = false;
  let notification: string | null = null;
  const knownNames = new Map<string, string>();
  let latestControlKey: string | null = null;
  let ownerProjectionKnown = false;
  let mediaSynchronizationPending = false;
  let refreshStarted = 0, refreshFinished = 0, lastRefreshStartedAtMs = 0, lastRefreshFinishedAtMs = 0;
  let lastRefreshOutcome: "idle" | "pending" | "applied" | "ignored" | "failed" = "idle";

  const sameBinding = (participantId: string, protocol: 2 | null) => !context.sessionControlBlocked
    && context.participantId === participantId && context.activeIdentityProtocolVersion === protocol;

  function projectOwner(payload: RuntimeSessionControlResponse, projection?: ParticipantAuthorityProjection): void {
    if (context.activeIdentityProtocolVersion !== 2 || context.debugState.personalRoom.roomType !== "personal") return;
    if ("ownerParticipantId" in payload) {
      ownerProjectionKnown = true;
      context.debugState.personalRoom.ownerParticipantId = payload.ownerParticipantId ?? null;
      context.debugState.personalRoom.isOwner = payload.ownerParticipantId === context.participantId;
    } else if (projection) {
      context.debugState.personalRoom.isOwner = projection.isOwner;
      if (projection.isOwner) { context.debugState.personalRoom.ownerParticipantId = projection.participantId; ownerProjectionKnown = true; }
      else if (context.debugState.personalRoom.ownerParticipantId === projection.participantId) context.debugState.personalRoom.ownerParticipantId = null;
    }
  }

  function canManageHostControls(): boolean {
    return !context.sessionControlBlocked && canManageRoomControls({ enabled: context.runtimeFlags.hostControlsEnabled,
      canManageSession: context.debugState.access.canManageRoomSession === true,
      identityProtocolVersion: context.activeIdentityProtocolVersion,
      roomType: context.debugState.personalRoom.roomType, isOwner: context.debugState.personalRoom.isOwner });
  }

  function currentVisibleParticipants(): PresenceState[] {
    return mergePresenceSources(context.latestRealtimeParticipants, context.latestFallbackParticipants)
      .sort((left, right) => (meetingDisplayName(left.displayName) ?? "Participant").localeCompare(meetingDisplayName(right.displayName) ?? "Participant"));
  }

  function peopleAuthority(): MeetingPeopleAuthority {
    return { identityProtocolVersion: context.activeIdentityProtocolVersion, stateKnown: latestSessionControl !== null,
      selfRole: context.debugState.access.role ?? null,
      hostParticipantId: latestSessionControl?.hostParticipantId ?? null,
      presenterParticipantId: latestSessionControl?.presenterParticipantId ?? null,
      ownerParticipantId: context.activeIdentityProtocolVersion === 2 && context.debugState.personalRoom.roomType === "personal" && ownerProjectionKnown ? context.debugState.personalRoom.ownerParticipantId ?? null : null,
      slots: latestAuthoritySlots };
  }

  function participantName(participantId: string, participants: PresenceState[]): string {
    const slot = latestAuthoritySlots && Object.values(latestAuthoritySlots).find(slot => slot?.participantId === participantId);
    return meetingDisplayName(slot?.displayName) ?? meetingDisplayName(participants.find(person => person.participantId === participantId)?.displayName)
      ?? knownNames.get(participantId) ?? "Participant";
  }

  function renderHostControls(statusMessage?: string): void {
    if (statusMessage !== undefined) notification = statusMessage;
    const participantId = context.participantId;
    const participants = currentVisibleParticipants(), authority = peopleAuthority();
    for (const person of participants) {
      const name = meetingDisplayName(person.displayName);
      if (name) { knownNames.delete(person.participantId); knownNames.set(person.participantId, name); }
    }
    while (knownNames.size > 256) knownNames.delete(knownNames.keys().next().value!);
    const visible = canManageHostControls() && latestSessionControl?.endedAt == null;
    hostControlsEl.hidden = !visible;
    context.debugState.hostControls.enabled = context.runtimeFlags.hostControlsEnabled;
    context.debugState.hostControls.visible = visible;
    context.debugState.hostControls.locked = Boolean(latestSessionControl?.lockedAt);
    context.debugState.hostControls.ended = Boolean(latestSessionControl?.endedAt);
    context.debugState.hostControls.hostParticipantId = latestSessionControl?.hostParticipantId ?? null;
    context.debugState.hostControls.presenterParticipantId = latestSessionControl?.presenterParticipantId ?? null;
    const presenterParticipantId = latestSessionControl?.presenterParticipantId ?? null;
    presenterLineEl.textContent = presenterParticipantId
      ? `Presenter: ${participantName(presenterParticipantId, participants)}${participants.some(person => person.participantId === presenterParticipantId) ? "" : " (offline)"}`
      : "Presenter: none";
    if (notification !== null) {
      hostControlsStatusEl.textContent = notification + (mediaSynchronizationPending ? " Screen-sharing synchronization has not been confirmed yet." : "");
      context.debugState.hostControls.status = hostControlsStatusEl.textContent;
    } else if (visible) {
      const state = latestSessionControl?.lockedAt ? "locked" : "open";
      hostControlsStatusEl.textContent = `Room ${state}${presenterParticipantId ? "; presenting access assigned" : ""}${mediaSynchronizationPending ? "; screen-sharing synchronization pending" : ""}`;
      context.debugState.hostControls.status = hostControlsStatusEl.textContent;
    }

    const previousSelection = hostParticipantSelect.value;
    hostParticipantSelect.replaceChildren();
    for (const participant of participants) {
      const option = document.createElement("option");
      option.value = participant.participantId;
      option.textContent = `${meetingRoleLabel(meetingPersonRole(participant, participantId, authority), authority.ownerParticipantId === participant.participantId)} — ${participantName(participant.participantId, participants)}${participant.participantId === participantId ? " (you)" : ""}`;
      option.selected = participant.participantId === previousSelection;
      hostParticipantSelect.appendChild(option);
    }
    if (presenterParticipantId && !participants.some((participant) => participant.participantId === presenterParticipantId)) {
      const option = document.createElement("option");
      option.value = presenterParticipantId;
      option.textContent = `Presenter, offline — ${participantName(presenterParticipantId, participants)}`;
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
    context.onAuthorityChanged?.();
  }

  function applySessionControlResponse(payload: RuntimeSessionControlResponse, statusMessage?: string): boolean {
    if (context.sessionControlBlocked) return false;
    const v2 = context.activeIdentityProtocolVersion === 2;
    const revision = payload.authorityRevision ?? payload.revision;
    if (v2 && parseAuthorityRevision(revision) === null) return false;
    if (v2 && payload.participant && payload.participant.participantId !== context.participantId) return false;
    if (payload.participant?.status === "blocked" && payload.participant.reason) {
      latestSessionControl = payload.state;
      disableRuntimeForSessionBlock(payload.participant.reason);
      return true;
    }
    if (staleAuthorityResponse(latestIdentityAuthorityRevision, revision)) return false;
    const projection = v2 && payload.participant ? parseParticipantAuthority(payload.participant, revision, context.participantId) : null;
    const slots = v2 ? parseAuthoritySlots(payload.slots) : undefined;
    if (v2 && (payload.participant && !projection || slots === null
      || "ownerParticipantId" in payload && payload.ownerParticipantId !== null
        && (typeof payload.ownerParticipantId !== "string" || !payload.ownerParticipantId.length || payload.ownerParticipantId.length > 200))) return false;
    if (projection && "ownerParticipantId" in payload && projection.isOwner !== (payload.ownerParticipantId === projection.participantId)) return false;
    if (projection && latestAccessRevision === projection.revision && latestAccessKey !== null && participantAuthorityKey(projection) !== latestAccessKey) return false;
    const controlKey = JSON.stringify([Boolean(payload.state.lockedAt), Boolean(payload.state.endedAt), payload.state.hostParticipantId ?? null,
      payload.state.presenterParticipantId ?? null, "ownerParticipantId" in payload ? payload.ownerParticipantId : context.debugState.personalRoom.ownerParticipantId ?? null]);
    if (statusMessage === undefined && !hostControlActionInFlight && latestControlKey !== controlKey) notification = null;
    latestControlKey = controlKey;
    if (payload.mediaScreenReconciliation) {
      mediaSynchronizationPending = payload.mediaScreenReconciliation.state !== "observed"
        || payload.mediaScreenReconciliation.desiredVersion?.authorityRevision !== revision;
    }
    if (revision !== undefined && Number.isSafeInteger(revision) && revision >= 0) latestIdentityAuthorityRevision = revision;
    latestSessionControl = payload.state;
    if (slots) latestAuthoritySlots = slots;
    projectOwner(payload, projection ?? undefined);
    if (projection) {
      const key = participantAuthorityKey(projection);
      const changed = key !== latestAccessKey;
      latestAccessKey = key; latestAccessRevision = projection.revision;
      if (changed) applyAuthorityAccess(projection.access);
    } else if (!v2 && payload.access && payload.token) {
      applyAccessDebug(payload.access, payload.token, payload.expiresInSeconds);
    }
    renderHostControls(statusMessage);
    return true;
  }

  async function refreshSessionControl(force = false): Promise<void> {
    const nowMs = Date.now();
    if (context.sessionControlBlocked || (!context.runtimeFlags.hostControlsEnabled && context.activeIdentityProtocolVersion !== 2) || !context.roomStateAccessToken || sessionControlRefreshInFlight || (!force && nowMs - lastSessionControlRefreshAtMs < SESSION_CONTROL_REFRESH_INTERVAL_MS)) {
      return;
    }
    sessionControlRefreshInFlight = true;
    refreshStarted++; lastRefreshStartedAtMs = nowMs; lastRefreshOutcome = "pending";
    lastSessionControlRefreshAtMs = nowMs;
    const participantId = context.participantId, protocol = context.activeIdentityProtocolVersion, epoch = controlEpoch;
    try {
      const payload = await fetchRoomSessionControl(apiBaseUrl, roomId, context.roomStateAccessToken);
      lastRefreshOutcome = sameBinding(participantId, protocol) && epoch === controlEpoch && applySessionControlResponse(payload) ? "applied" : "ignored";
    } catch (error) {
      lastRefreshOutcome = "failed";
      console.warn("session_control_refresh_failed", error);
    } finally {
      sessionControlRefreshInFlight = false;
      refreshFinished++; lastRefreshFinishedAtMs = Date.now();
      if (refreshAfterAction && !context.sessionControlBlocked) { refreshAfterAction = false; void refreshSessionControl(true); }
    }
  }

  async function runHostControlAction(action: () => Promise<RuntimeSessionControlResponse>, statusMessage: string): Promise<void> {
    if (hostControlActionInFlight || context.sessionControlBlocked) {
      return;
    }
    hostControlActionInFlight = true;
    controlEpoch++;
    const participantId = context.participantId, protocol = context.activeIdentityProtocolVersion;
    let refreshNeeded = false;
    renderHostControls("Applying host action...");
    try {
      const payload = await action();
      if (sameBinding(participantId, protocol)) {
        const accepted = applySessionControlResponse(payload, statusMessage);
        if (!accepted && !context.sessionControlBlocked) renderHostControls("Host action response could not be verified. Refreshing room access...");
        refreshNeeded = protocol === 2;
      }
    } catch (error) {
      if (!sameBinding(participantId, protocol)) return;
      console.error(error);
      renderHostControls("Host action could not be confirmed. Check the current room state before retrying.");
      refreshNeeded = protocol === 2 && sameBinding(participantId, protocol);
    } finally {
      controlEpoch++;
      hostControlActionInFlight = false;
      renderHostControls();
      if (refreshNeeded && sameBinding(participantId, protocol)) {
        if (sessionControlRefreshInFlight) refreshAfterAction = true;
        else void refreshSessionControl(true);
      }
    }
  }

  function observeAdmissionRevision(revision: unknown, source?: { participantId?: string; access: RoomAccessDebugState; isOwner?: boolean }): void {
    if (context.activeIdentityProtocolVersion !== 2 || context.sessionControlBlocked) return;
    const parsed = parseAuthorityRevision(revision);
    if (parsed === null || staleAuthorityResponse(latestIdentityAuthorityRevision, parsed)) return;
    if (source) {
      const projection = parseParticipantAuthority({ participantId: source.participantId, role: source.access.role,
        permissions: source.access.permissions, isOwner: source.isOwner === true, status: "active" }, parsed, context.participantId);
      if (!projection || latestAccessRevision === parsed && latestAccessKey !== null && participantAuthorityKey(projection) !== latestAccessKey) return;
      latestAccessRevision = parsed; latestAccessKey = participantAuthorityKey(projection);
      projectOwner({ state: latestSessionControl ?? {} }, projection);
    }
    latestIdentityAuthorityRevision = parsed;
  }

  function acceptRenewedAuthority(value: { participantId?: string; role: RoomRole; permissions: RoomPermission[]; isOwner?: boolean; authorityRevision?: number }): RoomAccessDebugState | null {
    if (context.activeIdentityProtocolVersion !== 2 || context.sessionControlBlocked) return null;
    const projection = parseParticipantAuthority({ ...value, status: "active" }, value.authorityRevision, context.participantId);
    if (!projection || staleAuthorityResponse(latestIdentityAuthorityRevision, projection.revision)) return null;
    const key = participantAuthorityKey(projection);
    if (latestAccessRevision === projection.revision && latestAccessKey !== null && key !== latestAccessKey) return null;
    latestIdentityAuthorityRevision = projection.revision; latestAccessKey = key; latestAccessRevision = projection.revision;
    projectOwner({ state: latestSessionControl ?? {} }, projection);
    return projection.access;
  }

  return { renderHostControls, refreshSessionControl, runHostControlAction, canManageHostControls,
    refreshDiagnostics: () => ({ started: refreshStarted, finished: refreshFinished, inFlight: sessionControlRefreshInFlight,
      lastStartedAtMs: lastRefreshStartedAtMs, lastFinishedAtMs: lastRefreshFinishedAtMs, outcome: lastRefreshOutcome,
      enabled: context.runtimeFlags.hostControlsEnabled, blocked: context.sessionControlBlocked, hasCredential: Boolean(context.roomStateAccessToken) }),
    authorityRevision: () => latestIdentityAuthorityRevision, authoritySlots: () => latestAuthoritySlots, peopleAuthority,
    participantLabel: (participantId: string) => `“${participantName(participantId, currentVisibleParticipants()).replace(/[“”"]/g, "'")}”`,
    observeAdmissionRevision, acceptRenewedAuthority };
}
