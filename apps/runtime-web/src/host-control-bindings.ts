import type {
  grantRoomPresenter, removeRoomParticipant, revokeRoomPresenter,
  runRoomSessionControlAction, transferRoomHost
} from "./index.js";
import type { HostControlElements, HostControlsContext, createHostControlsRuntime } from "./host-controls-runtime.js";

type HostControlsRuntime = ReturnType<typeof createHostControlsRuntime>;

export interface HostControlBindingsContext extends Pick<HostControlElements,
  "hostParticipantSelect" | "lockRoomButton" | "unlockRoomButton" | "endSessionButton" |
  "removeParticipantButton" | "transferHostButton" | "grantPresenterButton" | "revokePresenterButton"
>, Pick<HostControlsRuntime, "renderHostControls" | "runHostControlAction"> {
  apiBaseUrl: string;
  roomId: string;
  readonly roomStateAccessToken: string;
  debugState: Pick<HostControlsContext["debugState"], "hostControls">;
  runRoomSessionControlAction: typeof runRoomSessionControlAction;
  removeRoomParticipant: typeof removeRoomParticipant;
  transferRoomHost: typeof transferRoomHost;
  grantRoomPresenter: typeof grantRoomPresenter;
  revokeRoomPresenter: typeof revokeRoomPresenter;
}

export function bindHostControls(context: HostControlBindingsContext): void {
  const {
    apiBaseUrl, roomId, debugState, hostParticipantSelect,
    lockRoomButton, unlockRoomButton, endSessionButton, removeParticipantButton,
    transferHostButton, grantPresenterButton, revokePresenterButton,
    renderHostControls, runHostControlAction, runRoomSessionControlAction,
    removeRoomParticipant, transferRoomHost, grantRoomPresenter, revokeRoomPresenter
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
      `Removed ${targetParticipantId}`
    );
  });

  transferHostButton.addEventListener("click", () => {
    const targetParticipantId = hostParticipantSelect.value;
    if (!targetParticipantId) {
      return;
    }
    void runHostControlAction(
      () => transferRoomHost(apiBaseUrl, roomId, context.roomStateAccessToken, targetParticipantId),
      `Transferred host to ${targetParticipantId}`
    );
  });

  grantPresenterButton.addEventListener("click", () => {
    const targetParticipantId = hostParticipantSelect.value;
    if (!targetParticipantId) {
      return;
    }
    void runHostControlAction(
      () => grantRoomPresenter(apiBaseUrl, roomId, context.roomStateAccessToken, targetParticipantId),
      `Granted presenter to ${targetParticipantId}`
    );
  });

  revokePresenterButton.addEventListener("click", () => {
    const targetParticipantId = hostParticipantSelect.value;
    if (!targetParticipantId) {
      return;
    }
    void runHostControlAction(
      () => revokeRoomPresenter(apiBaseUrl, roomId, context.roomStateAccessToken, targetParticipantId),
      `Revoked presenter from ${targetParticipantId}`
    );
  });
}
