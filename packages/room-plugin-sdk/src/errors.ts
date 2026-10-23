export const ROOM_PLUGIN_VALIDATION_ERROR_CODES = Object.freeze([
  "artifact_too_large", "message_too_large", "invalid_utf8", "invalid_json",
  "duplicate_field", "nesting_too_deep", "invalid_data", "unsafe_key",
  "unknown_field", "missing_field", "unsupported_schema_version", "unsupported_sdk_api_version",
  "invalid_manifest", "unknown_capability", "duplicate_capability", "invalid_config_schema",
  "invalid_config", "invalid_hash", "entry_checksum_mismatch", "artifact_checksum_mismatch",
  "invalid_module", "module_import_forbidden", "invalid_request", "invalid_event", "invalid_response", "invalid_instance_identity"
] as const);
export type RoomPluginValidationErrorCode = (typeof ROOM_PLUGIN_VALIDATION_ERROR_CODES)[number];

export class RoomPluginValidationError extends Error {
  readonly code: RoomPluginValidationErrorCode;
  readonly path: string;
  constructor(code: RoomPluginValidationErrorCode, path = "$", message: string = code) {
    super(message);
    this.name = "RoomPluginValidationError";
    this.code = code;
    // Errors are rendered by trusted UI; never echo arbitrary code or giant property names.
    this.path = path.slice(0, 160);
  }
}

export function fail(code: RoomPluginValidationErrorCode, path = "$", message?: string): never {
  throw new RoomPluginValidationError(code, path, message);
}
