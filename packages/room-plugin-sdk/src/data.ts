import { ROOM_PLUGIN_LIMITS } from "./contracts.js";
import { fail, type RoomPluginValidationErrorCode } from "./errors.js";

export type RoomPluginJson = null | boolean | number | string | readonly RoomPluginJson[] | { readonly [key: string]: RoomPluginJson };
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);

/** Bounded byte counting without allocating an encoded copy of an oversized string. */
export function roomPluginUtf8ByteLength(text: string, maximum = Infinity, code: RoomPluginValidationErrorCode = "message_too_large"): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("invalid_utf8");
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail("invalid_utf8");
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (bytes > maximum) fail(code);
  }
  return bytes;
}

export function roomPluginDataPath(parent: string, key: string): string {
  return `${parent}.${key.slice(0, 48)}`.slice(0, 160);
}

/** Check size and nesting before JSON.parse. Duplicate JSON keys are not last-write-wins. */
function preflightJson(text: string, maximumDepth: number): void {
  const stack: { kind: string; expectingKey: boolean; keys: Set<string> }[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const start = i;
      while (++i < text.length) {
        if (text[i] === "\\") i++;
        else if (text[i] === '"') break;
      }
      const frame = stack[stack.length - 1];
      if (frame?.kind === "{" && frame.expectingKey) {
        let key: unknown;
        try { key = JSON.parse(text.slice(start, i + 1)); } catch { fail("invalid_json"); }
        if (typeof key !== "string") fail("invalid_json");
        if (frame.keys.has(key)) fail("duplicate_field");
        frame.keys.add(key);
        frame.expectingKey = false;
      }
    } else if (char === "{" || char === "[") {
      stack.push({ kind: char, expectingKey: char === "{", keys: new Set() });
      if (stack.length > maximumDepth) fail("nesting_too_deep");
    } else if (char === "}" || char === "]") {
      stack.pop();
    } else if (char === "," && stack[stack.length - 1]?.kind === "{") {
      stack[stack.length - 1].expectingKey = true;
    }
  }
}

export interface RoomPluginDataLimits {
  maxBytes?: number;
  maxDepth?: number;
  sizeError?: RoomPluginValidationErrorCode;
}

/**
 * Copies only JSON data. Does not call getters, toJSON, valueOf or user iterators.
 * Native callers must not pass VM handles/proxies; the VM must bound serialization first.
 */
export function validateRoomPluginData(value: unknown, limits: RoomPluginDataLimits = {}): RoomPluginJson {
  const maximum = limits.maxBytes ?? ROOM_PLUGIN_LIMITS.messageBytes;
  const depthLimit = limits.maxDepth ?? ROOM_PLUGIN_LIMITS.dataDepth;
  const sizeError = limits.sizeError ?? "message_too_large";
  const ancestors = new Set<object>();
  let bytes = 0;
  function add(amount: number): void {
    bytes += amount;
    if (bytes > maximum) fail(sizeError);
  }
  function stringBytes(text: string): number {
    roomPluginUtf8ByteLength(text, maximum, sizeError);
    return roomPluginUtf8ByteLength(JSON.stringify(text), maximum, sizeError);
  }
  function copy(input: unknown, depth: number, path: string): RoomPluginJson {
    if (input === null) { add(4); return null; }
    if (typeof input === "boolean") { add(input ? 4 : 5); return input; }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) fail("invalid_data", path);
      add(JSON.stringify(input).length);
      return input;
    }
    if (typeof input === "string") { add(stringBytes(input)); return input; }
    if (typeof input !== "object") fail("invalid_data", path);
    if (depth > depthLimit) fail("nesting_too_deep", path);
    if (ancestors.has(input)) fail("invalid_data", path);
    const array = Array.isArray(input);
    const proto = Object.getPrototypeOf(input);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail("invalid_data", path);
    ancestors.add(input);
    add(2);
    const keys = Reflect.ownKeys(input);
    const output: RoomPluginJson[] | Record<string, RoomPluginJson> = array ? [] : Object.create(null);
    let index = 0;
    for (const key of keys) {
      if (typeof key !== "string") fail("invalid_data", path);
      if (array && key === "length") continue;
      const childPath = roomPluginDataPath(path, key);
      if (unsafeKeys.has(key)) fail("unsafe_key", childPath);
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      if (!("value" in descriptor) || !descriptor.enumerable) fail("invalid_data", childPath);
      if (array && key !== String(index)) fail("invalid_data", childPath);
      if (index++ > 0) add(1);
      if (!array) add(stringBytes(key) + 1);
      const child = copy(descriptor.value, depth + 1, childPath);
      if (array) (output as RoomPluginJson[]).push(child);
      else (output as Record<string, RoomPluginJson>)[key] = child;
    }
    if (array && index !== Object.getOwnPropertyDescriptor(input, "length")!.value) fail("invalid_data", path);
    ancestors.delete(input);
    return Object.freeze(output);
  }
  return copy(value, 1, "$");
}

/** Only bounded UTF-8 input is parsed. A BOM and unpaired Unicode surrogates are rejected. */
export function parseRoomPluginJson(input: string | Uint8Array, limits: RoomPluginDataLimits = {}): RoomPluginJson {
  const maximum = limits.maxBytes ?? ROOM_PLUGIN_LIMITS.messageBytes;
  const sizeError = limits.sizeError ?? "message_too_large";
  let text: string;
  if (typeof input === "string") {
    roomPluginUtf8ByteLength(input, maximum, sizeError);
    text = input;
  } else if (input instanceof Uint8Array) {
    if (input.byteLength > maximum) fail(sizeError);
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input); }
    catch { fail("invalid_utf8"); }
  } else {
    fail("invalid_data");
  }
  preflightJson(text, limits.maxDepth ?? ROOM_PLUGIN_LIMITS.dataDepth);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { fail("invalid_json"); }
  return validateRoomPluginData(parsed, limits);
}

export function roomPluginRecord(value: unknown, path: string, code: RoomPluginValidationErrorCode = "invalid_data"): Record<string, RoomPluginJson> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code, path);
  return value as Record<string, RoomPluginJson>;
}

export function roomPluginFields(record: Record<string, unknown>, required: readonly string[], optional: readonly string[], path: string): void {
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) fail("unknown_field", roomPluginDataPath(path, key));
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) fail("missing_field", roomPluginDataPath(path, key));
  }
}
