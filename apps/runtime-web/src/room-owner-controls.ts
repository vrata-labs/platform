/** Ownership is independent from the Host role. A verified v2 owner of a
 * personal room may control that room even when admitted as a Member. */
export function canManageRoomControls(input: {
  enabled: boolean;
  canManageSession: boolean;
  identityProtocolVersion: 2 | null;
  roomType: "standard" | "personal";
  isOwner: boolean;
}): boolean {
  return input.enabled && (input.canManageSession
    || input.identityProtocolVersion === 2 && input.roomType === "personal" && input.isOwner);
}

export function canTransferRoomOwnership(input: {
  controlsVisible: boolean;
  identityProtocolVersion: 2 | null;
  roomType: "standard" | "personal";
  isOwner: boolean;
  selectedParticipantId: string | null;
  localParticipantId: string;
  selectedIsPresent: boolean;
  authorityRevision: number | null;
  actionInFlight: boolean;
}): boolean {
  return input.controlsVisible && input.identityProtocolVersion === 2 && input.roomType === "personal"
    && input.isOwner && Boolean(input.selectedParticipantId) && input.selectedIsPresent
    && input.selectedParticipantId !== input.localParticipantId
    && input.authorityRevision !== null && !input.actionInFlight;
}

export function staleAuthorityResponse(currentRevision: number | null, responseRevision: number | undefined): boolean {
  return currentRevision !== null && responseRevision !== undefined && responseRevision < currentRevision;
}
