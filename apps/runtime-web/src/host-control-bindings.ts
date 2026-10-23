import type {
  grantRoomPresenter, removeRoomParticipant, revokeRoomPresenter,
  runRoomSessionControlAction, transferRoomHost, transferRoomOwner
} from "./index.js";
import type { HostControlElements, HostControlsContext, createHostControlsRuntime } from "./host-controls-runtime.js";

type HostControlsRuntime = ReturnType<typeof createHostControlsRuntime>;

export interface HostControlBindingsContext extends Pick<HostControlElements,
  "hostParticipantSelect" | "lockRoomButton" | "unlockRoomButton" | "endSessionButton" |
  "removeParticipantButton" | "transferHostButton" | "transferOwnerButton" | "grantPresenterButton" | "revokePresenterButton"
>, Pick<HostControlsRuntime, "renderHostControls" | "runHostControlAction" | "canManageHostControls" | "authorityRevision" | "participantLabel"> {
  apiBaseUrl: string;
  roomId: string;
  readonly roomStateAccessToken: string;
  debugState: Pick<HostControlsContext["debugState"], "hostControls" | "personalRoom">;
  runRoomSessionControlAction: typeof runRoomSessionControlAction;
  removeRoomParticipant: typeof removeRoomParticipant;
  transferRoomHost: typeof transferRoomHost;
  transferRoomOwner: typeof transferRoomOwner;
  grantRoomPresenter: typeof grantRoomPresenter;
  revokeRoomPresenter: typeof revokeRoomPresenter;
}

export function bindHostControls(context: HostControlBindingsContext): void {
  const {
    apiBaseUrl, roomId, debugState, hostParticipantSelect,
    lockRoomButton, unlockRoomButton, endSessionButton, removeParticipantButton,
    transferHostButton, grantPresenterButton, revokePresenterButton,
    renderHostControls, runHostControlAction, runRoomSessionControlAction,
    removeRoomParticipant, transferRoomHost, transferRoomOwner, canManageHostControls, authorityRevision, participantLabel, grantRoomPresenter, revokeRoomPresenter
  } = context;

  lockRoomButton.addEventListener("click", () => {
    void runHostControlAction(
      () => runRoomSessionControlAction(apiBaseUrl, roomId, context.roomStateAccessToken, "lock"),
      "Room locked"
    );
  });

  unlockRoomButton.addEventListener("click", () => {
    void runHostControlAction(
      () => runRoomSessionControlAction(apiBaseUrl, roomId, context.roomStateAccessToken, "unlock"),
      "Room unlocked"
    );
  });

  endSessionButton.addEventListener("click", () => {
    void runHostControlAction(
      () => runRoomSessionControlAction(apiBaseUrl, roomId, context.roomStateAccessToken, "end"),
      "Session ended"
    );
  });

  hostParticipantSelect.addEventListener("change", () => {
    debugState.hostControls.selectedParticipantId = hostParticipantSelect.value || null;
    renderHostControls();
  });

  removeParticipantButton.addEventListener("click", () => {
    const targetParticipantId = hostParticipantSelect.value;
    if (!targetParticipantId) {
      return;
    }
    void runHostControlAction(
      () => removeRoomParticipant(apiBaseUrl, roomId, context.roomStateAccessToken, targetParticipantId),
      `Removed ${participantLabel(targetParticipantId)}`
    );
  });

  transferHostButton.addEventListener("click", () => {
    const targetParticipantId = hostParticipantSelect.value;
    if (!targetParticipantId) {
      return;
    }
    void runHostControlAction(
      () => transferRoomHost(apiBaseUrl, roomId, context.roomStateAccessToken, targetParticipantId),
      `Transferred host to ${participantLabel(targetParticipantId)}`
    );
  });

  context.transferOwnerButton.addEventListener("click", () => {
    const target = hostParticipantSelect.value, revision = authorityRevision();
    if (!target || revision === null || !canManageHostControls() || !context.debugState.personalRoom.isOwner) return;
    void runHostControlAction(() => transferRoomOwner(apiBaseUrl, roomId, context.roomStateAccessToken, target, revision),
      `Transferred ownership to ${participantLabel(target)}`);
  });

  grantPresenterButton.addEventListener("click", () => {
    const targetParticipantId = hostParticipantSelect.value;
    if (!targetParticipantId) {
      return;
    }
    void runHostControlAction(
      () => grantRoomPresenter(apiBaseUrl, roomId, context.roomStateAccessToken, targetParticipantId),
      `Granted presenter to ${participantLabel(targetParticipantId)}`
    );
  });

  revokePresenterButton.addEventListener("click", () => {
    const targetParticipantId = hostParticipantSelect.value;
    if (!targetParticipantId) {
      return;
    }
    void runHostControlAction(
      () => revokeRoomPresenter(apiBaseUrl, roomId, context.roomStateAccessToken, targetParticipantId),
      `Revoked presenter from ${participantLabel(targetParticipantId)}`
    );
  });
}
