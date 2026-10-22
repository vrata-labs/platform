import type { createRoomPluginAuthorHttp, RoomPluginAuthorLibrary } from "./author-http.js";
import { RoomPluginAuthorError } from "./author-http.js";
import { planRoomPluginAuthorAction, roomPluginAuthorMessage, type RoomPluginAuthorIntent } from "./author-model.js";

export interface RoomPluginAuthorContext {
  /** Identity v2 room session whose current effective role may author; the server still decides. */
  eligible: boolean;
  online: boolean;
}
export interface RoomPluginAuthorState {
  phase: "hidden" | "loading" | "ready";
  library: RoomPluginAuthorLibrary | null;
  busy: "upload" | "write" | null;
  /** Writes are refused while offline or before the library for this session is loaded. */
  frozen: boolean;
  message: { kind: "info" | "error"; text: string } | null;
}
type Http = ReturnType<typeof createRoomPluginAuthorHttp>;
const OFFLINE = Object.freeze({ kind: "info" as const, text: "Offline: room behavior changes are paused until the connection returns." });

/** Author library owner. One write at a time. Hiding/stopping starts a new epoch;
 * every read is also bound to its own sequence, so late responses never repaint. */
export class RoomPluginAuthorSession {
  private epoch = 0;
  private readSequence = 0;
  private library: RoomPluginAuthorLibrary | null = null;
  private phase: RoomPluginAuthorState["phase"] = "hidden";
  private busy: RoomPluginAuthorState["busy"] = null;
  private message: RoomPluginAuthorState["message"] = null;
  private loading = false;
  private reloadQueued = false;
  private closed = false;
  private lastReadStartedAtMs = -Infinity;
  private lastReadFailed = false;
  /** The server refused this eligible session; retry only after eligibility changes. */
  private refused = false;

  constructor(private readonly input: {
    http: Http;
    clock?: () => number;
    context(): RoomPluginAuthorContext;
    render(state: RoomPluginAuthorState): void;
    /** A successful write: the room runtime should revalidate its own lease now. */
    changed(): void;
  }) {}

  state(): RoomPluginAuthorState {
    const context = this.safeContext();
    return { phase: this.phase, library: this.library, busy: this.busy, message: this.message,
      frozen: !context.online || this.phase !== "ready" || this.library === null };
  }

  /** Idempotent: called on every authority render. Reads only when the panel
   * becomes eligible or the connection returns. */
  sync(): void {
    if (this.closed) return;
    const context = this.safeContext();
    if (!context.eligible) { this.refused = false; if (this.phase !== "hidden" || this.message) this.hide(); return; }
    if (this.refused) return;
    if (!context.online) { if (this.message !== OFFLINE) { this.message = OFFLINE; this.render(); } return; }
    const returned = this.message === OFFLINE;
    if (returned) this.message = null;
    if (returned || this.phase === "hidden") void this.reload();
  }
  /** Session-control hint. After a failed read, retries are spaced by at least 5 s. */
  observeRevision(revision: unknown): void {
    if (this.closed || this.phase === "hidden" || this.busy || typeof revision !== "number") return;
    if (this.loading) { this.reloadQueued = true; return; }
    if (this.library && !this.lastReadFailed && revision === this.library.revision) return;
    if ((this.lastReadFailed || !this.library) && this.now() - this.lastReadStartedAtMs < 5000) return;
    void this.reload();
  }
  stop(): void {
    if (this.closed) return;
    this.epoch++; this.library = null; this.phase = "hidden"; this.busy = null; this.message = null;
    this.render(); this.closed = true;
  }

  async upload(bytes: Uint8Array): Promise<void> {
    await this.write("upload", "Package uploaded. Review its permissions before enabling it.", () => this.input.http.upload(bytes));
  }
  async apply(intent: RoomPluginAuthorIntent): Promise<void> {
    const library = this.library;
    if (!library) return;
    const plan = planRoomPluginAuthorAction(library, intent);
    if (!plan.ok) {
      this.message = { kind: "error", text: roomPluginAuthorMessage(plan.reason) }; this.render();
      if (plan.reason === "stale") void this.reload(true);
      return;
    }
    const done = intent.type === "enable" ? "Behavior enabled for this room." : intent.type === "disable" ? "Behavior disabled. Seated people keep their seats."
      : intent.type === "unbind" ? "Behavior removed from this room." : "Package version deleted.";
    await this.write("write", done, async () => {
      if (plan.operation === "bind") await this.input.http.bind(plan.pluginId, plan.expectedRevision, plan.write, plan.approval);
      else if (plan.operation === "unbind") await this.input.http.unbind(plan.pluginId, plan.expectedRevision);
      else await this.input.http.remove(plan.packageId);
    });
  }

  private async write(kind: "upload" | "write", success: string, operation: () => Promise<unknown>): Promise<void> {
    if (this.closed || this.busy || this.state().frozen) return;
    const epoch = this.epoch;
    this.busy = kind; this.message = null; this.render();
    let refresh = false;
    try {
      await operation();
      if (this.closed || epoch !== this.epoch) return;
      this.message = { kind: "info", text: success }; refresh = true;
      try { this.input.changed(); } catch { /* The runtime controller owns its own recovery. */ }
    } catch (error) {
      if (this.closed || epoch !== this.epoch) return;
      const failure = error instanceof RoomPluginAuthorError ? error.failure : "unavailable";
      this.message = { kind: "error", text: roomPluginAuthorMessage(failure) };
      // An unknown outcome or concurrent change must be re-read, never retried blindly.
      refresh = failure !== "too-large" && failure !== "invalid-package";
      if (failure === "forbidden" || failure === "unsupported") { this.refused = true; this.hide(this.message); return; }
    } finally {
      if (epoch === this.epoch) { this.busy = null; this.render(); }
    }
    if (refresh) await this.reload(true);
  }

  private async reload(keepMessage = false): Promise<void> {
    if (this.closed) return;
    if (this.loading) { this.reloadQueued = true; return; }
    const context = this.safeContext();
    if (!context.eligible || !context.online) return;
    const epoch = this.epoch, sequence = ++this.readSequence;
    const current = () => !this.closed && epoch === this.epoch && sequence === this.readSequence;
    this.loading = true; this.lastReadStartedAtMs = this.now();
    if (this.phase === "hidden") { this.phase = "loading"; this.render(); }
    try {
      const library = await this.input.http.library();
      if (!current()) return;
      this.library = library; this.phase = "ready"; this.lastReadFailed = false;
      if (!keepMessage && this.message?.kind === "error") this.message = null;
    } catch (error) {
      if (!current()) return;
      const failure = error instanceof RoomPluginAuthorError ? error.failure : "unavailable";
      this.lastReadFailed = true;
      // Floor-1 servers and non-authors simply do not show the panel.
      if (failure === "forbidden" || failure === "unsupported") { this.refused = true; this.hide(); return; }
      this.message = { kind: "error", text: roomPluginAuthorMessage(failure) };
      if (this.phase === "loading") this.phase = this.library ? "ready" : "loading";
    } finally {
      this.loading = false;
      if (current()) this.render();
      if (this.reloadQueued && !this.closed) { this.reloadQueued = false; void this.reload(true); }
    }
  }
  private hide(message: RoomPluginAuthorState["message"] = null): void {
    this.epoch++; this.library = null; this.phase = "hidden"; this.busy = null; this.message = message; this.render();
  }
  private now(): number { return (this.input.clock ?? (() => performance.now()))(); }
  private safeContext(): RoomPluginAuthorContext {
    try { return this.input.context(); } catch { return { eligible: false, online: false }; }
  }
  private render(): void {
    try { this.input.render(this.state()); } catch { /* View failures must not affect the room. */ }
  }
}
