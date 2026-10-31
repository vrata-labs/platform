import type { Page } from "@playwright/test";

/** Passive, bounded phases on the page clock. No request/transport routing and
 * no startup gate. Private URLs and kernel action IDs never leave the closure. */
export async function installSeatEntryObservation(page: Pick<Page, "addInitScript">) {
  await page.addInitScript(() => {
    const joinClicks: Array<{ atMs: number; trusted: boolean }> = [], admissionStarts: number[] = [];
    const discovery: Array<{ startMs: number; responseMs: number | null; status: number | null; url: string }> = [];
    const kernel: Array<{ phase: string; atMs: number; generation: number }> = [];
    const mark = (phase: string, generation: number) => { if (kernel.length < 32) kernel.push({ phase, atMs: performance.now(), generation }); };
    document.addEventListener("click", event => {
      if ((event.target as Element | null)?.closest?.("#guest-enter-without-audio") && joinClicks.length < 4) {
        joinClicks.push({ atMs: performance.now(), trusted: event.isTrusted });
      }
    }, true);
    const fetcher = window.fetch;
    window.fetch = function (...args) {
      const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]), location.href);
      if (url.pathname === "/api/tokens/state" && admissionStarts.length < 4) admissionStarts.push(performance.now());
      const row = /\/api\/rooms\/[^/]+\/plugins\/runtime$/.test(url.pathname) && discovery.length < 8
        ? { startMs: performance.now(), responseMs: null as number | null, status: null as number | null, url: url.href } : null;
      if (row) discovery.push(row);
      const loading = Reflect.apply(fetcher, this, args) as Promise<Response>;
      if (row) void loading.then(response => { row.responseMs = performance.now(); row.status = response.status; }, () => {});
      return loading;
    };
    if (window.Worker) {
      const Native = window.Worker;
      let generation = 0;
      window.Worker = class extends Native {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          if (options?.name !== "room-plugin-kernel") return;
          const own = ++generation, post = this.postMessage;
          let readyAction: number | null = null;
          mark("worker-created", own);
          this.postMessage = function (command: any, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
            if (command?.type === "prepare") mark("prepare-dispatch", own);
            if (command?.type === "init") mark("init-dispatch", own);
            if (command?.type === "event" && command.event?.type === "room.ready") {
              readyAction = command.id; mark("ready-kernel-dispatch", own);
            }
            return Reflect.apply(post, this, [command, transferOrOptions]);
          };
          this.addEventListener("message", event => {
            if (readyAction !== null && event.data?.type === "requests" && event.data.actionId === readyAction) {
              // A real handler has emitted a request; this is NOT its exact start
              // time and not lifecycle completion. No guest payload is retained.
              mark("ready-handler-request-received", own);
            }
          });
        }
      };
    }
    (window as any).__t16SeatEntryFacts = () => ({
      timeOriginMs: performance.timeOrigin, joinClicks: joinClicks.map(row => ({ ...row })), admissionStarts: [...admissionStarts],
      discovery: discovery.map(({ url, ...row }) => {
        const resource = (performance.getEntriesByName(url, "resource") as PerformanceResourceTiming[])
          .find(entry => row.responseMs !== null && entry.startTime >= row.startMs && entry.startTime <= row.responseMs && entry.responseEnd > 0);
        return { ...row, bodyEndMs: resource?.responseEnd ?? null };
      }), kernel: kernel.map(row => ({ ...row }))
    });
  });
}
