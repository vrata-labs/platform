import { ROOM_PLUGIN_CAPABILITIES, ROOM_PLUGIN_LIMITS, type RoomPluginCapability, type RoomPluginConfig, type RoomPluginConfigSchema } from "./contracts.js";
import { roomPluginDataPath, roomPluginFields, roomPluginRecord, roomPluginUtf8ByteLength, validateRoomPluginData } from "./data.js";
import { fail } from "./errors.js";

export function validateRoomPluginCapabilities(value: unknown): readonly RoomPluginCapability[] {
  const capabilities = validateRoomPluginData(value);
  if (!Array.isArray(capabilities)) fail("unknown_capability", "$.requestedCapabilities");
  const seen = new Set<string>();
  for (const capability of capabilities) {
    if (typeof capability !== "string" || !(ROOM_PLUGIN_CAPABILITIES as readonly string[]).includes(capability)) fail("unknown_capability", "$.requestedCapabilities");
    if (seen.has(capability)) fail("duplicate_capability", "$.requestedCapabilities");
    seen.add(capability);
  }
  return capabilities as readonly RoomPluginCapability[];
}

export function validateRoomPluginConfigSchema(value: unknown): RoomPluginConfigSchema {
  const schema = roomPluginRecord(validateRoomPluginData(value, { maxBytes: ROOM_PLUGIN_LIMITS.configBytes }), "$.configSchema", "invalid_config_schema");
  if (Object.keys(schema).length > ROOM_PLUGIN_LIMITS.configFields) fail("invalid_config_schema", "$.configSchema");
  for (const [key, raw] of Object.entries(schema)) {
    const path = roomPluginDataPath("$.configSchema", key);
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) fail("invalid_config_schema", path);
    const field = roomPluginRecord(raw, path, "invalid_config_schema");
    if (typeof field.required !== "boolean") fail("invalid_config_schema", path);
    switch (field.type) {
      case "string":
        roomPluginFields(field, ["type", "required", "minLength", "maxLength"], [], path);
        if (!Number.isInteger(field.minLength) || !Number.isInteger(field.maxLength) ||
          (field.minLength as number) < 0 || (field.maxLength as number) < (field.minLength as number) ||
          (field.maxLength as number) > ROOM_PLUGIN_LIMITS.configStringBytes) fail("invalid_config_schema", path);
        break;
      case "number":
        roomPluginFields(field, ["type", "required", "minimum", "maximum"], [], path);
        if (typeof field.minimum !== "number" || typeof field.maximum !== "number" || field.minimum > field.maximum) fail("invalid_config_schema", path);
        break;
      case "boolean":
        roomPluginFields(field, ["type", "required"], [], path);
        break;
      case "enum": {
        roomPluginFields(field, ["type", "required", "values"], [], path);
        if (!Array.isArray(field.values) || field.values.length === 0 || field.values.length > ROOM_PLUGIN_LIMITS.enumValues) fail("invalid_config_schema", path);
        const seen = new Set<string>();
        for (const choice of field.values) {
          if (typeof choice !== "string" || !choice.length || roomPluginUtf8ByteLength(choice) > ROOM_PLUGIN_LIMITS.enumValueBytes || seen.has(choice)) fail("invalid_config_schema", path);
          seen.add(choice);
        }
        break;
      }
      default: fail("invalid_config_schema", path);
    }
  }
  return schema as unknown as RoomPluginConfigSchema;
}

/** No defaults/coercion, nested values, expressions or unknown config keys. */
export function validateRoomPluginConfig(schemaInput: unknown, value: unknown): RoomPluginConfig {
  const schema = validateRoomPluginConfigSchema(schemaInput);
  const config = roomPluginRecord(validateRoomPluginData(value, { maxBytes: ROOM_PLUGIN_LIMITS.configBytes }), "$.config", "invalid_config");
  for (const key of Object.keys(config)) {
    if (!Object.hasOwn(schema, key)) fail("unknown_field", roomPluginDataPath("$.config", key));
  }
  for (const [key, field] of Object.entries(schema)) {
    const path = roomPluginDataPath("$.config", key);
    if (!Object.hasOwn(config, key)) {
      if (field.required) fail("missing_field", path);
      continue;
    }
    const current = config[key];
    switch (field.type) {
      case "string": {
        if (typeof current !== "string") fail("invalid_config", path);
        const bytes = roomPluginUtf8ByteLength(current);
        if (bytes < field.minLength || bytes > field.maxLength) fail("invalid_config", path);
        break;
      }
      case "number":
        if (typeof current !== "number" || current < field.minimum || current > field.maximum) fail("invalid_config", path);
        break;
      case "boolean":
        if (typeof current !== "boolean") fail("invalid_config", path);
        break;
      case "enum":
        if (typeof current !== "string" || !field.values.includes(current)) fail("invalid_config", path);
        break;
    }
  }
  return config as RoomPluginConfig;
}
