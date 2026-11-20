import type { IncomingMessage, ServerResponse } from "node:http";
import type { RoomNoteScope, Storage } from "./storage.js";
import { isNotesFeatureEnabled } from "./feature-flags.js";
import { incrementCounter } from "./api-metrics.js";
import { parseBody } from "./request-body.js";
import { attachment, json } from "./http-responses.js";
import { createStoredZip } from "./stored-zip.js";
import { noteExportFilename, noteExportJson, formatNoteMarkdown, formatRoomNotesMarkdown } from "./notes-export.js";
import { createRoomNotesAccess, type RoomNotesAccessContext } from "./room-notes-access.js";

export function createRoomNotesRoutes(context: RoomNotesAccessContext) {
  const { metrics } = context;
  const {
    emptyRoomNote, writeRoomNotesAudit, noteWritePermission, resolveRoomNotesActor,
    resolveAuthorizedRoomNoteOwner, roomNoteVisibleToActor, releaseRoomNotes, auditedRoomNoteWrite, settleRoomNotesAudit
  } = createRoomNotesAccess(context);

  // An unmatched request falls through synchronously; only a matched route starts work. A matched v2 request's
  // audit is settled once its handler has finished.
  return function routeRoomNotesRequest(
    request: IncomingMessage, response: ServerResponse, method: string, url: URL, storage: Storage
  ): Promise<void> | null {
    return route(request, response, method, url, storage)?.finally(() => settleRoomNotesAudit(request, response)) ?? null;
  };

  function route(
    request: IncomingMessage, response: ServerResponse, method: string, url: URL, storage: Storage
  ): Promise<void> | null {
    const roomNotesArchiveExportMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/notes\/export$/);
    if (method === "GET" && roomNotesArchiveExportMatch) {
      return (async () => {
        if (!isNotesFeatureEnabled()) return json(response, 404, { error: "notes_disabled" });
        const roomId = decodeURIComponent(roomNotesArchiveExportMatch[1]);
        const room = await storage.getRoom(roomId);
        if (!room) return json(response, 404, { error: "room_not_found" });
        const actor = resolveRoomNotesActor(request, response, { room, scope: "shared", permission: "notes.view", action: "notes.export" });
        if (!actor) {
          metrics.notesExportDeniedTotal += 1;
          return;
        }
        const format = url.searchParams.get("format")?.trim().toLowerCase() || "json";
        if (format !== "json" && format !== "markdown" && format !== "zip") {
          incrementCounter(metrics.notesExportsTotal, `${format}:failed`);
          return json(response, 400, { error: "unsupported_notes_export_format" });
        }
        const notes = (await storage.listRoomNotes(roomId, true)).filter((note) => roomNoteVisibleToActor(note, actor));
        const items = await Promise.all(notes.map(async (note) => ({
          note,
          versions: await storage.listRoomNoteVersions(note.roomId, note.scope, note.ownerParticipantId, 100)
        })));
        const exportedAt = new Date().toISOString();
        const payload = { schemaVersion: 1, exportedAt, roomId, notes: items };
        const body = format === "markdown" ? formatRoomNotesMarkdown(roomId, items) : format === "zip" ? createStoredZip([
            { name: "room-notes.json", content: JSON.stringify(payload, null, 2) },
            { name: "room-notes.md", content: formatRoomNotesMarkdown(roomId, items) },
            { name: "board.json", content: JSON.stringify({ status: "not_included", reason: "board_state_is_realtime_only", followUp: "VRATA-FEAT-023-board-history" }, null, 2) },
            ...items.map(({ note, versions }) => ({
              name: `notes/${note.scope}${note.ownerParticipantId ? `-${note.ownerParticipantId}` : ""}.md`,
              content: formatNoteMarkdown(note, versions)
            }))
          ]) : JSON.stringify(payload, null, 2);
        await releaseRoomNotes(request, storage, actor, room, () => {
          attachment(response, 200, body, noteExportFilename(roomId, "room", format === "markdown" ? "md" : format),
            format === "markdown" ? "text/markdown; charset=utf-8" : format === "zip" ? "application/zip" : "application/json; charset=utf-8");
        });
        incrementCounter(metrics.notesExportsTotal, `${format}:saved`);
      })();
    }

    const roomNoteVersionsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/notes\/(shared|private)\/versions$/);
    if (method === "GET" && roomNoteVersionsMatch) {
      return (async () => {
        if (!isNotesFeatureEnabled()) return json(response, 404, { error: "notes_disabled" });
        const roomId = decodeURIComponent(roomNoteVersionsMatch[1]);
        const scope = roomNoteVersionsMatch[2] as RoomNoteScope;
        const room = await storage.getRoom(roomId);
        if (!room) return json(response, 404, { error: "room_not_found" });
        const actor = resolveRoomNotesActor(request, response, { room, scope, permission: "notes.view", action: "notes.versions" });
        if (!actor) return;
        const ownerParticipantId = resolveAuthorizedRoomNoteOwner(request, response, { roomId, scope, actor, url, permission: "notes.view", action: "notes.versions" });
        if (ownerParticipantId === undefined) return;
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
        const versions = await storage.listRoomNoteVersions(roomId, scope, ownerParticipantId, Number.isFinite(limit) ? limit : 20);
        await releaseRoomNotes(request, storage, actor, room, () => { json(response, 200, { items: versions }); });
        return;
      })();
    }

    const roomNoteRestoreMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/notes\/(shared|private)\/restore$/);
    if (method === "POST" && roomNoteRestoreMatch) {
      return (async () => {
        if (!isNotesFeatureEnabled()) return json(response, 404, { error: "notes_disabled" });
        const roomId = decodeURIComponent(roomNoteRestoreMatch[1]);
        const scope = roomNoteRestoreMatch[2] as RoomNoteScope;
        const room = await storage.getRoom(roomId);
        if (!room) return json(response, 404, { error: "room_not_found" });
        const permission = noteWritePermission(scope);
        const actor = resolveRoomNotesActor(request, response, { room, scope, permission, action: "notes.restore" });
        if (!actor) {
          incrementCounter(metrics.notesRestoresTotal, `${scope}:denied`);
          return;
        }
        const ownerParticipantId = resolveAuthorizedRoomNoteOwner(request, response, { roomId, scope, actor, url, permission, action: "notes.restore" });
        if (ownerParticipantId === undefined) {
          incrementCounter(metrics.notesRestoresTotal, `${scope}:denied`);
          return;
        }
        const payload = (await parseBody<{ versionId?: unknown }>(request)) ?? {};
        if (typeof payload.versionId !== "string" || !payload.versionId.trim()) {
          incrementCounter(metrics.notesRestoresTotal, `${scope}:failed`);
          return json(response, 400, { error: "invalid_note_version" });
        }
        const versionId = payload.versionId.trim();
        const restored = await auditedRoomNoteWrite(request, () => context.runGuardedRoomEffect(storage, actor, room, permission,
          scoped => scoped.restoreRoomNoteVersion(roomId, scope, ownerParticipantId, versionId, actor.actorId)));
        if (!restored) {
          incrementCounter(metrics.notesRestoresTotal, `${scope}:failed`);
          return json(response, 404, { error: "note_version_not_found" });
        }
        metrics.notesVersionsCreatedTotal += 1;
        incrementCounter(metrics.notesRestoresTotal, `${scope}:saved`);
        json(response, 200, restored);
        return;
      })();
    }

    const roomNoteExportMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/notes\/(shared|private)\/export$/);
    if (method === "GET" && roomNoteExportMatch) {
      return (async () => {
        if (!isNotesFeatureEnabled()) return json(response, 404, { error: "notes_disabled" });
        const roomId = decodeURIComponent(roomNoteExportMatch[1]);
        const scope = roomNoteExportMatch[2] as RoomNoteScope;
        const room = await storage.getRoom(roomId);
        if (!room) return json(response, 404, { error: "room_not_found" });
        const actor = resolveRoomNotesActor(request, response, { room, scope, permission: "notes.view", action: "notes.export" });
        if (!actor) {
          metrics.notesExportDeniedTotal += 1;
          return;
        }
        const ownerParticipantId = resolveAuthorizedRoomNoteOwner(request, response, { roomId, scope, actor, url, permission: "notes.view", action: "notes.export" });
        if (ownerParticipantId === undefined) return;
        const format = url.searchParams.get("format")?.trim().toLowerCase() || "markdown";
        if (format !== "markdown" && format !== "json") {
          incrementCounter(metrics.notesExportsTotal, `${format}:failed`);
          return json(response, 400, { error: "unsupported_notes_export_format" });
        }
        const note = await storage.getRoomNote(roomId, scope, ownerParticipantId) ?? emptyRoomNote(roomId, scope, ownerParticipantId);
        const versions = await storage.listRoomNoteVersions(roomId, scope, ownerParticipantId, 100);
        const body = format === "json" ? JSON.stringify(noteExportJson(note, versions), null, 2) : formatNoteMarkdown(note, versions);
        await releaseRoomNotes(request, storage, actor, room, () => {
          attachment(response, 200, body, noteExportFilename(roomId, scope, format === "json" ? "json" : "md"),
            format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8");
        });
        incrementCounter(metrics.notesExportsTotal, `${format}:saved`);
      })();
    }

    const roomNotesMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/notes\/(shared|private)$/);
    if ((method === "GET" || method === "PUT" || method === "DELETE") && roomNotesMatch) {
      return (async () => {
        if (!isNotesFeatureEnabled()) return json(response, 404, { error: "notes_disabled" });
        const roomId = decodeURIComponent(roomNotesMatch[1]);
        const scope = roomNotesMatch[2] as RoomNoteScope;
        const room = await storage.getRoom(roomId);
        if (!room) return json(response, 404, { error: "room_not_found" });
        const permission: "notes.view" | "notes.edit" = method === "GET" ? "notes.view" : noteWritePermission(scope);
        const action = method === "GET" ? "notes.read" : method === "DELETE" ? "notes.delete" : "notes.save";
        const actor = resolveRoomNotesActor(request, response, { room, scope, permission, action });
        if (!actor) return;
        const ownerParticipantId = resolveAuthorizedRoomNoteOwner(request, response, { roomId, scope, actor, url, permission, action });
        if (ownerParticipantId === undefined) return;

        if (method === "GET") {
          const note = await storage.getRoomNote(roomId, scope, ownerParticipantId);
          const result = note && !note.deletedAt ? note : emptyRoomNote(roomId, scope, ownerParticipantId);
          await releaseRoomNotes(request, storage, actor, room, () => { json(response, 200, { note: result }); });
          return;
        }

        if (method === "DELETE") {
          const deleted = await auditedRoomNoteWrite(request, () => context.runGuardedRoomEffect(storage, actor, room, permission,
            scoped => scoped.deleteRoomNote(roomId, scope, ownerParticipantId, actor.actorId)));
          if (!deleted) return json(response, 404, { error: "note_not_found" });
          metrics.notesVersionsCreatedTotal += 1;
          json(response, 200, { note: deleted });
          return;
        }

        const payload = (await parseBody<{ content?: unknown }>(request)) ?? {};
        if (typeof payload.content !== "string") {
          incrementCounter(metrics.notesSaveFailuresTotal, "invalid_note_content");
          incrementCounter(metrics.notesSavedTotal, `${scope}:failed`);
          return json(response, 400, { error: "invalid_note_content" });
        }
        if (payload.content.length > 20_000) {
          incrementCounter(metrics.notesSaveFailuresTotal, "note_too_large");
          incrementCounter(metrics.notesSavedTotal, `${scope}:failed`);
          return json(response, 413, { error: "note_too_large" });
        }

        const content = payload.content;
        const existing = await storage.getRoomNote(roomId, scope, ownerParticipantId);
        const note = await auditedRoomNoteWrite(request, () => context.runGuardedRoomEffect(storage, actor, room, permission,
          scoped => scoped.upsertRoomNote({ roomId, scope, ownerParticipantId, content, updatedBy: actor.actorId })));
        if (!existing) incrementCounter(metrics.notesCreatedTotal, scope);
        metrics.notesVersionsCreatedTotal += 1;
        incrementCounter(metrics.notesSavedTotal, `${scope}:saved`);
        json(response, existing ? 200 : 201, { note });
        return;
      })();
    }

    return null;
  }
}
