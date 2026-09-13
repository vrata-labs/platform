import type { Storage } from "./storage.js";
import { defaultSessionControlState } from "./room-session-control.js";

export function incrementCounter(counter: Map<string, number>, reason: string | undefined, amount = 1): void {
  const label = reason && reason.trim().length > 0 ? reason : "unknown";
  counter.set(label, (counter.get(label) ?? 0) + amount);
}

function formatMetricLine(name: string, value: number, labels?: Record<string, string>): string {
  const labelEntries = Object.entries(labels ?? {});
  const labelText = labelEntries.length === 0
    ? ""
    : `{${labelEntries.map(([key, labelValue]) => `${key}="${labelValue.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`).join(",")}}`;
  return `${name}${labelText} ${value}`;
}

export function createApiMetrics(
  presenceByRoom: ReadonlyMap<string, unknown>,
  cleanupAllPresence: () => void,
  activeParticipantCount: () => number
) {
  const metrics = {
    requestsTotal: 0,
    requestFailuresTotal: 0,
    diagnosticsReportsCreatedTotal: 0,
    roomJoinFailuresTotal: new Map<string, number>(),
    mediaJoinFailuresTotal: new Map<string, number>(),
    roomAccessDeniedTotal: new Map<string, number>(),
    hostActionsTotal: new Map<string, number>(),
    presenterChangesTotal: new Map<string, number>(),
    roomLockedTotal: 0,
    participantsRemovedTotal: 0,
    sessionsEndedTotal: 0,
    adminDashboardViewsTotal: 0,
    adminActionsTotal: new Map<string, number>(),
    roomsDisabledTotal: 0,
    invitesRevokedTotal: 0,
    roomsCreatedTotal: new Map<string, number>(),
    roomCreationFailuresTotal: new Map<string, number>(),
    sceneBundleUploadsTotal: new Map<string, number>(),
    sceneBundleUploadBytesTotal: 0,
    sceneBundleValidationFailuresTotal: new Map<string, number>(),
    notesCreatedTotal: new Map<string, number>(),
    notesSavedTotal: new Map<string, number>(),
    notesSaveFailuresTotal: new Map<string, number>(),
    notesPermissionDeniedTotal: 0,
    notesVersionsCreatedTotal: 0,
    notesRestoresTotal: new Map<string, number>(),
    notesExportsTotal: new Map<string, number>(),
    notesExportDeniedTotal: 0,
    documentsUploadedTotal: new Map<string, number>(),
    documentDownloadsTotal: 0,
    documentStorageBytesTotal: new Map<string, number>(),
    documentPermissionDeniedTotal: 0,
    documentDeletesTotal: 0,
    documentSurfaceSelectionsTotal: 0,
    pdfValidationFailuresTotal: new Map<string, number>(),
    documentPresentationContentTotal: new Map<string, number>(),
    documentBlobDeletesTotal: new Map<string, number>(),
    documentMediaValidationFailuresTotal: new Map<string, number>(),
    documentMediaContentTotal: new Map<string, number>(),
    personalRoomsCreatedTotal: 0,
    personalRoomOpensTotal: new Map<string, number>(),
    personalRoomAccessDeniedTotal: new Map<string, number>(),
    personalStateSaveFailuresTotal: new Map<string, number>(),
    screenShareStartedTotal: new Map<string, number>(),
    screenShareFailuresTotal: new Map<string, number>(),
    screenSharePermissionDeniedTotal: 0,
    screenShareActiveSessions: new Set<string>()
  };

  async function apiMetricsText(storage: Pick<Storage, "listRooms">): Promise<string> {
    cleanupAllPresence();
    const rooms = await storage.listRooms();
    const lines = [
      "# HELP vrata_api_requests_total Total API HTTP requests handled by this process.",
      "# TYPE vrata_api_requests_total counter",
      formatMetricLine("vrata_api_requests_total", metrics.requestsTotal),
      "# HELP vrata_api_request_failures_total Total unhandled API request failures.",
      "# TYPE vrata_api_request_failures_total counter",
      formatMetricLine("vrata_api_request_failures_total", metrics.requestFailuresTotal),
      "# HELP vrata_rooms_total Rooms known to the API storage backend.",
      "# TYPE vrata_rooms_total gauge",
      formatMetricLine("vrata_rooms_total", rooms.length),
      "# HELP vrata_active_rooms Rooms with currently fresh runtime presence.",
      "# TYPE vrata_active_rooms gauge",
      formatMetricLine("vrata_active_rooms", presenceByRoom.size),
      "# HELP vrata_active_participants Fresh runtime participants currently known by API fallback presence.",
      "# TYPE vrata_active_participants gauge",
      formatMetricLine("vrata_active_participants", activeParticipantCount()),
      "# HELP vrata_diagnostic_reports_created_total Runtime diagnostic reports accepted by API.",
      "# TYPE vrata_diagnostic_reports_created_total counter",
      formatMetricLine("vrata_diagnostic_reports_created_total", metrics.diagnosticsReportsCreatedTotal),
      "# HELP vrata_screen_share_started_total Screen share start diagnostics by result.",
      "# TYPE vrata_screen_share_started_total counter",
      ...Array.from(metrics.screenShareStartedTotal.entries()).map(([result, count]) => formatMetricLine("vrata_screen_share_started_total", count, { result })),
      "# HELP vrata_screen_share_active_sessions Active screen share sessions observed by diagnostics.",
      "# TYPE vrata_screen_share_active_sessions gauge",
      formatMetricLine("vrata_screen_share_active_sessions", metrics.screenShareActiveSessions.size),
      "# HELP vrata_screen_share_failures_total Screen share failure diagnostics by reason.",
      "# TYPE vrata_screen_share_failures_total counter",
      ...Array.from(metrics.screenShareFailuresTotal.entries()).map(([reason, count]) => formatMetricLine("vrata_screen_share_failures_total", count, { reason })),
      "# HELP vrata_screen_share_permission_denied_total Screen share permission denials observed by diagnostics.",
      "# TYPE vrata_screen_share_permission_denied_total counter",
      formatMetricLine("vrata_screen_share_permission_denied_total", metrics.screenSharePermissionDeniedTotal),
      "# HELP vrata_room_join_failures_total Runtime join or room failures reported by clients.",
      "# TYPE vrata_room_join_failures_total counter"
    ];
    for (const [reason, count] of metrics.roomJoinFailuresTotal.entries()) {
      lines.push(formatMetricLine("vrata_room_join_failures_total", count, { reason }));
    }
    lines.push(
      "# HELP vrata_room_access_denied_total Room access policy denials observed by API.",
      "# TYPE vrata_room_access_denied_total counter"
    );
    for (const [reason, count] of metrics.roomAccessDeniedTotal.entries()) {
      lines.push(formatMetricLine("vrata_room_access_denied_total", count, { reason }));
    }
    lines.push(
      "# HELP vrata_host_actions_total Host control actions observed by API.",
      "# TYPE vrata_host_actions_total counter"
    );
    for (const [label, count] of metrics.hostActionsTotal.entries()) {
      const [action = "unknown", result = "unknown"] = label.split(":");
      lines.push(formatMetricLine("vrata_host_actions_total", count, { action, result }));
    }
    lines.push(
      "# HELP vrata_presenter_changes_total Presenter grant or revoke decisions by action and result.",
      "# TYPE vrata_presenter_changes_total counter"
    );
    for (const [label, count] of metrics.presenterChangesTotal.entries()) {
      const [action = "unknown", result = "unknown"] = label.split(":");
      lines.push(formatMetricLine("vrata_presenter_changes_total", count, { action, result }));
    }
    lines.push(
      "# HELP vrata_room_locked_total Room lock actions accepted by API.",
      "# TYPE vrata_room_locked_total counter",
      formatMetricLine("vrata_room_locked_total", metrics.roomLockedTotal),
      "# HELP vrata_active_presenter_sessions Rooms with an active presenter assignment.",
      "# TYPE vrata_active_presenter_sessions gauge",
      formatMetricLine("vrata_active_presenter_sessions", rooms.filter((room) => Boolean(defaultSessionControlState(room.sessionControl).presenterParticipantId)).length),
      "# HELP vrata_participants_removed_total Participant removals accepted by API.",
      "# TYPE vrata_participants_removed_total counter",
      formatMetricLine("vrata_participants_removed_total", metrics.participantsRemovedTotal),
      "# HELP vrata_sessions_ended_total Session end actions accepted by API.",
      "# TYPE vrata_sessions_ended_total counter",
      formatMetricLine("vrata_sessions_ended_total", metrics.sessionsEndedTotal),
      "# HELP vrata_admin_dashboard_views_total Admin dashboard session views accepted by API.",
      "# TYPE vrata_admin_dashboard_views_total counter",
      formatMetricLine("vrata_admin_dashboard_views_total", metrics.adminDashboardViewsTotal),
      "# HELP vrata_rooms_disabled_total Rooms disabled through the control plane.",
      "# TYPE vrata_rooms_disabled_total counter",
      formatMetricLine("vrata_rooms_disabled_total", metrics.roomsDisabledTotal),
      "# HELP vrata_invites_revoked_total Room invites revoked through the control plane.",
      "# TYPE vrata_invites_revoked_total counter",
      formatMetricLine("vrata_invites_revoked_total", metrics.invitesRevokedTotal),
      "# HELP vrata_rooms_created_total Rooms created through the API by source and visibility.",
      "# TYPE vrata_rooms_created_total counter",
      ...Array.from(metrics.roomsCreatedTotal.entries()).map(([label, count]) => {
        const [source = "unknown", visibility = "unknown"] = label.split(":");
        return formatMetricLine("vrata_rooms_created_total", count, { source, visibility });
      }),
      "# HELP vrata_room_creation_failures_total Room creation failures by reason.",
      "# TYPE vrata_room_creation_failures_total counter",
      ...Array.from(metrics.roomCreationFailuresTotal.entries()).map(([reason, count]) => formatMetricLine("vrata_room_creation_failures_total", count, { reason })),
      "# HELP vrata_personal_rooms_created_total Personal rooms created through the self-service runtime flow.",
      "# TYPE vrata_personal_rooms_created_total counter",
      formatMetricLine("vrata_personal_rooms_created_total", metrics.personalRoomsCreatedTotal),
      "# HELP vrata_personal_room_opens_total Personal room open requests by result.",
      "# TYPE vrata_personal_room_opens_total counter",
      ...Array.from(metrics.personalRoomOpensTotal.entries()).map(([result, count]) => formatMetricLine("vrata_personal_room_opens_total", count, { result })),
      "# HELP vrata_personal_room_access_denied_total Personal room access denials by reason.",
      "# TYPE vrata_personal_room_access_denied_total counter",
      ...Array.from(metrics.personalRoomAccessDeniedTotal.entries()).map(([reason, count]) => formatMetricLine("vrata_personal_room_access_denied_total", count, { reason })),
      "# HELP vrata_personal_state_save_failures_total Personal state save failures by reason.",
      "# TYPE vrata_personal_state_save_failures_total counter",
      ...Array.from(metrics.personalStateSaveFailuresTotal.entries()).map(([reason, count]) => formatMetricLine("vrata_personal_state_save_failures_total", count, { reason })),
      "# HELP vrata_scene_bundle_upload_bytes_total Uploaded scene bundle bytes accepted by API.",
      "# TYPE vrata_scene_bundle_upload_bytes_total counter",
      formatMetricLine("vrata_scene_bundle_upload_bytes_total", metrics.sceneBundleUploadBytesTotal),
      "# HELP vrata_documents_uploaded_total Document upload attempts by MIME and result.",
      "# TYPE vrata_documents_uploaded_total counter",
      ...Array.from(metrics.documentsUploadedTotal.entries()).map(([label, count]) => {
        const [mime = "unknown", result = "unknown"] = label.split(":");
        return formatMetricLine("vrata_documents_uploaded_total", count, { mime, result });
      }),
      "# HELP vrata_document_downloads_total Authorized document downloads.",
      "# TYPE vrata_document_downloads_total counter",
      formatMetricLine("vrata_document_downloads_total", metrics.documentDownloadsTotal),
      "# HELP vrata_document_storage_bytes Document bytes accepted by tenant.",
      "# TYPE vrata_document_storage_bytes counter",
      ...Array.from(metrics.documentStorageBytesTotal.entries()).map(([tenant, count]) => formatMetricLine("vrata_document_storage_bytes", count, { tenant })),
      "# HELP vrata_document_permission_denied_total Document permission denials.",
      "# TYPE vrata_document_permission_denied_total counter",
      formatMetricLine("vrata_document_permission_denied_total", metrics.documentPermissionDeniedTotal),
      "# HELP vrata_document_deletes_total Document delete actions accepted by API.",
      "# TYPE vrata_document_deletes_total counter",
      formatMetricLine("vrata_document_deletes_total", metrics.documentDeletesTotal),
      "# HELP vrata_document_surface_selections_total Document surface selection actions accepted by API.",
      "# TYPE vrata_document_surface_selections_total counter",
      formatMetricLine("vrata_document_surface_selections_total", metrics.documentSurfaceSelectionsTotal),
      "# HELP vrata_pdf_validation_failures_total Rejected PDF uploads by stable reason.",
      "# TYPE vrata_pdf_validation_failures_total counter",
      ...Array.from(metrics.pdfValidationFailuresTotal.entries()).map(([reason, count]) => formatMetricLine("vrata_pdf_validation_failures_total", count, { reason })),
      "# HELP vrata_document_presentation_content_total Presentation content requests by result.",
      "# TYPE vrata_document_presentation_content_total counter",
      ...Array.from(metrics.documentPresentationContentTotal.entries()).map(([result, count]) => formatMetricLine("vrata_document_presentation_content_total", count, { result })),
      "# HELP vrata_document_blob_deletes_total Document blob delete attempts by result.",
      "# TYPE vrata_document_blob_deletes_total counter",
      ...Array.from(metrics.documentBlobDeletesTotal.entries()).map(([result, count]) => formatMetricLine("vrata_document_blob_deletes_total", count, { result })),
      "# HELP vrata_document_media_validation_failures_total Rejected image and video uploads by bounded reason.",
      "# TYPE vrata_document_media_validation_failures_total counter",
      ...Array.from(metrics.documentMediaValidationFailuresTotal.entries()).map(([key, count]) => {
        const [kind, reason] = key.split(":");
        return formatMetricLine("vrata_document_media_validation_failures_total", count, { kind, reason });
      }),
      "# HELP vrata_document_media_content_total Authenticated image and video content requests by result.",
      "# TYPE vrata_document_media_content_total counter",
      ...Array.from(metrics.documentMediaContentTotal.entries()).map(([key, count]) => {
        const [kind, result] = key.split(":");
        return formatMetricLine("vrata_document_media_content_total", count, { kind, result });
      }),
      "# HELP vrata_notes_created_total Notes first created through the API by scope.",
      "# TYPE vrata_notes_created_total counter",
      ...Array.from(metrics.notesCreatedTotal.entries()).map(([scope, count]) => formatMetricLine("vrata_notes_created_total", count, { scope })),
      "# HELP vrata_notes_saved_total Notes save attempts by scope and result.",
      "# TYPE vrata_notes_saved_total counter",
      ...Array.from(metrics.notesSavedTotal.entries()).map(([label, count]) => {
        const [scope = "unknown", result = "unknown"] = label.split(":");
        return formatMetricLine("vrata_notes_saved_total", count, { scope, result });
      }),
      "# HELP vrata_notes_save_failures_total Notes save failures by reason.",
      "# TYPE vrata_notes_save_failures_total counter",
      ...Array.from(metrics.notesSaveFailuresTotal.entries()).map(([reason, count]) => formatMetricLine("vrata_notes_save_failures_total", count, { reason })),
      "# HELP vrata_notes_permission_denied_total Notes permission denials.",
      "# TYPE vrata_notes_permission_denied_total counter",
      formatMetricLine("vrata_notes_permission_denied_total", metrics.notesPermissionDeniedTotal),
      "# HELP vrata_note_versions_created_total Note history versions created.",
      "# TYPE vrata_note_versions_created_total counter",
      formatMetricLine("vrata_note_versions_created_total", metrics.notesVersionsCreatedTotal),
      "# HELP vrata_note_restores_total Note restore attempts by scope and result.",
      "# TYPE vrata_note_restores_total counter",
      ...Array.from(metrics.notesRestoresTotal.entries()).map(([label, count]) => {
        const [scope = "unknown", result = "unknown"] = label.split(":");
        return formatMetricLine("vrata_note_restores_total", count, { scope, result });
      }),
      "# HELP vrata_note_exports_total Note export attempts by format and result.",
      "# TYPE vrata_note_exports_total counter",
      ...Array.from(metrics.notesExportsTotal.entries()).map(([label, count]) => {
        const [format = "unknown", result = "unknown"] = label.split(":");
        return formatMetricLine("vrata_note_exports_total", count, { format, result });
      }),
      "# HELP vrata_note_export_denied_total Note export denials.",
      "# TYPE vrata_note_export_denied_total counter",
      formatMetricLine("vrata_note_export_denied_total", metrics.notesExportDeniedTotal)
    );
    lines.push(
      "# HELP vrata_admin_actions_total Control-plane admin authorization decisions by action and result.",
      "# TYPE vrata_admin_actions_total counter"
    );
    for (const [label, count] of metrics.adminActionsTotal.entries()) {
      const [action = "unknown", result = "unknown"] = label.split(":");
      lines.push(formatMetricLine("vrata_admin_actions_total", count, { action, result }));
    }
    lines.push(
      "# HELP vrata_scene_bundle_uploads_total Scene bundle upload attempts by result.",
      "# TYPE vrata_scene_bundle_uploads_total counter"
    );
    for (const [result, count] of metrics.sceneBundleUploadsTotal.entries()) {
      lines.push(formatMetricLine("vrata_scene_bundle_uploads_total", count, { result }));
    }
    lines.push(
      "# HELP vrata_scene_bundle_validation_failures_total Scene bundle upload validation failures by reason.",
      "# TYPE vrata_scene_bundle_validation_failures_total counter"
    );
    for (const [reason, count] of metrics.sceneBundleValidationFailuresTotal.entries()) {
      lines.push(formatMetricLine("vrata_scene_bundle_validation_failures_total", count, { reason }));
    }
    lines.push(
      "# HELP vrata_media_join_failures_total Media token or media join failures observed by API.",
      "# TYPE vrata_media_join_failures_total counter"
    );
    for (const [reason, count] of metrics.mediaJoinFailuresTotal.entries()) {
      lines.push(formatMetricLine("vrata_media_join_failures_total", count, { reason }));
    }
    return `${lines.join("\n")}\n`;
  }

  return { metrics, apiMetricsText };
}
