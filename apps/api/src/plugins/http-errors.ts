import { RoomPluginValidationError } from "@vrata/room-plugin-sdk";
import { IdentityStorageError } from "../identity/contracts.js";
import { identityFenceUnavailable } from "../identity/fence-transaction.js";
import { IdentityBoundaryError } from "../identity/legacy-boundary.js";
import { RoomPluginAccessError } from "./access-contracts.js";
import { RoomPluginBlobConfigurationError, RoomPluginBlobIoError } from "./blob-errors.js";
import { RoomPluginStorageError } from "./contracts.js";
import { RoomPluginHttpOperationPending } from "./package-http-service.js";
import { RoomPluginRequestBodyError } from "./request-body.js";

export class RoomPluginHttpError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 405, readonly code: "plugin_invalid_request" | "identity_required" | "plugin_request_forbidden" | "plugin_method_not_allowed" | "room_not_found" | "room_mismatch") {
    super(code); this.name = "RoomPluginHttpError";
  }
}
/** Only whitelisted codes, never error.message, validation paths, private records or nested causes. */
export function roomPluginHttpError(error: unknown): { status: number; body: { error: string; reason?: string } } {
  const result = (status: number, code: string, reason?: string) => ({ status, body: { error: code, ...(reason ? { reason } : {}) } });
  if (error instanceof RoomPluginHttpOperationPending) return result(503, "plugin_operation_pending");
  if (identityFenceUnavailable(error)) return result(503, "identity_authority_unavailable");
  if (error instanceof IdentityBoundaryError) return result(error.status,
    error.status === 503 ? "identity_authority_unavailable" : error.reason === "identity_session_expired" ? "identity_session_expired" : "identity_required", error.reason);
  if (error instanceof IdentityStorageError) {
    if (error.code === "identity_session_expired") return result(401, error.code, error.code);
    if (error.code === "room_not_found") return result(404, error.code);
    if (error.code === "identity_not_active") return result(401, "identity_required", "identity_recovery_required");
    if (["identity_forbidden", "room_blocked"].includes(error.code)) return result(403, "plugin_author_forbidden");
    return result(503, "identity_authority_unavailable");
  }
  if (error instanceof RoomPluginAccessError) {
    switch (error.code) {
      case "plugin_identity_not_active": return result(409, error.code);
      case "plugin_author_forbidden": return result(403, error.code);
      case "plugin_content_not_bound": return result(403, error.code);
      case "plugin_binding_changed": return result(409, error.code);
      case "plugin_ticket_invalid": return result(503, "plugin_operation_pending");
    }
  }
  if (error instanceof RoomPluginStorageError) {
    switch (error.code) {
      case "room_not_found": case "plugin_package_not_found": return result(404, error.code);
      case "plugin_invalid_binding": case "plugin_invalid_persisted_text": return result(400, error.code);
      case "plugin_capability_approval_required": return result(403, error.code);
      case "plugin_upload_pending": case "plugin_package_not_ready": case "room_plugin_cleanup_pending": return result(503, error.code);
      default: return result(409, error.code);
    }
  }
  if (error instanceof RoomPluginValidationError) return result(400, error.code);
  if (error instanceof RoomPluginRequestBodyError) return result(error.code === "plugin_body_too_large" ? 413 : error.code === "plugin_body_timeout" ? 408 : 400, error.code);
  if (error instanceof RoomPluginBlobConfigurationError) return result(503, error.code);
  if (error instanceof RoomPluginBlobIoError) return result(503, "plugin_blob_unavailable");
  if (error instanceof RoomPluginHttpError) return result(error.status, error.code);
  return result(503, "plugin_backend_unavailable");
}
