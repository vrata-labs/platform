import { hasRoomPermission, type MediaObjectInstance, type MediaSurface, type RoomPermission, type RoomTemplateSurface } from "@vrata/shared-types";
import { resolveMeetingSurfaceTarget } from "./meeting-surface-target.js";

export type MeetingToolIntent = { kind: "board" } | { kind: "screen" }
  | { kind: "document"; documentId: string; checksum: string; objectType: "pdf-presentation" | "image-viewer" | "video-player" };
export interface MeetingToolContext {
  leaseKey: string;
  blocked: boolean;
  connected: boolean;
  participantId: string;
  permissions: readonly RoomPermission[];
  screenSupported: boolean;
  screenEnabled: boolean;
  documentsEnabled: boolean;
  stopRevisionSupported: boolean;
  xrActive: boolean;
  selectedSurfaceId: string;
  selectedDocumentId: string | null;
  selectedDocumentChecksum: string | null;
  documents: readonly { documentId: string; checksum: string }[];
  physicalSurfaceIds: ReadonlySet<string>;
  surfaces: Readonly<Record<string, MediaSurface>> | null;
  objects: Readonly<Record<string, MediaObjectInstance>>;
  templateSurfaces: readonly RoomTemplateSurface[];
  preferredPresentationSurfaceId?: string;
}
export type MeetingToolBlock = "session-unavailable" | "connection-unavailable" | "permission-required" | "capture-unsupported"
  | "tool-disabled" | "document-changed" | "surface-unavailable" | "surface-locked" | "unsupported-content" | "replacement-unsupported" | "already-sharing" | "replacement-unavailable-xr";
export interface MeetingToolPlan {
  intent: MeetingToolIntent;
  leaseKey: string;
  surfaceId: string;
  requestedSelection: string;
  label: string;
  previous: { objectId: string; revision: number; type: string; ownerParticipantId: string } | null;
  replace: boolean;
}
export type MeetingToolDecision = { kind: "blocked"; reason: MeetingToolBlock } | { kind: "ready" | "confirm"; plan: MeetingToolPlan };
const replaceable = new Set(["pdf-presentation", "image-viewer", "video-player", "screen-share", "whiteboard", "markdown-board"]);

function authorize(context: MeetingToolContext, intent: MeetingToolIntent): MeetingToolBlock | null {
  if (context.blocked) return "session-unavailable";
  if (!context.connected) return "connection-unavailable";
  const needed: RoomPermission[] = intent.kind === "board" ? ["surface.create-object", "whiteboard.draw"]
    : intent.kind === "screen" ? ["screen-share.start", "surface.create-object"] : ["document.present", "surface.create-object"];
  if (needed.some(permission => !hasRoomPermission(context.permissions, permission))) return "permission-required";
  if (intent.kind === "screen" && !context.screenSupported) return "capture-unsupported";
  if (intent.kind === "screen" && !context.screenEnabled || intent.kind === "document" && !context.documentsEnabled) return "tool-disabled";
  if (intent.kind === "document" && !context.documents.some(document => document.documentId === intent.documentId && document.checksum === intent.checksum)) return "document-changed";
  return null;
}

export function planMeetingTool(context: MeetingToolContext, intent: MeetingToolIntent): MeetingToolDecision {
  const denial = authorize(context, intent); if (denial) return { kind: "blocked", reason: denial };
  if (intent.kind === "document" && (context.selectedDocumentId !== intent.documentId || context.selectedDocumentChecksum !== intent.checksum)) return { kind: "blocked", reason: "document-changed" };
  const objectType = intent.kind === "board" ? "whiteboard" : intent.kind === "screen" ? "screen-share" : intent.objectType;
  const target = resolveMeetingSurfaceTarget({ purpose: intent.kind === "board" ? "collaboration" : "presentation", objectType,
    selectedSurfaceId: context.selectedSurfaceId, physicalSurfaceIds: context.physicalSurfaceIds, surfaces: context.surfaces,
    templateSurfaces: context.templateSurfaces, preferredPresentationSurfaceId: context.preferredPresentationSurfaceId });
  if (!target) return { kind: "blocked", reason: "surface-unavailable" };
  const surface = context.surfaces![target.surfaceId];
  if (surface.lockedByParticipantId && surface.lockedByParticipantId !== context.participantId) return { kind: "blocked", reason: "surface-locked" };
  const previous = surface.activeObjectId ? context.objects[surface.activeObjectId] : null;
  if (surface.activeObjectId && !previous) return { kind: "blocked", reason: "surface-unavailable" };
  if (previous && !replaceable.has(previous.type)) return { kind: "blocked", reason: "unsupported-content" };
  if (previous?.type === "screen-share" && intent.kind === "screen" && previous.ownerParticipantId === context.participantId) return { kind: "blocked", reason: "already-sharing" };
  const replace = Boolean(previous && previous.type !== objectType || previous && intent.kind === "screen");
  if (replace && !hasRoomPermission(context.permissions, "surface.stop-object")) return { kind: "blocked", reason: "permission-required" };
  if (replace && !context.stopRevisionSupported) return { kind: "blocked", reason: "replacement-unsupported" };
  if (replace && context.xrActive) return { kind: "blocked", reason: "replacement-unavailable-xr" };
  const plan: MeetingToolPlan = { intent: { ...intent }, leaseKey: context.leaseKey, surfaceId: target.surfaceId, requestedSelection: context.selectedSurfaceId,
    label: target.label, replace, previous: previous ? { objectId: previous.objectId, revision: previous.revision,
      type: previous.type, ownerParticipantId: previous.ownerParticipantId } : null };
  return { kind: replace ? "confirm" : "ready", plan };
}

export interface MeetingToolTransitionState {
  phase: "idle" | "confirm" | "capturing" | "preparing" | "stopping" | "starting";
  plan: MeetingToolPlan | null;
  message: string | null;
}
export class MeetingToolTransitionError extends Error {
  constructor(readonly code: "context-changed" | "surface-changed" | "capture-ended" | "stop-unconfirmed" | "start-unconfirmed") {
    super(code); this.name = "MeetingToolTransitionError";
  }
}

/** Owns only tool intent/confirmation/capture lifetime. Existing action owners
 * retain network publication, document compensation and scene rendering. */
export function createMeetingToolTransition(input: {
  current(): MeetingToolContext;
  capture(plan: MeetingToolPlan): Promise<MediaStream>;
  prepareScreen?(plan: MeetingToolPlan, stream: MediaStream): Promise<void>;
  stop(plan: MeetingToolPlan): Promise<{ accepted: boolean; blockedReason?: string | null }>;
  start(plan: MeetingToolPlan, stream: MediaStream | undefined, assertActive: () => void): Promise<boolean>;
  changed(state: MeetingToolTransitionState): void;
  failed?(error: unknown, plan: MeetingToolPlan): void;
}) {
  let generation = 0, running = false, captured: MediaStream | undefined;
  let leaseKey: string | undefined;
  let state: MeetingToolTransitionState = { phase: "idle", plan: null, message: null };
  const publish = (phase: MeetingToolTransitionState["phase"], plan: MeetingToolPlan | null, message: string | null = null) => {
    state = { phase, plan, message }; input.changed(state);
  };
  const dispose = (stream: MediaStream | undefined) => {
    for (const track of stream?.getTracks() ?? []) try { track.stop(); } catch { /* Finish stopping the rest of this owned capture. */ }
  };
  function invalidate(message = "context-changed"): void {
    generation++; dispose(captured); captured = undefined;
    if (!running && state.phase === "confirm") publish("idle", null, message);
  }
  function sync(): void {
    const next = input.current().leaseKey;
    const previous = leaseKey; leaseKey = next;
    if (previous !== undefined && next !== previous) invalidate();
  }
  function check(plan: MeetingToolPlan, ticket: number): void {
    sync();
    const current = input.current();
    if (ticket !== generation || plan.leaseKey !== current.leaseKey || authorize(current, plan.intent)) throw new MeetingToolTransitionError("context-changed");
    if (plan.replace && (!current.stopRevisionSupported || current.xrActive)) throw new MeetingToolTransitionError("context-changed");
    const surface = current.surfaces?.[plan.surfaceId];
    const type = plan.intent.kind === "board" ? "whiteboard" : plan.intent.kind === "screen" ? "screen-share" : plan.intent.objectType;
    if (!surface || !current.physicalSurfaceIds.has(plan.surfaceId) || surface.visible === false || !surface.allowedObjectTypes.includes(type)
      || surface.lockedByParticipantId && surface.lockedByParticipantId !== current.participantId) throw new MeetingToolTransitionError("surface-changed");
    if (captured && !captured.getVideoTracks().some(track => track.readyState === "live")) throw new MeetingToolTransitionError("capture-ended");
  }
  function checkPrevious(plan: MeetingToolPlan): void {
    const current = input.current(), id = current.surfaces?.[plan.surfaceId]?.activeObjectId ?? null;
    const previous = id ? current.objects[id] : null;
    if (id !== (plan.previous?.objectId ?? null) || previous && (previous.revision !== plan.previous?.revision
      || previous.type !== plan.previous?.type || previous.ownerParticipantId !== plan.previous?.ownerParticipantId)) throw new MeetingToolTransitionError("surface-changed");
  }
  async function execute(plan: MeetingToolPlan): Promise<void> {
    if (running) return;
    running = true; const ticket = generation;
    let owned: MediaStream | undefined, transferred = false;
    try {
      check(plan, ticket); checkPrevious(plan);
      if (plan.intent.kind === "screen") {
        publish("capturing", plan);
        // No network await may precede this call from the user's click.
        owned = await input.capture(plan); captured = owned;
        check(plan, ticket); checkPrevious(plan);
        if (input.prepareScreen) {
          publish("preparing", plan); check(plan, ticket);
          await input.prepareScreen(plan, owned);
          check(plan, ticket); checkPrevious(plan);
        }
      }
      if (plan.replace) {
        publish("stopping", plan); check(plan, ticket); checkPrevious(plan);
        const stopped = await input.stop(plan);
        check(plan, ticket);
        if (!stopped.accepted) throw new MeetingToolTransitionError(["revision-mismatch", "missing-object", "object-surface-mismatch"].includes(stopped.blockedReason ?? "") ? "surface-changed" : "stop-unconfirmed");
        if (input.current().surfaces?.[plan.surfaceId]?.activeObjectId) throw new MeetingToolTransitionError("surface-changed");
      }
      publish("starting", plan); check(plan, ticket);
      if (!plan.replace) checkPrevious(plan);
      const started = await input.start(plan, owned, () => check(plan, ticket));
      if (!started) { check(plan, ticket); throw new MeetingToolTransitionError("start-unconfirmed"); }
      // A successful owner has committed the operation and owns its lifecycle.
      // Later room changes must not turn that commit into a capture rollback.
      transferred = true;
      if (captured === owned) captured = undefined;
      publish("idle", null);
    } catch (error) {
      input.failed?.(error, plan);
      const name = error && typeof error === "object" && "name" in error ? error.name : null;
      publish("idle", null, error instanceof MeetingToolTransitionError ? error.code
        : state.phase === "capturing" && (name === "NotAllowedError" || name === "AbortError") ? "capture-cancelled" : "operation-unconfirmed");
    } finally {
      if (!transferred) dispose(owned);
      if (captured === owned) captured = undefined;
      running = false;
      input.changed(state);
    }
  }
  function request(intent: MeetingToolIntent): Promise<void> {
    sync(); if (running || state.phase === "confirm") return Promise.resolve();
    const decision = planMeetingTool(input.current(), intent);
    if (decision.kind === "blocked") { publish("idle", null, decision.reason); return Promise.resolve(); }
    if (decision.kind === "confirm") { publish("confirm", decision.plan); return Promise.resolve(); }
    return execute(decision.plan);
  }
  function confirm(): Promise<void> {
    const plan = state.phase === "confirm" ? state.plan : null;
    if (!plan) return Promise.resolve();
    return execute(plan);
  }
  return { request, confirm, sync, invalidate, cancel: () => invalidate("cancelled"),
    busy: () => running, snapshot: () => state };
}
