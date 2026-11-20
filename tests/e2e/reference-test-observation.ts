import type { Page, WebSocket } from "@playwright/test";

type Phase = "room-state" | "occupied-ray" | "visual-capture";
type Timing = { phase: Phase; startedAtMs: number; elapsedMs: number; status: "pending" | "returned" | "rejected" };

/** Finite, passive diagnostics: no renderer polling, frame changes, URL or payload storage. */
export function observeReferenceTest(page: Pick<Page, "on" | "off">, now = () => performance.now()) {
  const origin = now();
  const timings: Timing[] = [];
  const sockets: Array<{ event: "created" | "closed" | "error"; atMs: number }> = [];
  const cleanup: Array<() => void> = [];
  let stopped = false, observedSockets = 0;
  const socket = (value: WebSocket) => {
    if (stopped || observedSockets >= 32) return;
    try {
      const url = new URL(value.url());
      if (!url.searchParams.has("roomId") || !url.searchParams.has("participantId")) return;
    } catch { return; }
    observedSockets++;
    const mark = (event: "created" | "closed" | "error") => {
      if (!stopped && sockets.length < 48) sockets.push({ event, atMs: now() - origin });
    };
    const closed = () => mark("closed"), error = () => mark("error");
    mark("created");
    value.on("close", closed); value.on("socketerror", error);
    cleanup.push(() => { value.off("close", closed); value.off("socketerror", error); });
  };
  page.on("websocket", socket);
  return {
    async measure<T>(phase: Phase, action: () => Promise<T>): Promise<T> {
      const started = now();
      const row: Timing = { phase, startedAtMs: started - origin, elapsedMs: 0, status: "pending" };
      timings.push(row); if (timings.length > 48) timings.shift();
      try { const result = await action(); row.status = "returned"; return result; }
      catch (error) { row.status = "rejected"; throw error; }
      finally { row.elapsedMs = Math.max(0, now() - started); }
    },
    snapshot() {
      return { timings: timings.map(row => ({ ...row, elapsedMs: row.status === "pending"
        ? Math.max(0, now() - origin - row.startedAtMs) : row.elapsedMs })), sockets: sockets.map(row => ({ ...row })) };
    },
    stop() {
      stopped = true; page.off("websocket", socket);
      for (const close of cleanup) close();
      cleanup.length = 0;
    }
  };
}
