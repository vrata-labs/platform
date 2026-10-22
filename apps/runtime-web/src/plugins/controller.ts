import { validateRoomPluginConfig, type RoomPluginArtifact, type RoomPluginCapability, type RoomPluginConfig, type RoomPluginEvent,
  type RoomPluginRoomSnapshot } from "@vrata/room-plugin-sdk";
import type { IdentityRequirementReason } from "@vrata/shared-types";
import { createRoomPluginHttp, RoomPluginHttpError } from "./http.js";
import { verifyRoomPluginArtifact } from "./artifact-verify.js";
import { RoomPluginBindingLease } from "./lease.js";
import { createRoomPluginBroker, type RoomPluginSeatingPort } from "./broker.js";
import { RoomPluginRuntimeError, type RoomPluginRuntimeFailure } from "./runtime-errors.js";
import { SandboxError, type SandboxFailure, type SandboxHostPhase, type SandboxStartupTiming } from "./limits.js";
import type { RoomPluginRuntimeBinding } from "./runtime-dto.js";
import type { RoomPluginTokenProof } from "./token-bound.js";
import type { RoomPluginStatusRow } from "./status-view.js";
import type { SessionControlPollerTimers } from "../session-control-poller.js";

export interface RoomPluginInstance {
  readonly state: string; readonly busy: boolean; readonly failure?: SandboxFailure;
  readonly startupTiming?: SandboxStartupTiming;
  event(event: RoomPluginEvent): Promise<unknown>; dispose(): Promise<unknown>; terminate(): void;
}
/** Platform seating facts for plugins; absent in runtimes without the adapter. */
export interface RoomPluginSeatingHost {
  /** The room-state server correlates claims; otherwise seating capabilities stay denied. */
  supported(): boolean;
  /** Authenticated room, scene anchors, spawn and the first authoritative occupancy are all in place. */
  ready(): boolean;
  /** Called right before room.ready reaches a seating-capable instance: the arrival window may start. */
  activate(): void;
  snapshot(owner: string, seating: boolean): RoomPluginRoomSnapshot;
  port(owner: string): RoomPluginSeatingPort;
  retire(owner: string): void;
}
export interface RoomPluginCoreContext {
  active: boolean; ready: boolean; online: boolean; visible: boolean;
  connection: "connected" | "reconnecting" | "disconnected";
}
interface Entry {
  binding: RoomPluginRuntimeBinding; key: string; generation: number;
  state: RoomPluginStatusRow["state"]; name: string | null; text: string;
  abort: AbortController; instance?: RoomPluginInstance; starting: boolean; starts: number[];
  connection?: RoomPluginCoreContext["connection"];
  readySent?: boolean;
}
const seatingCapable = (binding: RoomPluginRuntimeBinding) => binding.approvedCapabilities.some(capability => capability.startsWith("seating."));
const ownerOf = (entry: Entry) => `${entry.binding.bindingId}:${entry.generation}`;
const key = (binding: RoomPluginRuntimeBinding) => JSON.stringify([binding.bindingId, binding.generation, binding.bindingRevision, binding.artifactSha256]);
type Failure = RoomPluginRuntimeFailure | SandboxFailure;

/** Native room owner. No await from this controller belongs in room boot, a
 * frame, or a room-state callback. Only its bounded status broker commits effects. */
export class RoomPluginController {
  private readonly lease: RoomPluginBindingLease;
  private readonly http: ReturnType<typeof createRoomPluginHttp>;
  private readonly timers: SessionControlPollerTimers;
  private readonly clock: () => number;
  private entries = new Map<string, Entry>();
  private cache = new Map<string, RoomPluginArtifact>();
  private epoch = 0;
  private active = false;
  private timer: unknown;
  private expiryTimer: unknown;
  private request?: { epoch: number; abort: AbortController };
  private nextRefreshAtMs = 0;
  private hintNotBeforeMs = -Infinity;
  private deniedToken: string | null = null;
  private state: "off" | "unsupported" | "empty" | "running" | "suspended" | "failed" = "off";
  private lastFailure: Failure | null = null;
  private lastHostPhase: SandboxHostPhase | null = null;
  private lastInstanceFailure: Failure | null = null;
  private startupTiming: SandboxStartupTiming | null = null;
  private hostFailed = false;
  private renderFailed = false;
  private frameworkFailed = false;
  private failedEntries = new Map<string, { key: string; code: Failure }>();
  private seatingTimer: unknown;
  // The trusted QuickJS module can miss its load deadline on a busy device; it gets one more
  // attempt (reusing the running compile) before plugins are stopped for this page.
  private wasmLoadRetries = 0;

  constructor(private readonly input: {
    apiBaseUrl: string; roomId: string;
    context(): RoomPluginCoreContext;
    proof(): RoomPluginTokenProof | null;
    start(source: string, config: RoomPluginConfig, approved: readonly RoomPluginCapability[],
      dispatch: ReturnType<typeof createRoomPluginBroker>, signal: AbortSignal): Promise<RoomPluginInstance>;
    render(rows: readonly RoomPluginStatusRow[]): void;
    identityRequired?(reason: IdentityRequirementReason): void;
    seating?: RoomPluginSeatingHost;
    clock?: () => number; timers?: SessionControlPollerTimers;
    http?: ReturnType<typeof createRoomPluginHttp>;
  }) {
    this.clock = input.clock ?? (() => performance.now());
    this.lease = new RoomPluginBindingLease(this.clock);
    this.http = input.http ?? createRoomPluginHttp(input);
    this.timers = input.timers ?? { schedule: (callback, ms) => setTimeout(callback, ms), cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  }

  start(protocol: 2 | null): void {
    this.stop();
    if (protocol !== 2) { this.state = "unsupported"; return; }
    if (this.frameworkFailed || this.renderFailed) { this.state = "failed"; return; }
    this.active = true; this.state = "empty"; this.kick();
  }
  stop(): void {
    this.active = false; this.epoch++; this.request?.abort.abort(); this.request = undefined;
    if (this.timer !== undefined) this.timers.cancel(this.timer);
    if (this.expiryTimer !== undefined) this.timers.cancel(this.expiryTimer);
    if (this.seatingTimer !== undefined) this.timers.cancel(this.seatingTimer);
    this.timer = this.expiryTimer = this.seatingTimer = undefined; this.lease.resetSession();
    for (const entry of this.entries.values()) this.retire(entry);
    this.entries.clear(); this.cache.clear(); this.deniedToken = null; this.state = "off"; this.render();
  }
  availabilityChanged(): void {
    if (!this.active) return;
    try {
      const context = this.input.context();
      if (!context.active) { this.stop(); return; }
      this.epoch++; this.request?.abort.abort(); this.request = undefined; this.lease.invalidate(); this.pauseEntries();
      this.state = "suspended"; this.render(); this.kick();
    } catch { this.failFramework("host-unavailable"); }
  }
  connectionChanged(): void {
    if (!this.active) return;
    try { for (const entry of this.entries.values()) this.notifyConnection(entry); }
    catch { this.failFramework("host-unavailable"); }
  }
  kick(): void {
    if (this.timer !== undefined) this.timers.cancel(this.timer); this.timer = undefined;
    if (this.active) void this.refresh().catch(() => this.failFramework("host-unavailable"));
  }
  /** Occupancy, anchors or readiness changed. room.ready is sent once per instance; later
   * changes reach seating-capable instances as coalesced snapshots. */
  seatingChanged(): void {
    if (!this.active || this.seatingTimer !== undefined) return;
    this.seatingTimer = this.timers.schedule(() => {
      this.seatingTimer = undefined;
      try { for (const entry of this.entries.values()) this.notifySeating(entry, true); }
      catch { this.failFramework("host-unavailable"); }
    }, 100);
  }
  /** Session-control change hint. It only brings the bounded refresh forward;
   * authority still comes from the runtime snapshot and its lease. */
  observeRevisionHint(value: unknown): void {
    if (!this.active || this.request || typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return;
    const now = this.clock();
    if (value === this.lease.diagnostics().revision || now < this.hintNotBeforeMs) return;
    this.hintNotBeforeMs = now + 500; this.kick();
  }
  diagnostics() {
    return { state: this.state, revision: this.lease.diagnostics().revision, fetchPending: Boolean(this.request),
      instances: this.entries.size, running: [...this.entries.values()].filter(entry => entry.state === "running").length,
      failed: [...this.entries.values()].filter(entry => entry.state === "failed").length,
      remainingLeaseMs: this.lease.diagnostics().remainingMs, lastFailure: this.lastFailure, lastInstanceFailure: this.lastInstanceFailure,
      lastHostPhase: this.lastHostPhase, hostFailed: this.hostFailed, startupTiming: this.startupTiming };
  }

  private available(): boolean {
    const context = this.input.context();
    return this.active && context.active && context.ready && context.online && context.visible && Boolean(this.input.proof());
  }
  private schedule(): void {
    if (!this.active || this.timer !== undefined) return;
    this.timer = this.timers.schedule(() => { this.timer = undefined; this.kick(); }, Math.max(0, this.nextRefreshAtMs - this.clock()));
  }
  private scheduleExpiry(): void {
    if (this.expiryTimer !== undefined) this.timers.cancel(this.expiryTimer);
    const remaining = this.lease.diagnostics().remainingMs;
    if (!remaining) { this.expiryTimer = undefined; return; }
    this.expiryTimer = this.timers.schedule(() => {
      this.expiryTimer = undefined;
      if (!this.active) return;
      if (this.lease.diagnostics().remainingMs > 0) { this.scheduleExpiry(); return; }
      this.pauseEntries(); this.state = "suspended"; this.render();
    }, remaining);
  }

  private async refresh(): Promise<void> {
    if (!this.active || this.request) return;
    this.nextRefreshAtMs = this.clock() + 2000;
    try {
      const context = this.input.context();
      if (!context.active) { this.stop(); return; }
      const proof = this.input.proof();
      if (!context.online || !context.visible || !proof || proof.token === this.deniedToken) {
        this.lease.invalidate(); this.pauseEntries(); this.state = "suspended"; this.render(); return;
      }
      const ticket = this.lease.beginRequest(proof); if (!ticket) return;
      const request = { epoch: this.epoch, abort: new AbortController() }; this.request = request;
      try {
        const snapshot = await this.http.snapshot(proof, request.abort.signal);
        if (!this.active || request.epoch !== this.epoch || request.abort.signal.aborted) return;
        const before = this.lease.diagnostics().epoch;
        if (!this.lease.accept(ticket, snapshot)) {
          if (this.lease.diagnostics().epoch !== before) this.failFramework("invalid-runtime-config");
          else { this.pauseEntries(); this.state = "suspended"; this.render(); }
          return;
        }
        this.deniedToken = null;
        const next = new Map(snapshot.bindings.map(binding => [binding.bindingId, binding]));
        for (const id of this.failedEntries.keys()) if (!next.has(id)) this.failedEntries.delete(id);
        for (const [id, entry] of this.entries) {
          const binding = next.get(id);
          if (!binding || key(binding) !== entry.key) { this.entries.delete(id); this.retire(entry); }
        }
        for (const binding of snapshot.bindings) {
          let entry = this.entries.get(binding.bindingId);
          if (!entry) {
            const failed = this.failedEntries.get(binding.bindingId);
            entry = { binding, key: key(binding), generation: 0, state: failed?.key === key(binding) || this.hostFailed ? "failed" : "loading",
              name: null, text: "", abort: new AbortController(), starting: false, starts: [] };
            if (failed && failed.key !== entry.key) this.failedEntries.delete(binding.bindingId);
            this.entries.set(binding.bindingId, entry);
          }
          entry.binding = binding;
          if (!this.available()) continue;
          if (entry.state === "failed") continue;
          if (entry.instance && (entry.instance.state === "failed" || entry.instance.state === "disposed")) {
            this.failEntry(entry, entry.instance.failure ?? "instance_closed"); continue;
          }
          if (entry.instance && entry.instance.state === "ready") { entry.state = "running"; this.notifyConnection(entry); }
          else if (!entry.starting && !this.hostFailed) void this.startEntry(entry).catch(() => this.failEntry(entry!, "host-unavailable"));
        }
        if (!this.hostFailed && [...this.entries.values()].every(entry => entry.state !== "failed")) this.lastFailure = null;
        this.state = this.entries.size ? "running" : "empty"; this.scheduleExpiry(); this.render();
      } catch (error) {
        if (!this.active || request.epoch !== this.epoch || request.abort.signal.aborted) return;
        if (error instanceof RoomPluginHttpError && error.disposition === "unsupported") { this.stop(); this.state = "unsupported"; return; }
        if (error instanceof RoomPluginRuntimeError && error.code === "invalid-runtime-config") { this.failFramework(error.code); return; }
        if (error instanceof RoomPluginHttpError && error.disposition === "unavailable" && this.lease.diagnostics().remainingMs > 0) {
          // A missed refresh never renews authority, but it also is not proof of
          // revocation. Existing permits still expire at their original deadline.
          this.lastFailure = "network-unavailable"; return;
        }
        this.lease.invalidate(); this.pauseEntries(); this.state = "suspended"; this.lastFailure = "network-unavailable"; this.render();
        if (error instanceof RoomPluginHttpError && error.disposition === "denied" && this.input.proof()?.token === proof.token) {
          this.deniedToken = proof.token;
          if (error.identityReason) { try { this.input.identityRequired?.(error.identityReason); } catch { /* Core gate owns its own failure recovery. */ } }
        }
      } finally {
        request.abort.abort(); if (this.request === request) this.request = undefined;
      }
    } finally { this.schedule(); }
  }

  private async startEntry(entry: Entry): Promise<void> {
    const now = this.clock(); entry.starts = entry.starts.filter(time => now - time < 600_000);
    if (entry.starts.length >= 3) { this.failEntry(entry, "host-unavailable"); return; }
    entry.starts.push(now); entry.starting = true; entry.state = "loading"; entry.abort = new AbortController();
    const generation = ++entry.generation, signal = entry.abort.signal;
    entry.readySent = false;
    const current = () => this.active && this.entries.get(entry.binding.bindingId) === entry && entry.generation === generation && !signal.aborted;
    try {
      let artifact = this.cache.get(entry.binding.artifactSha256), config: RoomPluginConfig;
      if (artifact) {
        if (artifact.manifest.id !== entry.binding.pluginId || artifact.manifest.version !== entry.binding.version
          || entry.binding.approvedCapabilities.some(capability => !artifact!.manifest.requestedCapabilities.includes(capability))) throw new RoomPluginRuntimeError("invalid-artifact");
        try { config = validateRoomPluginConfig(artifact.manifest.configSchema, entry.binding.config); }
        catch { throw new RoomPluginRuntimeError("invalid-artifact"); }
      } else {
        const proof = this.input.proof(); if (!proof) throw new RoomPluginRuntimeError("lease-expired");
        const checked = await verifyRoomPluginArtifact(await this.http.content(entry.binding, proof, signal), entry.binding);
        if (!current()) return;
        artifact = checked.artifact; config = checked.config;
        if (this.cache.size >= 2) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(entry.binding.artifactSha256, artifact);
      }
      if (!current() || !this.available() || !this.lease.permit(entry.binding)) return;
      entry.name = artifact.manifest.displayName;
      const dispatch = createRoomPluginBroker({ binding: entry.binding, lease: this.lease, clock: this.clock,
        currentBinding: () => current() && (entry.state === "loading" || entry.state === "running") ? entry.binding : null,
        available: () => current() && this.available(), proof: this.input.proof,
        seating: seatingCapable(entry.binding) && this.input.seating?.supported() ? this.input.seating.port(ownerOf(entry)) : null,
        status: text => { entry.text = text; if (!this.render()) throw new RoomPluginRuntimeError("host-unavailable"); } });
      const instance = await this.input.start(artifact.entry, config, entry.binding.approvedCapabilities, dispatch, signal);
      if (!current() || !this.available() || !this.lease.permit(entry.binding)) { instance.terminate(); return; }
      this.startupTiming = instance.startupTiming ? { ...instance.startupTiming } : null;
      entry.instance = instance; entry.state = "running"; this.notifyConnection(entry); this.notifySeating(entry, false); this.render();
    } catch (error) {
      if (!current()) return;
      if (error instanceof RoomPluginHttpError || error instanceof RoomPluginRuntimeError && error.code === "lease-expired") {
        entry.state = "suspended"; entry.abort.abort(); this.render();
      } else {
        const code: Failure = error instanceof SandboxError ? error.code : error instanceof RoomPluginRuntimeError ? error.code : "host-unavailable";
        if (error instanceof SandboxError) this.lastHostPhase = error.hostPhase ?? null;
        if (error instanceof SandboxError || error instanceof RoomPluginRuntimeError) this.startupTiming = error.startupTiming ? { ...error.startupTiming } : null;
        if (code === "wasm_load_failed" && this.wasmLoadRetries < 1) {
          this.wasmLoadRetries++; this.lastInstanceFailure = code;
          // No guest code ran. The next bounded refresh starts this entry again.
          entry.state = "loading"; entry.abort.abort(); this.render(); return;
        }
        if (["wasm_load_failed", "worker_boot_timeout", "host-unavailable", "kernel-transport-timeout", "kernel-unsupported", "kernel-protocol"].includes(code)) this.hostFailed = true;
        this.failEntry(entry, code);
      }
    } finally { if (entry.generation === generation) entry.starting = false; }
  }

  private notifyConnection(entry: Entry): void {
    if (!this.available() || entry.state !== "running" || !entry.instance) return;
    const state = this.input.context().connection;
    if (entry.connection === state) return;
    entry.connection = state;
    const generation = entry.generation;
    void entry.instance.event({ sdkApiVersion: 1, type: "room.connection", state }).catch(error => {
      if (this.entries.get(entry.binding.bindingId) !== entry || generation !== entry.generation || entry.state === "suspended") return;
      this.failEntry(entry, error instanceof SandboxError ? error.code : "host-unavailable");
    });
  }
  private notifySeating(entry: Entry, changed: boolean): void {
    const seating = this.input.seating;
    if (!seating || !this.available() || entry.state !== "running" || !entry.instance) return;
    let event: RoomPluginEvent;
    if (!entry.readySent) {
      if (!seating.ready()) return;
      entry.readySent = true;
      if (seatingCapable(entry.binding) && seating.supported()) seating.activate();
      event = { sdkApiVersion: 1, type: "room.ready", snapshot: seating.snapshot(ownerOf(entry), seatingCapable(entry.binding)) };
    } else if (changed && seatingCapable(entry.binding)) {
      event = { sdkApiVersion: 1, type: "seating.snapshot", snapshot: seating.snapshot(ownerOf(entry), true) };
    } else return;
    const generation = entry.generation;
    void entry.instance.event(event).catch(error => {
      if (this.entries.get(entry.binding.bindingId) !== entry || generation !== entry.generation || entry.state === "suspended") return;
      this.failEntry(entry, error instanceof SandboxError ? error.code : "host-unavailable");
    });
  }
  private pauseEntries(): void {
    for (const entry of this.entries.values()) {
      if (entry.state === "failed") continue;
      if (!entry.instance || entry.instance.busy || entry.instance.state !== "ready") {
        this.retireSeating(entry);
        entry.generation++; entry.abort.abort(); entry.instance?.terminate(); entry.instance = undefined; entry.starting = false;
      }
      entry.state = "suspended";
    }
  }
  private retire(entry: Entry): void {
    this.retireSeating(entry);
    entry.generation++; entry.abort.abort(); const instance = entry.instance; entry.instance = undefined;
    if (!instance) return;
    // Native effects are fenced before guest disposal; busy lifecycles cannot
    // receive a new command. The supervisor owns the finite cleanup deadline.
    if (instance.state === "ready" && !instance.busy) void instance.dispose().catch(() => instance.terminate());
    else instance.terminate();
  }
  /** A pending automatic claim of a retired instance is cancelled; a confirmed seat stays the user's. */
  private retireSeating(entry: Entry): void {
    try { this.input.seating?.retire(ownerOf(entry)); } catch { /* The core seat barrier owns recovery. */ }
  }
  private failEntry(entry: Entry, code: Failure): void {
    this.retireSeating(entry);
    entry.state = "failed"; entry.abort.abort(); entry.instance?.terminate(); entry.instance = undefined; entry.starting = false;
    if (this.entries.get(entry.binding.bindingId) === entry) this.failedEntries.set(entry.binding.bindingId, { key: entry.key, code });
    this.lastFailure = code; this.lastInstanceFailure = code; this.render();
  }
  private seatingSupported(): boolean {
    try { return this.input.seating?.supported() === true; } catch { return false; }
  }
  private failFramework(code: Failure): void {
    this.frameworkFailed = true; this.stop(); this.state = "failed"; this.lastFailure = code;
    if (!this.renderFailed) this.render();
  }
  private render(): boolean {
    if (this.renderFailed) return false;
    try {
      const rows = [...this.entries.values()].map(entry => ({ name: entry.name,
        state: entry.state === "loading" && entry.text ? "running" as const : entry.state, text: entry.text,
        seatingUnavailable: seatingCapable(entry.binding) && !this.seatingSupported(),
        seatingOffered: seatingCapable(entry.binding) && this.seatingSupported() && (entry.state === "running" || entry.state === "loading") }));
      if (this.state === "failed" && !rows.length) rows.push({ name: null, state: "failed", text: "", seatingUnavailable: false, seatingOffered: false });
      this.input.render(rows); return true;
    } catch {
      this.renderFailed = true; this.failFramework("host-unavailable"); return false;
    }
  }
}
