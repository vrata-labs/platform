import type { IncomingMessage, ServerResponse } from "node:http";
import { getRoomPermissions, hasRoomPermission, type RoomPermission } from "@vrata/shared-types";
import type { ControlPlaneActor } from "./control-plane-actor.js";
import type { createApiMetrics } from "./api-metrics.js";
import { incrementCounter } from "./api-metrics.js";
import { json } from "./http-responses.js";
import { isRoomDisabled } from "./room-session-control.js";
import type { RoomNoteRecord, RoomNoteScope, RoomRecord } from "./storage.js";

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
}

export function createRoomNotesAccess(context: RoomNotesAccessContext) {
  const { metrics, resolveControlPlaneActor, getRequestId, logEvent } = context;

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
    result: "allowed" | "denied";
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

    writeRoomNotesAudit({ request, action: input.action, roomId: input.room.roomId, scope: input.scope, result: "allowed", actor });
    return actor;
  }

  function resolveAuthorizedRoomNoteOwner(request: IncomingMessage, response: ServerResponse, input: { roomId: string; scope: RoomNoteScope; actor: ControlPlaneActor; url: URL; permission: "notes.view" | "notes.edit"; action: Parameters<typeof writeRoomNotesAudit>[0]["action"] }): string | null | undefined {
    const requestedOwnerParticipantId = input.scope === "private" ? input.url.searchParams.get("participantId")?.trim() || null : null;
    if (input.scope === "private" && input.actor.actorType === "room-session" && requestedOwnerParticipantId && requestedOwnerParticipantId !== input.actor.participantId) {
      metrics.notesPermissionDeniedTotal += 1;
      if (input.action === "notes.export") metrics.notesExportDeniedTotal += 1;
      writeRoomNotesAudit({ request, action: input.action, roomId: input.roomId, scope: input.scope, result: "denied", reason: "note_owner_mismatch", actor: input.actor });
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

  return {
    emptyRoomNote, writeRoomNotesAudit, noteWritePermission, resolveRoomNotesActor,
    resolveAuthorizedRoomNoteOwner, roomNoteVisibleToActor
  };
}
