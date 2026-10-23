import { IMAGE_VIEWER_OBJECT_TYPE, PDF_PRESENTATION_OBJECT_TYPE, SCREEN_SHARE_OBJECT_TYPE, VIDEO_PLAYER_OBJECT_TYPE, WHITEBOARD_OBJECT_TYPE, type RoomTemplateSurface } from "@vrata/shared-types";
import { MEETING_ACTIONS, meetingActionReason, type MeetingAction, type MeetingAvailabilityContext } from "./meeting-availability.js";
import { buildMeetingPeople, meetingRoleLabel, type MeetingPersonInput, type MeetingPeopleAuthority } from "./meeting-people.js";
import { resolveMeetingSurfaceTarget } from "./meeting-surface-target.js";

const sections = ["audio", "present", "board", "notes", "people"] as const;
type Section = typeof sections[number];
const actionSection = (action: MeetingAction): Section => action === "notes-editor" ? "notes"
  : ["join-audio", "toggle-mute", "speaker-select"].includes(action) ? "audio"
    : ["start-whiteboard", "draw-whiteboard", "clear-whiteboard", "stop-whiteboard", "start-markdown-board"].includes(action) ? "board"
      : ["grant-presenter", "revoke-presenter", "remove-participant", "transfer-host"].includes(action) ? "people" : "present";

function requireElement<T extends HTMLElement>(document: Document, id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing_meeting_ui_element:${id}`);
  return element as T;
}
const text = (element: HTMLElement, value: string) => { if (element.textContent !== value) element.textContent = value; };
const label = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) || "Room surface";

/** Owns navigation and explanations only. Existing action producers retain their
 * disabled/hidden/title attributes and all authoritative network/media behavior. */
export function createMeetingNavigationRuntime(input: {
  document: Document;
  context: () => MeetingAvailabilityContext;
  selectSurface: (surfaceId: string) => boolean;
  authority?: () => MeetingPeopleAuthority;
}) {
  const document = input.document;
  const view = document.defaultView;
  const canvas = document.querySelector<HTMLCanvasElement>("#scene canvas");
  if (canvas && !canvas.hasAttribute("tabindex")) canvas.tabIndex = 0;
  if (canvas && !canvas.hasAttribute("aria-label")) canvas.setAttribute("aria-label", "Room scene. Focus here to use WASD or arrow movement controls.");
  const panels = new Map(sections.map(section => [section, requireElement<HTMLDetailsElement>(document, `meeting-${section}`)]));
  const statuses = new Map(sections.map(section => [section, requireElement(document, `meeting-${section}-status`)]));
  const descriptions = requireElement(document, "meeting-action-descriptions");
  const producers = new Map(MEETING_ACTIONS.map(id => [id, requireElement<HTMLElement & { disabled?: boolean }>(document, id)]));
  const reasonElements = new Map<MeetingAction, HTMLElement>();
  const listeners: Array<() => void> = [];
  let disposed = false, scheduled = false;
  let templateSurfaces: readonly RoomTemplateSurface[] = [];
  let preferredPresentationSurfaceId: string | undefined;
  let people: readonly MeetingPersonInput[] = [], lastPeople = "";

  for (const [id, element] of producers) {
    const reason = document.createElement("span"); reason.id = `meeting-why-${id}`; reason.className = "visually-hidden";
    descriptions.appendChild(reason); reasonElements.set(id, reason);
    const ids = new Set((element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
    ids.add(reason.id); element.setAttribute("aria-describedby", [...ids].join(" "));
  }

  const targets = {
    present: { button: requireElement<HTMLButtonElement>(document, "meeting-use-presentation-surface"), status: requireElement(document, "meeting-presentation-target") },
    board: { button: requireElement<HTMLButtonElement>(document, "meeting-use-board-surface"), status: requireElement(document, "meeting-board-target") }
  };

  function target(section: "present" | "board", context: MeetingAvailabilityContext) {
    return resolveMeetingSurfaceTarget({ purpose: section === "board" ? "collaboration" : "presentation",
      objectType: section === "board" ? WHITEBOARD_OBJECT_TYPE : PDF_PRESENTATION_OBJECT_TYPE,
      alternativeObjectTypes: section === "board" ? [] : [SCREEN_SHARE_OBJECT_TYPE, IMAGE_VIEWER_OBJECT_TYPE, VIDEO_PLAYER_OBJECT_TYPE],
      selectedSurfaceId: context.selectedSurfaceId, surfaces: context.surfaces, physicalSurfaceIds: context.physicalSurfaceIds,
      templateSurfaces, preferredPresentationSurfaceId });
  }

  function sync(): void {
    scheduled = false;
    if (disposed) return;
    const context = input.context(), reasons = new Map<Section, Set<string>>(sections.map(section => [section, new Set<string>()]));
    for (const [id, element] of producers) {
      const reason = meetingActionReason(id, { disabled: element.disabled === true, hidden: element.hidden || Boolean(element.closest("[hidden]")) }, context);
      text(reasonElements.get(id)!, reason ?? "");
      if (reason) reasons.get(actionSection(id))!.add(reason);
    }
    for (const section of sections) text(statuses.get(section)!, [...reasons.get(section)!].join(" "));
    for (const section of ["present", "board"] as const) {
      const resolved = target(section, context), control = targets[section];
      const current = context.surfaces?.[context.selectedSurfaceId];
      text(control.status, context.blocked ? "This session is unavailable. Update or rejoin the room."
        : !context.admitted ? "Join the room to choose a surface."
          : !context.connected ? "Room connection unavailable. Reconnect to choose a surface."
            : resolved ? `Selected surface: ${label(current?.label ?? "Room surface")}.` : "No compatible room surface is available for this tool.");
      control.button.hidden = !resolved || resolved.surfaceId === context.selectedSurfaceId;
      control.button.disabled = context.blocked || !context.admitted || !context.connected;
      if (resolved) text(control.button, `Use ${label(resolved.label)} for ${section === "board" ? "board" : "presenting"}`);
    }
    const normalized = buildMeetingPeople(context.blocked ? [] : people, context.localParticipantId, 64, input.authority?.());
    const signature = JSON.stringify({ ...normalized, blocked: context.blocked });
    if (signature !== lastPeople) {
      lastPeople = signature;
      const list = requireElement<HTMLUListElement>(document, "meeting-people-list");
      const items = normalized.people.map(person => {
        const item = document.createElement("li"), name = document.createElement("bdi");
        if (person.role !== undefined) {
          const role = document.createElement("span"); role.className = "meeting-person-role"; role.textContent = `${meetingRoleLabel(person.role, person.owner)} — `;
          item.append(role);
        }
        name.textContent = person.name; item.append(name, document.createTextNode(`${person.self ? " (you)" : ""} — ${person.audio}`)); return item;
      });
      if (!items.length) { const item = document.createElement("li"); item.textContent = context.blocked ? "Room access is unavailable." : "Participants appear after joining the room."; items.push(item); }
      list.replaceChildren(...items);
      text(requireElement(document, "meeting-people-count"), normalized.truncated ? `Showing ${normalized.people.length} participants.` : `${normalized.people.length} participant${normalized.people.length === 1 ? "" : "s"}.`);
    }
  }

  function requestSync(): void {
    if (disposed || scheduled) return;
    scheduled = true; queueMicrotask(sync);
  }

  for (const section of sections) {
    const button = requireElement<HTMLButtonElement>(document, `meeting-nav-${section}`);
    const activate = () => {
      const panel = panels.get(section)!; panel.open = true;
      for (const other of sections) {
        const link = requireElement(document, `meeting-nav-${other}`);
        if (other === section) link.setAttribute("aria-current", "location"); else link.removeAttribute("aria-current");
      }
      const summary = panel.querySelector("summary");
      summary?.scrollIntoView({ block: "start" }); summary?.focus({ preventScroll: true });
      requestSync();
    };
    button.addEventListener("click", activate); listeners.push(() => button.removeEventListener("click", activate));
    const summary = panels.get(section)!.querySelector("summary")!;
    const backToTools = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); button.focus();
    };
    summary.addEventListener("keydown", backToTools); listeners.push(() => summary.removeEventListener("keydown", backToTools));
  }
  for (const section of ["present", "board"] as const) {
    const activate = () => {
      const context = input.context();
      if (context.blocked || !context.admitted || !context.connected) return;
      const resolved = target(section, context);
      if (resolved && input.selectSurface(resolved.surfaceId)) {
        if (document.activeElement === targets[section].button) panels.get(section)!.querySelector("summary")?.focus({ preventScroll: true });
        text(requireElement(document, "meeting-announcement"), `Selected ${label(resolved.label)} for ${section === "board" ? "board" : "presenting"}.`);
      }
      requestSync();
    };
    targets[section].button.addEventListener("click", activate);
    listeners.push(() => targets[section].button.removeEventListener("click", activate));
  }
  const onChange = () => requestSync();
  document.getElementById("host-participant-select")?.addEventListener("change", onChange);
  listeners.push(() => document.getElementById("host-participant-select")?.removeEventListener("change", onChange));
  // Only existing producers are observed. Our own hidden/aria/text updates cannot
  // recursively trigger the observer or create a frame-driven rendering loop.
  const observer = new MutationObserver(requestSync);
  for (const element of [...producers.values(), ...["notes-panel", "documents-panel", "host-controls"].map(id => requireElement(document, id))]) {
    observer.observe(element, { attributes: true, attributeFilter: ["hidden", "disabled"] });
  }
  const onPageHide = (event: PageTransitionEvent) => { if (!event.persisted) dispose(); };
  const onPageShow = () => requestSync();
  view?.addEventListener("pagehide", onPageHide); view?.addEventListener("pageshow", onPageShow);

  function dispose() {
    if (disposed) return;
    disposed = true; observer.disconnect(); for (const remove of listeners) remove();
    view?.removeEventListener("pagehide", onPageHide); view?.removeEventListener("pageshow", onPageShow);
    for (const [id, element] of producers) {
      const ids = (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(value => value && value !== reasonElements.get(id)!.id);
      if (ids.length) element.setAttribute("aria-describedby", ids.join(" ")); else element.removeAttribute("aria-describedby");
      reasonElements.get(id)?.remove();
    }
  }
  requestSync();
  return {
    requestSync,
    configureTemplate(surfaces: readonly RoomTemplateSurface[], preferred?: string) {
      templateSurfaces = surfaces.map(surface => ({ ...surface, allowedObjectTypes: [...surface.allowedObjectTypes] }));
      preferredPresentationSurfaceId = preferred; requestSync();
    },
    updatePeople(value: readonly MeetingPersonInput[]) {
      people = value.slice(0, 256).filter(Boolean).map(person => ({ participantId: person.participantId, displayName: person.displayName,
        audioJoined: person.audioJoined, muted: person.muted, role: person.role, activeMedia: { audio: person.activeMedia?.audio } }));
      requestSync();
    },
    dispose
  };
}
