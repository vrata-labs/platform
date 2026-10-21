import type { MeetingToolTransitionState } from "./meeting-tool-transition.js";

const messages: Record<string, string> = {
  "session-unavailable": "Room access is unavailable. Rejoin before changing content.",
  "connection-unavailable": "Reconnect to the room before changing content.",
  "permission-required": "Ask the Host for presenting rights.",
  "capture-unsupported": "Screen capture is unsupported here. You can still view presentations.",
  "tool-disabled": "This tool is disabled for the room.",
  "document-changed": "The selected document changed. Select it again before presenting.",
  "surface-unavailable": "A compatible room surface is still loading or unavailable.",
  "surface-locked": "The target surface is locked by another participant.",
  "unsupported-content": "Stop the current tool explicitly before replacing it.",
  "replacement-unsupported": "Safe replacement needs a newer room server. Use the existing Stop action, then start the new tool.",
  "replacement-unavailable-xr": "Leave VR before confirming a content replacement.",
  "already-sharing": "Your screen is already being shared on this surface.",
  "context-changed": "Room access or connection changed. The pending action was cancelled.",
  "surface-changed": "The surface content changed. Review it and try the action again.",
  "capture-ended": "Screen capture ended before publication.",
  "capture-cancelled": "Screen capture was cancelled or not permitted. Existing content was kept.",
  "stop-unconfirmed": "Stopping the previous content could not be confirmed. Check the room before trying again.",
  "start-unconfirmed": "The new content could not be confirmed. Check the room before trying again.",
  "operation-unconfirmed": "The action could not be completed or confirmed. The previous content was not automatically retried.",
  cancelled: "Content replacement cancelled."
};
const contentNames: Record<string, string> = { "pdf-presentation": "PDF presentation", "screen-share": "screen share",
  "image-viewer": "image", "video-player": "video", "whiteboard": "whiteboard", "markdown-board": "sticky board" };
const safeLabel = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").trim().slice(0, 80) || "Room surface";
export const meetingToolMessage = (code: string): string => messages[code] ?? messages["operation-unconfirmed"];

export function createMeetingToolUi(input: { document: Document; confirm(): Promise<void>; cancel(): void }) {
  const document = input.document;
  const dialog = document.querySelector<HTMLDialogElement>("#meeting-replace-dialog")!;
  const explanation = document.getElementById("meeting-replace-explanation")!;
  const confirm = document.querySelector<HTMLButtonElement>("#meeting-replace-confirm")!;
  const cancel = document.querySelector<HTMLButtonElement>("#meeting-replace-cancel")!;
  const status = document.getElementById("meeting-transition-status")!;
  let restoreFocus: HTMLElement | null = null;
  let confirming = false;
  const restore = (navigation = false) => {
    const available = !navigation && restoreFocus?.isConnected && !restoreFocus.closest("[hidden]") && !(restoreFocus as HTMLButtonElement).disabled;
    (available ? restoreFocus : document.getElementById("meeting-nav-present"))?.focus({ preventScroll: true }); restoreFocus = null;
  };
  confirm.addEventListener("click", () => { void input.confirm(); });
  cancel.addEventListener("click", input.cancel);
  dialog.addEventListener("cancel", event => { event.preventDefault(); input.cancel(); });
  dialog.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    if (!event.shiftKey && document.activeElement === confirm) { event.preventDefault(); cancel.focus(); }
    else if (event.shiftKey && document.activeElement === cancel) { event.preventDefault(); confirm.focus(); }
  });
  dialog.addEventListener("close", () => {
    if (confirming && !dialog.open) { input.cancel(); restore(); }
  });
  return {
    render(state: MeetingToolTransitionState) {
      confirming = state.phase === "confirm";
      if (state.phase === "confirm" && state.plan) {
        const old = contentNames[state.plan.previous?.type ?? ""] ?? "current content";
        const next = state.plan.intent.kind === "board" ? "whiteboard" : state.plan.intent.kind === "screen" ? "screen share" : "selected document";
        explanation.textContent = `Stop the ${old} on “${safeLabel(state.plan.label)}” and start the ${next}?`
          + (state.plan.previous?.type === "markdown-board" || state.plan.previous?.type === "whiteboard" ? " Its current notes or strokes will be removed from the live surface." : "");
        confirm.textContent = state.plan.intent.kind === "screen" ? "Choose screen, then replace" : "Stop and replace";
        if (!dialog.open) { restoreFocus = document.activeElement as HTMLElement | null; dialog.showModal(); cancel.focus(); }
      } else if (dialog.open) { dialog.close(); restore(state.phase !== "idle"); }
      status.textContent = state.message ? meetingToolMessage(state.message)
        : state.phase === "confirm" ? "Review the existing content before replacing it."
          : state.phase === "capturing" ? "Choose a screen, window or tab. Cancelling keeps the existing content."
            : state.phase === "preparing" ? "Connecting media before replacing the current content…"
            : state.phase === "stopping" ? "Stopping the confirmed content…"
              : state.phase === "starting" ? "Starting the selected tool…" : "";
      status.setAttribute("aria-busy", ["capturing", "preparing", "stopping", "starting"].includes(state.phase) ? "true" : "false");
    }
  };
}
