import test from "node:test";
import assert from "node:assert/strict";
import { parseRoomPluginJson, roomPluginUtf8ByteLength, validateRoomPluginData } from "../data.js";
import { validateRoomPluginConfig, validateRoomPluginConfigSchema } from "../config.js";
import { ROOM_PLUGIN_LIMITS } from "../contracts.js";
import { RoomPluginValidationError, type RoomPluginValidationErrorCode } from "../errors.js";

function error(action: () => unknown, code: RoomPluginValidationErrorCode): void {
  assert.throws(action, (cause: unknown) => cause instanceof RoomPluginValidationError && cause.code === code);
}
const schema = {
  title: { type: "string", required: true, minLength: 2, maxLength: 4 },
  count: { type: "number", required: false, minimum: 0, maximum: 8 },
  enabled: { type: "boolean", required: false },
  mode: { type: "enum", required: false, values: ["first", "second"] }
};

test("flat typed config is copied/frozen without coercion or mutation", () => {
  const input = { title: "é", count: 8, enabled: true, mode: "first" };
  const checked = validateRoomPluginConfig(schema, input);
  assert.equal(checked.title, "é");
  assert.equal(checked.count, 8);
  assert.ok(Object.isFrozen(checked));
  input.title = "new";
  assert.equal(checked.title, "é");
  assert.equal(validateRoomPluginConfig(schema, { title: "🙂" }).title, "🙂");
  error(() => validateRoomPluginConfig(schema, { title: "🙂a" }), "invalid_config");
});

test("config rejects missing required, unknown/nested/null and incorrectly typed values", () => {
  error(() => validateRoomPluginConfig(schema, {}), "missing_field");
  error(() => validateRoomPluginConfig(schema, null), "invalid_config");
  error(() => validateRoomPluginConfig(schema, { title: "ok", extra: true }), "unknown_field");
  for (const value of [{ title: true }, { title: { text: "ok" } }, { title: null }, { title: "a" },
    { title: "ok", count: "1" }, { title: "ok", count: -1 }, { title: "ok", count: 9 },
    { title: "ok", enabled: 1 }, { title: "ok", mode: "other" }]) {
    error(() => validateRoomPluginConfig(schema, value), "invalid_config");
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    error(() => validateRoomPluginConfig(schema, { title: "ok", count: value }), "invalid_data");
  }
});

test("config schema rejects executable/nested definitions and invalid limits", () => {
  for (const field of [
    { type: "string", required: true, minLength: -1, maxLength: 8 },
    { type: "string", required: true, minLength: 9, maxLength: 8 },
    { type: "string", required: true, minLength: 0, maxLength: 4097 },
    { type: "string", required: true, minLength: 0.5, maxLength: 8 },
    { type: "number", required: false, minimum: 2, maximum: 1 },
    { type: "number", required: false, minimum: "0", maximum: 1 },
    { type: "boolean", required: "yes" },
    { type: "object", required: false, properties: {} },
    { type: "enum", required: false, values: [] },
    { type: "enum", required: false, values: ["a", "a"] },
    { type: "enum", required: false, values: [true] },
    { type: "enum", required: false, values: ["é".repeat(129)] },
    { type: "enum", required: false, values: Array.from({ length: 33 }, (_, i) => String(i)) }
  ]) error(() => validateRoomPluginConfigSchema({ field }), "invalid_config_schema");
  error(() => validateRoomPluginConfigSchema({ field: { type: "boolean", required: true, default: true } }), "unknown_field");
  error(() => validateRoomPluginConfigSchema({ field: { type: "string", required: true, minLength: 0, maxLength: 1, pattern: "execute" } }), "unknown_field");
  error(() => validateRoomPluginConfigSchema({ field: { type: "number", required: false, minimum: 0, maximum: Infinity } }), "invalid_data");
  error(() => validateRoomPluginConfigSchema(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}`, { type: "boolean", required: false }]))), "invalid_config_schema");
});

test("null prototype records are safe, custom prototypes and class instances are not", () => {
  const value = Object.assign(Object.create(null), { safe: true });
  assert.equal((validateRoomPluginData(value) as Record<string, unknown>).safe, true);
  for (const item of [new Date(), new Map(), new Set(), new Uint8Array([1]), Object.create({ inherited: "no" }), new (class Data { safe = true; })()]) {
    error(() => validateRoomPluginData(item), "invalid_data");
  }
});

test("getters, toJSON, symbols, hidden properties, functions and cycles never cross", () => {
  let calls = 0;
  const getter = Object.defineProperty({}, "value", { enumerable: true, get() { calls++; return true; } });
  const serializer = { toJSON() { calls++; return {}; } };
  for (const value of [getter, serializer, { [Symbol("secret")]: true }, Object.defineProperty({}, "hidden", { value: true }),
    { fn: () => true }, { bigint: 1n }, { undef: undefined }, new Array(3), Object.assign([1], { extra: 2 })]) {
    error(() => validateRoomPluginData(value), "invalid_data");
  }
  const cycle: any = {};
  cycle.self = cycle;
  error(() => validateRoomPluginData(cycle), "invalid_data");
  assert.equal(calls, 0);
});

test("prototype pollution keys are rejected at every nesting level", () => {
  for (const key of ["__proto__", "prototype", "constructor"]) {
    const value = JSON.parse(`{"safe":{"${key}":{"polluted":true}}}`);
    error(() => validateRoomPluginData(value), "unsafe_key");
    error(() => parseRoomPluginJson(JSON.stringify(value)), "unsafe_key");
  }
  assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
});

test("native data and serialized JSON have inclusive byte/depth limits", () => {
  const value = "x".repeat(ROOM_PLUGIN_LIMITS.messageBytes - 2);
  assert.equal(validateRoomPluginData(value), value);
  assert.equal(parseRoomPluginJson(JSON.stringify(value)), value);
  error(() => validateRoomPluginData(value + "x"), "message_too_large");
  error(() => parseRoomPluginJson(JSON.stringify(value) + " "), "message_too_large");
  const escaped = "\u0000".repeat(3000);
  error(() => validateRoomPluginData(escaped), "message_too_large");
  const nested = "[".repeat(8) + "null" + "]".repeat(8);
  parseRoomPluginJson(nested);
  error(() => parseRoomPluginJson("[" + nested + "]"), "nesting_too_deep");
  let object: any = {};
  for (let i = 0; i < 10_000; i++) object = { next: object };
  error(() => validateRoomPluginData(object), "nesting_too_deep");
});

test("UTF-8 count agrees with Buffer, rejects malformed Unicode and never normalizes", () => {
  for (const value of ["ASCII", "é", "e\u0301", "🙂", "Привет", "\r\n"]) {
    assert.equal(roomPluginUtf8ByteLength(value), Buffer.byteLength(value));
  }
  for (const value of ["\ud800", "\udc00", "\ud800x"]) error(() => roomPluginUtf8ByteLength(value), "invalid_utf8");
  error(() => parseRoomPluginJson('"\\ud800"'), "invalid_utf8");
  error(() => parseRoomPluginJson('{"n":1e999}'), "invalid_data");
  error(() => parseRoomPluginJson('{"x":1,"x":2}'), "duplicate_field");
});
