import type { IncomingMessage, ServerResponse } from "node:http";
import { getRoomPermissions, hasRoomPermission, type RoomPermission } from "@vrata/shared-types";
import type { ControlPlaneActor } from "./control-plane-actor.js";
import type { createApiMetrics } from "./api-metrics.js";
import { incrementCounter } from "./api-metrics.js";
import { json } from "./http-responses.js";
import { isRoomDisabled } from "./room-session-control.js";
import type { RoomNoteRecord, RoomNoteScope, RoomRecord, Storage } from "./storage.js";
import type { RoomIdentityEffectStorage } from "./storage-contracts.js";
import { releaseFencedResponse } from "./identity/response-release.js";
import { createFencedAudit, type FencedAudit, type FencedAuditResult } from "./fenced-audit.js";

export interface RoomNotesAccessContext {
  metrics: Pick<ReturnType<typeof createApiMetrics>["metrics"],
    "notesCreatedTotal" | "notesSavedTotal" | "notesSaveFailuresTotal" | "notesPermissionDeniedTotal" |
    "notesVersionsCreatedTotal" | "notesRestoresTotal" | "notesExportsTotal" | "notesExportDeniedTotal"
  >;
  resolveControlPlaneActor(request: IncomingMessage):
    | { ok: true; actor: ControlPlaneActor }
    | { ok: false; statusCode: 401; reason: string };
  getRequestId(request: IncomingMessage): string;
  logEvent(event: Record<string, unknown>): void;
  runGuardedRoomEffect<T>(storage: Storage, actor: ControlPlaneActor, room: RoomRecord, permission: RoomPermission,
    effect: (scoped: RoomIdentityEffectStorage) => Promise<T>): Promise<T>;
  deniedEffectReason(error: unknown): string | null;
}

export function createRoomNotesAccess(context: RoomNotesAccessContext) {
  const { metrics, resolveControlPlaneActor, getRequestId, logEvent } = context;
  /** The one audit record of each authorized v2 request, settled by its fenced outcome or its response. */
  const audits = new WeakMap<IncomingMessage, FencedAudit>();

  function roomNoteId(roomId: string, scope: RoomNoteScope, ownerParticipantId?: string | null): string {
    return scope === "shared" ? `${roomId}:shared` : `${roomId}:private:${ownerParticipantId ?? ""}`;
  }

  function emptyRoomNote(roomId: string, scope: RoomNoteScope, ownerParticipantId?: string | null): RoomNoteRecord {
    return {
      noteId: roomNoteId(roomId, scope, ownerParticipantId),
      roomId,
      scope,
      ownerParticipantId: scope === "private" ? ownerParticipantId ?? null : null,
      content: "",
      updatedAt: null,
      updatedBy: null,
      deletedAt: null,
      deletedBy: null
    };
  }

  function writeRoomNotesAudit(input: {
    request: IncomingMessage;
    action: "notes.read" | "notes.save" | "notes.versions" | "notes.restore" | "notes.delete" | "notes.export";
    roomId: string;
    scope: RoomNoteScope;
    result: FencedAuditResult;
    reason?: string;
    actor?: ControlPlaneActor;
  }): void {
    logEvent({
      service: "api",
      event: "room_notes_audit",
      timestamp: new Date().toISOString(),
      requestId: getRequestId(input.request),
      action: input.action,
      roomId: input.roomId,
      scope: input.scope,
      result: input.result,
      reason: input.reason,
      actor: input.actor ? {
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        role: input.actor.role,
        tenantId: input.actor.tenantId,
        roomId: input.actor.roomId,
        participantId: input.actor.participantId,
        sessionId: input.actor.sessionId
      } : undefined
    });
  }

  function noteActorPermissions(actor: ControlPlaneActor): RoomPermission[] {
    return actor.permissions ?? getRoomPermissions(actor.role);
  }

  function noteWritePermission(scope: RoomNoteScope): "notes.view" | "notes.edit" {
    return scope === "private" ? "notes.view" : "notes.edit";
  }

  function resolveRoomNoteOwner(scope: RoomNoteScope, actor: ControlPlaneActor, url: URL): string | null {
    if (scope === "shared") return null;
    if (actor.actorType === "room-session") return actor.participantId ?? null;
    return url.searchParams.get("participantId")?.trim() || null;
  }

  function resolveRoomNotesActor(
    request: IncomingMessage,
    response: ServerResponse,
    input: { room: RoomRecord; scope: RoomNoteScope; permission: "notes.view" | "notes.edit"; action: Parameters<typeof writeRoomNotesAudit>[0]["action"] }
  ): ControlPlaneActor | null {
    const actorResult = resolveControlPlaneActor(request);
    if (!actorResult.ok) {
      metrics.notesPermissionDeniedTotal += 1;
      writeRoomNotesAudit({ request, action: input.action, roomId: input.room.roomId, scope: input.scope, result: "denied", reason: actorResult.reason });
      json(response, actorResult.statusCode, { error: "unauthorized", reason: actorResult.reason, requestId: getRequestId(request) });
      return null;
    }

    const actor = actorResult.actor;
    const deny = (reason: string): null => {
      metrics.notesPermissionDeniedTotal += 1;
      writeRoomNotesAudit({ request, action: input.action, roomId: input.room.roomId, scope: input.scope, result: "denied", reason, actor });
      json(response, reason === "room_mismatch" ? 403 : 403, { error: "forbidden", reason, permission: input.permission, requestId: getRequestId(request) });
      return null;
    };

    if (actor.actorType === "room-session" && actor.roomId !== input.room.roomId) {
      return deny("room_mismatch");
    }
    if (isRoomDisabled(input.room) && actor.actorType !== "admin-token") {
      return deny("room_disabled");
    }
    if (!hasRoomPermission(noteActorPermissions(actor), input.permission)) {
      return deny("permission_denied");
    }

    // A v2 request is audited once by its fenced outcome (releaseRoomNotes, auditedRoomNoteWrite) or, when it ends
    // earlier, by its response; entry-time authorization is not an outcome.
    if (actor.identityProtocolVersion === 2) {
      audits.set(request, createFencedAudit((result, reason) => writeRoomNotesAudit({ request, action: input.action,
        roomId: input.room.roomId, scope: input.scope, result, reason, actor }), context.deniedEffectReason));
    } else {
      writeRoomNotesAudit({ request, action: input.action, roomId: input.room.roomId, scope: input.scope, result: "allowed", actor });
    }
    return actor;
  }

  /** A v2 note write is allowed once its fenced effect committed, denied when the fence refused it and uncertain
   * when the COMMIT outcome is unknown. */
  async function auditedRoomNoteWrite<T>(request: IncomingMessage, run: () => Promise<T>): Promise<T> {
    const audit = audits.get(request);
    return audit ? audit.effect(run) : run();
  }

  /** Once a notes handler has finished: a v2 request without a fenced outcome is recorded by its response. */
  function settleRoomNotesAudit(request: IncomingMessage, response: ServerResponse): void {
    audits.get(request)?.settle(response);
  }

  function resolveAuthorizedRoomNoteOwner(request: IncomingMessage, response: ServerResponse, input: { roomId: string; scope: RoomNoteScope; actor: ControlPlaneActor; url: URL; permission: "notes.view" | "notes.edit"; action: Parameters<typeof writeRoomNotesAudit>[0]["action"] }): string | null | undefined {
    const requestedOwnerParticipantId = input.scope === "private" ? input.url.searchParams.get("participantId")?.trim() || null : null;
    if (input.scope === "private" && input.actor.actorType === "room-session" && requestedOwnerParticipantId && requestedOwnerParticipantId !== input.actor.participantId) {
      metrics.notesPermissionDeniedTotal += 1;
      if (input.action === "notes.export") metrics.notesExportDeniedTotal += 1;
      const audit = audits.get(request);
      if (audit) audit.denied("note_owner_mismatch");
      else writeRoomNotesAudit({ request, action: input.action, roomId: input.roomId, scope: input.scope, result: "denied", reason: "note_owner_mismatch", actor: input.actor });
      json(response, 403, { error: "forbidden", reason: "note_owner_mismatch", permission: input.permission, requestId: getRequestId(request) });
      return undefined;
    }
    const ownerParticipantId = resolveRoomNoteOwner(input.scope, input.actor, input.url);
    if (input.scope === "private" && !ownerParticipantId) {
      incrementCounter(metrics.notesSaveFailuresTotal, "missing_private_note_owner");
      json(response, 400, { error: "missing_private_note_owner" });
      return undefined;
    }
    return ownerParticipantId;
  }

  function roomNoteVisibleToActor(note: RoomNoteRecord, actor: ControlPlaneActor): boolean {
    if (note.scope === "shared") return true;
    if (actor.actorType === "admin-token") return true;
    return note.ownerParticipantId === actor.participantId;
  }

  async function releaseRoomNotes(request: IncomingMessage, storage: Storage, actor: ControlPlaneActor, room: RoomRecord,
    send: () => void): Promise<void> {
    const audit = audits.get(request);
    await releaseFencedResponse({ send,
      run: release => context.runGuardedRoomEffect(storage, actor, room, "notes.view", async scoped => { scoped.releaseResponse(release); }),
      onReleased: () => { audit?.released(); },
      onDenied: error => { audit?.refused(error); }
    });
  }

  return {
    emptyRoomNote, writeRoomNotesAudit, noteWritePermission, resolveRoomNotesActor,
    resolveAuthorizedRoomNoteOwner, roomNoteVisibleToActor, releaseRoomNotes, auditedRoomNoteWrite, settleRoomNotesAudit
  };
}
