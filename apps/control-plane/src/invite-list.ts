import type { RoomInviteRecord } from "./index.js";

export function isInviteLinkUsable(invite: RoomInviteRecord, roomId: string, nowMs: number): boolean {
  const expiresAtMs = Date.parse(invite.expiresAt);
  return invite.roomId === roomId && !invite.revokedAt && Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

/** Re-check stored expiry even while list reads fail, keeping the current invite metadata. */
export function withoutUnusableInviteLinks(invites: RoomInviteRecord[], roomId: string, nowMs = Date.now()): RoomInviteRecord[] {
  return invites.map(invite => {
    if (!invite.inviteLink || isInviteLinkUsable(invite, roomId, nowMs)) return invite;
    const metadata = { ...invite }; delete metadata.inviteLink;
    return metadata;
  });
}

/** A delayed create acknowledgement cannot undo a revoke already observed in this page. */
export function mergeConfirmedInviteCreate(previous: RoomInviteRecord[], created: RoomInviteRecord): RoomInviteRecord[] {
  const known = previous.find(invite => invite.roomId === created.roomId && invite.inviteId === created.inviteId);
  const effective = known?.revokedAt ? { ...known } : { ...created };
  if (effective.revokedAt) delete effective.inviteLink;
  return [effective, ...previous.filter(invite => invite.inviteId !== created.inviteId)];
}

/** Reconcile sanitized metadata without reissuing or persisting an invitation secret. */
export function mergeKnownInviteLinks(previous: RoomInviteRecord[], fetched: RoomInviteRecord[], roomId: string, nowMs = Date.now()): RoomInviteRecord[] {
  const knownLinks = new Map<string, string>();
  for (const invite of previous) {
    if (invite.inviteLink && invite.roomId === roomId && !invite.revokedAt) knownLinks.set(invite.inviteId, invite.inviteLink);
  }
  return fetched.map(({ inviteLink, ...fresh }) => {
    if (!isInviteLinkUsable(fresh, roomId, nowMs)) return fresh;
    const link = inviteLink || knownLinks.get(fresh.inviteId);
    return link ? { ...fresh, inviteLink: link } : fresh;
  });
}
