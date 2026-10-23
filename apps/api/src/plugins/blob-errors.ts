export class RoomPluginBlobIoError extends Error {
  constructor(readonly operation: "put" | "read" | "delete", cause: unknown) {
    super(`plugin_blob_${operation}_failed`, { cause }); this.name = "RoomPluginBlobIoError";
  }
}
export class RoomPluginBlobConfigurationError extends Error {
  constructor(readonly code: "plugin_blob_configuration_unavailable" | "plugin_blob_backend_mismatch", cause?: unknown) {
    super(code, { cause }); this.name = "RoomPluginBlobConfigurationError";
  }
}
