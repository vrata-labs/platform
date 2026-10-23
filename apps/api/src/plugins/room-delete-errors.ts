import { RoomPluginStorageError } from "./contracts.js";
import { RoomPluginBlobIoError, RoomPluginBlobConfigurationError } from "./blob-errors.js";
import { RoomPluginOperationPending } from "./package-service.js";

/** Business/storage-IO results only. Unrelated DB failures and uncertain commits reach request_failed. */
export function roomPluginDeletionFailure(error: unknown): { status: number; code: string } | null {
  if (error instanceof RoomPluginStorageError) return { status: error.code === "room_not_found" ? 404 : 409, code: error.code };
  if (error instanceof RoomPluginOperationPending) return { status: 503, code: "plugin_operation_pending" };
  if (error instanceof RoomPluginBlobIoError) return { status: 503, code: "room_plugin_cleanup_unavailable" };
  if (error instanceof RoomPluginBlobConfigurationError) return { status: 503, code: error.code };
  return null;
}
export function isRoomDeletionRequest(method: string | undefined, url: string | undefined): boolean {
  return method === "DELETE" && /^\/api\/rooms\/[^/?]+(?:\?.*)?$/.test(url ?? "");
}
