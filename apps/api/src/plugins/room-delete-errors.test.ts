import assert from "node:assert/strict";
import test from "node:test";
import { RoomFenceCommitUncertain } from "../identity/fence-transaction.js";
import { RoomPluginStorageError } from "./contracts.js";
import { RoomPluginOperationPending } from "./package-service.js";
import { RoomPluginBlobIoError, RoomPluginBlobConfigurationError } from "./blob-errors.js";
import { roomPluginDeletionFailure } from "./room-delete-errors.js";

test("room deletion classifies only business/pending/known blob failures with bounded public codes", () => {
  assert.deepEqual(roomPluginDeletionFailure(new RoomPluginStorageError("room_not_found")), { status: 404, code: "room_not_found" });
  assert.deepEqual(roomPluginDeletionFailure(new RoomPluginStorageError("plugin_upload_pending")), { status: 409, code: "plugin_upload_pending" });
  assert.deepEqual(roomPluginDeletionFailure(new RoomPluginOperationPending("internal-package-id", new Error("secret-storage-password"))), { status: 503, code: "plugin_operation_pending" });
  assert.deepEqual(roomPluginDeletionFailure(new RoomPluginBlobIoError("delete", new Error("/private/root credentials"))), { status: 503, code: "room_plugin_cleanup_unavailable" });
  assert.deepEqual(roomPluginDeletionFailure(new RoomPluginBlobConfigurationError("plugin_blob_backend_mismatch")), { status: 503, code: "plugin_blob_backend_mismatch" });
  for (const error of [new Error("unrelated SQL failure"), new RoomFenceCommitUncertain(new Error("password in database URL")),
    new Error("raw configuration failure"), { code: "room_not_found" }, "plugin_upload_pending"]) assert.equal(roomPluginDeletionFailure(error), null);
});
