import {
  isRemoteBrowserLeaseDuration, REMOTE_BROWSER_PUBLIC_HTTPS_MAX_LEASE_MS, sameRemoteBrowserPublicHttpsBinding,
  type RemoteBrowserPublicHttpsBinding
} from "@vrata/shared-types";

const renewIntervalMs = 2500;

export interface PublicHttpsLeaseClock {
  now(): number;
  schedule(delayMs: number, callback: () => void): () => void;
}

const monotonicClock: PublicHttpsLeaseClock = {
  now: () => performance.now(),
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  }
};

export interface PublicHttpsLeaseConsumer {
  /** Starts closed. Enforce this monotonic deadline locally, including on existing connections/streams. */
  setDeadline(deadlineMs: number): void;
  /** Permanently close this binding, synchronously and without consulting Chromium. */
  revoke(): void;
}

export interface PublicHttpsRuntime {
  /** Prepare isolated resources with both gates closed. This must not navigate or publish. */
  prepare(binding: RemoteBrowserPublicHttpsBinding): {
    gateway: PublicHttpsLeaseConsumer;
    publisher: PublicHttpsLeaseConsumer;
    /** Abort after revocation even if browser startup/navigation has yet to finish. */
    open(url: string, signal: AbortSignal): Promise<void>;
  };
}

type Authorization =
  | { status: "allowed"; validForMs: number; url?: string }
  | { status: "denied" | "unavailable" };
type StopReason = "revoked" | "expired" | "manual" | "failed";

interface Entry {
  binding: RemoteBrowserPublicHttpsBinding;
  controller: AbortController;
  grantDeadline: number;
  sessionDeadline: number;
  cancelExpiry?: () => void;
  cancelRenew?: () => void;
  resources?: ReturnType<PublicHttpsRuntime["prepare"]>;
  started: Promise<boolean>;
}

export class PublicHttpsSessions {
  private readonly sessions = new Map<string, Entry>();

  constructor(private readonly options: {
    runtime: PublicHttpsRuntime;
    authorize(binding: RemoteBrowserPublicHttpsBinding, purpose: "start" | "renew", signal: AbortSignal): Promise<Authorization>;
    onStop(binding: RemoteBrowserPublicHttpsBinding, reason: StopReason): void;
    retirePredecessor?(binding: RemoteBrowserPublicHttpsBinding): Promise<void>;
    clock?: PublicHttpsLeaseClock;
  }) {}

  private get clock(): PublicHttpsLeaseClock { return this.options.clock ?? monotonicClock; }
  get size(): number { return this.sessions.size; }
  has(sessionId: string): boolean { return this.sessions.has(sessionId); }

  start(binding: RemoteBrowserPublicHttpsBinding, ttlMs: number): Promise<boolean> {
    const existing = this.sessions.get(binding.sessionId);
    if (existing) {
      if (!this.isLive(existing)) return Promise.resolve(false);
      return sameRemoteBrowserPublicHttpsBinding(existing.binding, binding) ? existing.started : Promise.resolve(false);
    }
    const startedAt = this.clock.now();
    const controller = new AbortController();
    const entry: Entry = {
      binding, controller,
      grantDeadline: startedAt + REMOTE_BROWSER_PUBLIC_HTTPS_MAX_LEASE_MS,
      sessionDeadline: startedAt + ttlMs,
      started: Promise.resolve().then(() => this.confirm(entry, "start", startedAt))
    };
    this.sessions.set(binding.sessionId, entry);
    this.scheduleExpiry(entry);
    return entry.started;
  }

  stop(binding: RemoteBrowserPublicHttpsBinding): boolean {
    const current = this.sessions.get(binding.sessionId);
    return Boolean(current && sameRemoteBrowserPublicHttpsBinding(current.binding, binding) && this.retire(current, "manual"));
  }

  close(): void {
    for (const entry of this.sessions.values()) this.retire(entry, "manual");
  }

  private isLive(entry: Entry): boolean {
    if (this.sessions.get(entry.binding.sessionId) !== entry) return false;
    if (this.clock.now() < Math.min(entry.grantDeadline, entry.sessionDeadline)) return true;
    this.retire(entry, "expired");
    return false;
  }

  private scheduleExpiry(entry: Entry): void {
    entry.cancelExpiry?.();
    entry.cancelExpiry = this.clock.schedule(Math.max(0, Math.min(entry.grantDeadline, entry.sessionDeadline) - this.clock.now()), () => {
      // Node truncates fractional delays; schedule the remainder if a timer fired just before the deadline.
      if (this.isLive(entry)) this.scheduleExpiry(entry);
    });
  }

  private scheduleRenew(entry: Entry): void {
    entry.cancelRenew = this.clock.schedule(renewIntervalMs, () => { void this.confirm(entry, "renew", this.clock.now()); });
  }

  private async untilStopped<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T | undefined> {
    if (signal.aborted) return undefined;
    let cancelWait = () => {};
    return Promise.race([
      Promise.resolve().then(operation),
      new Promise<undefined>(resolve => {
        const abort = () => resolve(undefined);
        signal.addEventListener("abort", abort, { once: true });
        cancelWait = () => signal.removeEventListener("abort", abort);
      })
    ]).finally(() => cancelWait());
  }

  private async confirm(entry: Entry, purpose: "start" | "renew", requestedAt: number): Promise<boolean> {
    if (!this.isLive(entry)) return false;
    const signal = entry.controller.signal;
    const authorization = await this.untilStopped(signal, () => this.options.authorize(entry.binding, purpose, signal))
      .catch((): Authorization => ({ status: "unavailable" }));
    if (!this.isLive(entry)) return false;
    if (authorization?.status === "unavailable" && purpose === "renew") {
      this.scheduleRenew(entry);
      return false;
    }
    if (authorization?.status !== "allowed" || !isRemoteBrowserLeaseDuration(authorization.validForMs)) {
      this.retire(entry, authorization?.status === "denied" ? "revoked" : "failed");
      return false;
    }

    const deadline = Math.min(requestedAt + authorization.validForMs, entry.sessionDeadline);
    if (deadline <= this.clock.now()) {
      this.retire(entry, "expired");
      return false;
    }
    entry.grantDeadline = deadline;
    this.scheduleExpiry(entry);
    try {
      if (purpose === "start") {
        if (!authorization.url) throw new Error("remote_browser_missing_start_url");
        if (this.options.retirePredecessor) {
          await this.untilStopped(signal, () => this.options.retirePredecessor!(entry.binding));
          if (!this.isLive(entry)) return false;
        }
        entry.resources = this.options.runtime.prepare(entry.binding);
      }
      if (!this.isLive(entry)) return false;
      // Each trusted component also owns its deadline; a lost stop message must not keep it live.
      entry.resources!.gateway.setDeadline(deadline);
      entry.resources!.publisher.setDeadline(deadline);
      this.scheduleRenew(entry);
      if (purpose === "start") {
        void entry.resources!.open(authorization.url!, signal).catch(() => this.retire(entry, "failed"));
      }
      return true;
    } catch {
      this.retire(entry, "failed");
      return false;
    }
  }

  private retire(entry: Entry, reason: StopReason): boolean {
    if (this.sessions.get(entry.binding.sessionId) !== entry) return false;
    this.sessions.delete(entry.binding.sessionId);
    entry.cancelExpiry?.();
    entry.cancelRenew?.();
    // Failure of one closure must still let the other execute. The installed local deadlines remain in force.
    for (const consumer of [entry.resources?.gateway, entry.resources?.publisher]) {
      try { consumer?.revoke(); } catch { /* The other consumer still has to close. */ }
    }
    entry.controller.abort();
    this.options.onStop(entry.binding, reason);
    return true;
  }
}
