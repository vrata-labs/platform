// Final access outcomes get a screen of their own instead of a status line under a frozen room.
const ENDED: Record<string, { title: string; message: string }> = {
  room_closed: { title: "This room has ended", message: "The meeting is over and the room is closed." },
  access_expired: { title: "This room has ended", message: "The access period of this room is over." },
  grant_invalid: { title: "This invitation is not valid", message: "The link was already used or belongs to another room. Ask for a new invitation." },
  grant_revoked: { title: "This invitation was withdrawn", message: "Ask the person who invited you for a new link." },
  grant_required: { title: "An invitation is required", message: "Open this room from your invitation link." },
  capacity_full: { title: "This room is full", message: "All places are taken. Try again later." }
};

export function describeRoomAccessEnded(reason: string): { title: string; message: string } | null {
  return ENDED[reason] ?? null;
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
