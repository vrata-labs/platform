import { SANDBOX_LIMITS } from "./limits.js";

/** Trusted source evaluated only inside QuickJS, before the guest module.
 * No guest object is ever dumped, coerced, or passed to a native host callback.
 * All reflection (including Proxy traps) remains inside the interrupted VM turn.
 */
export const VM_BOOTSTRAP = `(() => {
  "use strict";
  const apply = Reflect.apply, ownKeys = Reflect.ownKeys;
  const descriptor = Object.getOwnPropertyDescriptor, proto = Object.getPrototypeOf;
  const create = Object.create, define = Object.defineProperty, freeze = Object.freeze;
  const hasOwn = Object.prototype.hasOwnProperty;
  const objectProto = Object.prototype, arrayProto = Array.prototype;
  const isArray = Array.isArray, finite = Number.isFinite;
  const stringify = JSON.stringify, parse = JSON.parse;
  const charCodeAt = String.prototype.charCodeAt, StringValue = String;
  const forbiddenText = /[\\p{Cf}\\p{Cc}\\p{Zl}\\p{Zp}]/u, regexExec = RegExp.prototype.exec;
  const PromiseValue = Promise, promiseReject = Promise.reject;
  const internalErrorProto = typeof InternalError === "function" ? InternalError.prototype : null;
  const syntaxErrorProto = SyntaxError.prototype;
  let failure = "", callbacks = create(null), context;
  let queue = [], requestTimes = [], statusTimes = [], now = 0, nextId = 0;
  const pending = create(null);
  let pendingCount = 0, requesting = false;

  function fail(code) { if (!failure) failure = code; throw null; }
  function data(d) { return d && apply(hasOwn, d, ["value"]); }
  function append(array, value) { define(array, StringValue(array.length), { __proto__: null, value, writable: true, enumerable: true, configurable: true }); }
  function utf8(s) {
    if (s.length > ${SANDBOX_LIMITS.messageBytes}) fail("message_too_large");
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = apply(charCodeAt, s, [i]);
      if (c >= 0xd800 && c <= 0xdbff) {
        const d = apply(charCodeAt, s, [++i]);
        if (!(d >= 0xdc00 && d <= 0xdfff)) fail("invalid_data");
        n += 4;
      } else if (c >= 0xdc00 && c <= 0xdfff) fail("invalid_data");
      else n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
      if (n > ${SANDBOX_LIMITS.messageBytes}) fail("message_too_large");
    }
    return n;
  }
  function serialize(value) {
    let out = "", bytes = 0, nodes = 0, ancestors = [];
    function write(fragment) {
      bytes += utf8(fragment);
      if (bytes > ${SANDBOX_LIMITS.messageBytes}) fail("message_too_large");
      out += fragment;
    }
    function string(s) { utf8(s); write(stringify(s)); }
    function visit(v, depth) {
      if (++nodes > ${SANDBOX_LIMITS.dataNodes}) fail("node_limit");
      if (v === null) { write("null"); return; }
      const type = typeof v;
      if (type === "string") { string(v); return; }
      if (type === "boolean") { write(v ? "true" : "false"); return; }
      if (type === "number" && finite(v)) { write(StringValue(v)); return; }
      if (type !== "object") fail("invalid_data");
      if (depth > ${SANDBOX_LIMITS.dataDepth}) fail("nesting_too_deep");
      for (let i = 0; i < ancestors.length; i++) if (ancestors[i] === v) fail("invalid_data");
      const array = isArray(v), p = proto(v);
      if (array ? p !== arrayProto : p !== null && p !== objectProto) fail("invalid_data");
      // Never invoke toJSON, including one installed on a primordial prototype.
      if (descriptor(v, "toJSON") || (p && descriptor(p, "toJSON")) ||
          (array && descriptor(objectProto, "toJSON"))) fail("invalid_data");
      const keys = ownKeys(v);
      if (keys.length > ${SANDBOX_LIMITS.dataNodes}) fail("node_limit");
      append(ancestors, v);
      write(array ? "[" : "{");
      let count = 0;
      let length = 0;
      if (array) {
        const d = descriptor(v, "length");
        if (!data(d) || !finite(d.value) || d.value > ${SANDBOX_LIMITS.dataNodes}) fail("node_limit");
        length = d.value;
        if (keys.length !== length + 1) fail("invalid_data");
      }
      for (let i = 0; i < keys.length; i++) {
        const key = array ? StringValue(i) : keys[i];
        if (array && i === length) break;
        if (typeof key !== "string") fail("invalid_data");
        if (key === "__proto__" || key === "constructor" || key === "prototype") fail("unsafe_key");
        if (++nodes > ${SANDBOX_LIMITS.dataNodes}) fail("node_limit");
        const d = descriptor(v, key);
        if (!data(d) || !d.enumerable) fail("invalid_data");
        if (count++) write(",");
        if (!array) { string(key); write(":"); }
        visit(d.value, depth + 1);
      }
      write(array ? "]" : "}");
      ancestors.length--;
    }
    visit(value, 1);
    return out;
  }
  function trim(times) {
    let result = [];
    for (let i = 0; i < times.length; i++) if (now - times[i] < 1000) append(result, times[i]);
    return result;
  }
  function request(operation, payload) {
    if (failure) throw null;
    if (requesting) { failure = failure || "invalid_data"; throw null; }
    requesting = true;
    let registered = false, queued = false;
    try {
      requestTimes = trim(requestTimes);
      if (requestTimes.length >= ${SANDBOX_LIMITS.requestsPerSecond}) fail("bridge_rate_limit");
      append(requestTimes, now);
      if (queue.length >= ${SANDBOX_LIMITS.requestQueueSize} || pendingCount >= ${SANDBOX_LIMITS.requestQueueSize}) fail("bridge_queue_limit");
      const requestId = StringValue(++nextId);
      const json = serialize({ sdkApiVersion: 1, requestId, operation, payload });
      if (failure) throw null;
      if (!context.allowed[operation]) return apply(promiseReject, PromiseValue, ["capability-denied"]);
      if (operation === "status.set") {
        if (typeof payload.text !== "string" || utf8(payload.text) > ${SANDBOX_LIMITS.statusTextBytes}) fail("invalid_data");
        if (apply(regexExec, forbiddenText, [payload.text]) !== null) fail("invalid_data");
        statusTimes = trim(statusTimes);
        if (statusTimes.length >= ${SANDBOX_LIMITS.statusUpdatesPerSecond}) fail("status_rate_limit");
        append(statusTimes, now);
      }
      let resolve, reject;
      // The executor only captures native resolvers. Bookkeeping cannot throw
      // inside it and be silently converted into an already-rejected SDK promise.
      const result = new PromiseValue((yes, no) => { resolve = yes; reject = no; });
      if (typeof resolve !== "function" || typeof reject !== "function") fail("invalid_lifecycle");
      define(pending, requestId, { __proto__: null, value: { resolve, reject }, configurable: true });
      registered = true; pendingCount++;
      append(queue, json); queued = true;
      return result;
    } finally {
      if (registered && !queued) failure = failure || "invalid_data";
      requesting = false;
    }
  }
  function record(fields) {
    const r = create(null);
    for (let i = 0; i < fields.length; i += 2) define(r, fields[i], { __proto__: null, value: fields[i + 1], enumerable: true });
    return freeze(r);
  }
  let facade;
  return freeze({
    configure(json, capabilitiesJson) {
      const config = freeze(parse(json));
      const capabilities = parse(capabilitiesJson), allowed = create(null);
      for (let i = 0; i < capabilities.length; i++) define(allowed, capabilities[i], { __proto__: null, value: true });
      context = { allowed: freeze(allowed) };
      const seating = record(["claimSelfOnEntry", seatId => request("seating.claimSelfOnEntry", { seatId }),
        "cancelPendingOwnClaim", () => request("seating.cancelPendingOwnClaim", {})]);
      const status = record(["set", text => request("status.set", { text })]);
      facade = record(["config", config, "sdk", record(["seating", seating, "status", status])]);
    },
    bind(namespace) {
      if (typeof namespace !== "object" || namespace === null) fail("invalid_lifecycle");
      const names = ["init", "onEvent", "dispose"];
      for (let i = 0; i < names.length; i++) {
        const key = names[i];
        const d = descriptor(namespace, key);
        if (d && (!data(d) || typeof d.value !== "function")) fail("invalid_lifecycle");
        define(callbacks, key, { __proto__: null, value: d ? d.value : null });
      }
    },
    begin(timestamp) { now = timestamp; queue = []; },
    invoke(name, json) {
      const fn = callbacks[name];
      if (!fn) return undefined;
      return apply(fn, undefined, name === "onEvent" ? [freeze(parse(json)), facade] : [facade]);
    },
    validateReturn(value) {
      if (value !== undefined) { serialize(value); fail("invalid_lifecycle_result"); }
    },
    collect() { if (failure) throw null; const out = serialize(queue); queue = []; return out; },
    pending() { return pendingCount; },
    deliver(json) {
      const responses = parse(json), seen = create(null);
      if (!isArray(responses) || !responses.length || responses.length > ${SANDBOX_LIMITS.requestQueueSize}) fail("worker_protocol");
      // Resolve nothing until the entire host batch references distinct live
      // requests. No stale/unknown response can resume a different lifecycle.
      for (let i = 0; i < responses.length; i++) {
        const response = responses[i], id = response.requestId;
        if (typeof id !== "string" || !apply(hasOwn, pending, [id]) || apply(hasOwn, seen, [id])) fail("worker_protocol");
        define(seen, id, { __proto__: null, value: true });
      }
      for (let i = 0; i < responses.length; i++) {
        const response = responses[i], id = response.requestId, deferred = pending[id];
        delete pending[id]; pendingCount--;
        if (response.ok) deferred.resolve(response.result === null ? undefined : response.result);
        else deferred.reject(response.error);
      }
    },
    code() { return failure; },
    exceptionCode(value) {
      // No message/stack/name property reads, String(error), or guest toString.
      if (value !== null && typeof value === "object") {
        const p = proto(value);
        // JSON parser stack checks report SyntaxError in this pinned engine.
        if ((internalErrorProto && p === internalErrorProto) || p === syntaxErrorProto) {
          const d = descriptor(value, "message");
          if (data(d) && typeof d.value === "string" && d.value.length <= 80) {
            // These are untrusted bounded HINTS, never proven failure causes:
            // guest code can construct an InternalError with the same message.
            if (d.value === "out of memory") return "memory_exhausted";
            if (d.value === "stack overflow") return "stack_exhausted";
          }
        }
      }
      return "guest_exception";
    }
  });
})()`;
