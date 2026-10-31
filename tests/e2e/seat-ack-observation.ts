import type { Page } from "@playwright/test";

/** Bounded passive page-clock phases. Private correlation keys never leave this closure.
 * Install BEFORE routing/navigation: the native setter must precede Playwright's mock.
 * No CDP/Node clock is subtracted from these times; no timers/render work are changed. */
export async function installSeatAckObservation(page: Pick<Page, "addInitScript">) {
  await page.addInitScript(() => {
    const Native = window.WebSocket, add = EventTarget.prototype.addEventListener;
    const dispatch = EventTarget.prototype.dispatchEvent, nativeSend = Native.prototype.send;
    const onmessage = Object.getOwnPropertyDescriptor(Native.prototype, "onmessage");
    const scopes = new WeakMap<object, { generation: number; native: boolean }>();
    const attempts = new Map<string, { attempt: number; generation: number; nativeGeneration: number | null }>();
    const rows: Array<{ atMs: number; phase: string; attempt: number; generation: number; nativeGeneration: number | null; current: boolean }> = [];
    let appGeneration = 0, nativeGeneration = 0;
    const parse = (data: unknown) => {
      if (typeof data !== "string" || data.length > 262_144) return null;
      try { return JSON.parse(data); } catch { return null; }
    };
    const scope = (socket: WebSocket) => {
      let value = scopes.get(socket);
      if (!value) {
        if (!new URL(socket.url).searchParams.has("roomId")) return null;
        const native = Object.prototype.toString.call(socket) === "[object WebSocket]";
        value = { generation: native ? ++nativeGeneration : ++appGeneration, native };
        scopes.set(socket, value);
      }
      return value;
    };
    const mark = (phase: string, attempt: NonNullable<ReturnType<typeof attempts.get>>) => {
      if (rows.length < 96) rows.push({ atMs: performance.now(), phase, ...attempt,
        current: attempt.generation === appGeneration });
    };
    const outgoing = (socket: WebSocket, data: unknown, native: boolean) => {
      const message = parse(data), value = scope(socket);
      if (!value || !message) return;
      if (message.type === "seat_claim" && String(message.commandId).startsWith("plugin-seat:")) {
        let attempt = attempts.get(message.commandId);
        if (!attempt && attempts.size < 8) {
          // A native-only client has one connection, not a mock/native pair.
          if (native) appGeneration = Math.max(appGeneration, value.generation);
          attempt = { attempt: attempts.size + 1, generation: value.generation, nativeGeneration: native ? value.generation : null };
          attempts.set(message.commandId, attempt);
          mark("outgoing-claim", attempt);
        }
        if (attempt && native) { attempt.nativeGeneration = value.generation; mark("native-send", attempt); }
      }
      if (message.type === "seat_release" && String(message.commandId).startsWith("plugin-release:")) {
        const attempt = [...attempts.values()].at(-1);
        if (attempt) mark(native ? "native-release" : "outgoing-release", attempt);
      }
    };
    const incoming = (socket: WebSocket, event: Event, phase: string) => {
      const message = parse((event as MessageEvent).data);
      if (message?.type !== "seat_claim_result") return null;
      const attempt = attempts.get(message.seatClaimResult?.commandId), value = scope(socket);
      if (!attempt || !value) return null;
      if (value.native && attempt.nativeGeneration !== value.generation || !value.native && attempt.generation !== value.generation) return null;
      mark(phase, attempt); return attempt;
    };
    Native.prototype.send = function (data) { outgoing(this, data, true); return nativeSend.call(this, data); };
    if (onmessage?.set) Object.defineProperty(Native.prototype, "onmessage", { ...onmessage, set(listener) {
      const socket = this as WebSocket;
      return onmessage.set!.call(socket, typeof listener === "function" ? function (event: MessageEvent) {
        incoming(socket, event, "native-receive"); return listener.call(socket, event);
      } : listener);
    } });
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (type !== "message" || !listener || !(this instanceof Native) && Object.prototype.toString.call(this) !== "[object WebSocket]") {
        // Playwright's mock extends EventTarget rather than native WebSocket.
        if (type !== "message" || !listener || !(this as any).url || !(this as any).send) return add.call(this, type, listener, options);
      }
      const socket = this as WebSocket, value = scope(socket);
      if (!value) return add.call(this, type, listener, options);
      if (!value.native) {
        const send = socket.send;
        socket.send = function (data) { outgoing(socket, data, false); return send.call(socket, data); };
      }
      return add.call(socket, type, function (event) {
        const attempt = incoming(socket, event, value.native ? "native-app-delivery" : "app-delivery");
        try { return typeof listener === "function" ? listener.call(socket, event) : listener.handleEvent(event); }
        finally { if (attempt) mark("app-handler-return", attempt); }
      }, options);
    };
    EventTarget.prototype.dispatchEvent = function (event) {
      if ((this as any).url && (this as any).send) incoming(this as WebSocket, event, "mock-dispatch");
      return dispatch.call(this, event);
    };
    (window as any).__t16SeatAckFacts = () => ({ nativeSetterObserved: Boolean(onmessage?.set),
      appConnections: appGeneration, nativeConnections: nativeGeneration, rows: rows.map(row => ({ ...row })) });
  });
}
