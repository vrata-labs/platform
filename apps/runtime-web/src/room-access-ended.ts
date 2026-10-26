import { t, type MessageKey } from "./i18n/i18n.js";

// Final access outcomes get a screen of their own instead of a status line under a frozen room.
const ENDED: Record<string, { title: MessageKey; message: MessageKey }> = {
  room_closed: { title: "ended.roomClosedTitle", message: "ended.roomClosedMessage" },
  access_expired: { title: "ended.accessExpiredTitle", message: "ended.accessExpiredMessage" },
  grant_invalid: { title: "ended.grantInvalidTitle", message: "ended.grantInvalidMessage" },
  grant_revoked: { title: "ended.grantRevokedTitle", message: "ended.grantRevokedMessage" },
  grant_required: { title: "ended.grantRequiredTitle", message: "ended.grantRequiredMessage" },
  capacity_full: { title: "ended.capacityFullTitle", message: "ended.capacityFullMessage" }
};

export function describeRoomAccessEnded(reason: string): { title: string; message: string } | null {
  const ended = ENDED[reason];
  return ended ? { title: t(ended.title), message: t(ended.message) } : null;
}

/** Shows the ended screen for a final reason; returns false and leaves the page as it is for any other. */
export function showRoomAccessEnded(root: HTMLElement, reason: string): boolean {
  const ended = describeRoomAccessEnded(reason);
  if (!ended) return false;
  const title = root.querySelector<HTMLElement>("[data-room-access-ended-title]");
  const message = root.querySelector<HTMLElement>("[data-room-access-ended-message]");
  if (title) title.textContent = ended.title;
  if (message) message.textContent = ended.message;
  root.dataset.reason = reason;
  root.hidden = false;
  return true;
}
