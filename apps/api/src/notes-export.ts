import type { RoomNoteRecord, RoomNoteVersionRecord } from "./storage.js";

export function noteExportFilename(roomId: string, scope: string, extension: string): string {
  return `vrata-${roomId}-${scope}-notes.${extension}`.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function noteExportJson(note: RoomNoteRecord, versions: RoomNoteVersionRecord[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    note,
    versions
  };
}

export function formatNoteMarkdown(note: RoomNoteRecord, versions: RoomNoteVersionRecord[]): string {
  const lines = [
    "# Vrata notes export",
    "",
    `Room: ${note.roomId}`,
    `Scope: ${note.scope}`,
    ...(note.ownerParticipantId ? [`Owner participant: ${note.ownerParticipantId}`] : []),
    `Updated: ${note.updatedAt ?? "never"}`,
    ...(note.deletedAt ? [`Deleted: ${note.deletedAt}`] : []),
    "",
    "## Current content",
    "",
    note.deletedAt ? "_This note is currently deleted._" : note.content || "_Empty note._",
    "",
    "## History",
    "",
    ...versions.map((version) => `- ${version.createdAt} ${version.action}${version.restoredFromVersionId ? ` from ${version.restoredFromVersionId}` : ""} by ${version.createdBy ?? "unknown"}`)
  ];
  return `${lines.join("\n")}\n`;
}

export function formatRoomNotesMarkdown(roomId: string, items: Array<{ note: RoomNoteRecord; versions: RoomNoteVersionRecord[] }>): string {
  return `${[
    "# Vrata room notes export",
    "",
    `Room: ${roomId}`,
    `Exported: ${new Date().toISOString()}`,
    "",
    ...items.flatMap(({ note, versions }) => [
      `## ${note.scope}${note.ownerParticipantId ? ` / ${note.ownerParticipantId}` : ""}`,
      "",
      note.deletedAt ? "_This note is currently deleted._" : note.content || "_Empty note._",
      "",
      `Versions: ${versions.length}`,
      ""
    ])
  ].join("\n")}\n`;
}
