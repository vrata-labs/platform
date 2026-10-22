import type { RoomPluginBrokerErrorCode, RoomPluginRoomSnapshot, RoomPluginSeatClaimResult } from "@vrata/room-plugin-sdk";

export const ROOM_PLUGIN_ARRIVAL = Object.freeze({ windowMs: 5000, candidates: 8, claimResponseMs: 3000, maxSeats: 64 });

/** Platform-owned seating facts, already authoritative or verified by the core. */
export interface RoomPluginSeatWorld {
  /** Authenticated room ready, scene anchors loaded, spawn applied and the first authoritative occupancy received. */
  ready: boolean;
  /** The room-state server announced claim/release correlation. Without it no arrival grant exists. */
  correlation: boolean;
  online: boolean;
  xr: boolean;
  selfId: string;
  seats: readonly { id: string; yaw: number }[];
  occupancy: Readonly<Record<string, string>>;
  currentSeatId: string | null;
  pendingSeatId: string | null;
}
export interface RoomPluginSeatPorts {
  world(): RoomPluginSeatWorld;
  /** The participant opted out of automatic seating for this room. */
  optedOut(): boolean;
  /** Core command path: request plus correlated send through the frame command bridge. Never a pose write. */
  claim(seatId: string, commandId: string): void;
  /** Cancels the claim only while it is still the pending one, through the correlated release barrier. */
  cancel(releaseCommandId: string, claimCommandId: string): boolean;
  clock?(): number;
  random?(): string;
}
export type RoomPluginSeatOutcome = { result: RoomPluginSeatClaimResult } | { error: RoomPluginBrokerErrorCode };
type Grant = "waiting" | "open" | "used" | "closed";

function randomAlias(): string {
  const bytes = new Uint8Array(9); globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** The single arrival grant of this page session and its correlated self-claims.
 * Plugins only ask; the server decides occupancy and the frame pipeline applies pose. */
export class RoomPluginSeatAdapter {
  private grant: Grant = "waiting";
  private openedAtMs = 0;
  private candidates = 0;
  private sequence = 0;
  private inFlight: { owner: string; commandId: string; seatId: string; resolve(outcome: RoomPluginSeatOutcome): void; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly aliases = new Map<string, Map<string, string>>();
  private readonly nonce: string;
  private readonly clock: () => number;
  private readonly random: () => string;

  constructor(private readonly ports: RoomPluginSeatPorts) {
    this.clock = ports.clock ?? (() => performance.now());
    this.random = ports.random ?? randomAlias;
    this.nonce = this.random().slice(0, 12);
  }

  diagnostics() {
    this.observe();
    const world = this.ports.world();
    return { grant: this.grant, openedAtMs: this.grant === "waiting" ? null : this.openedAtMs, candidates: this.candidates, inFlight: Boolean(this.inFlight),
      ready: world.ready, correlation: world.correlation, online: world.online };
  }

  /** Re-evaluates the grant from platform facts. It opens at most once per page session. */
  observe(): void {
    const world = this.ports.world(), now = this.clock();
    if (this.grant === "waiting" && world.ready) {
      const blocked = !world.correlation || !world.online || world.xr || this.ports.optedOut() || world.currentSeatId || world.pendingSeatId;
      if (blocked) this.grant = "closed";
      else { this.grant = "open"; this.openedAtMs = now; }
    }
    if (this.grant === "open" && !this.inFlight && (now - this.openedAtMs >= ROOM_PLUGIN_ARRIVAL.windowMs || world.xr || !world.online
      || this.ports.optedOut() || world.currentSeatId || this.candidates >= ROOM_PLUGIN_ARRIVAL.candidates)) this.grant = "closed";
  }
  arrivalAllowed(): boolean { this.observe(); return this.grant === "open"; }

  /** Binding-scoped pseudonyms: one random alias per participant per plugin instance, never the platform ID. */
  snapshot(scope: string, seating: boolean): RoomPluginRoomSnapshot {
    this.observe();
    const world = this.ports.world();
    let aliases = this.aliases.get(scope);
    if (!aliases) { aliases = new Map(); this.aliases.set(scope, aliases); }
    const alias = (participantId: string) => {
      let value = aliases!.get(participantId);
      if (!value) { value = this.random(); aliases!.set(participantId, value); }
      return value;
    };
    const own = alias(world.selfId);
    if (!seating) return { ownParticipantAlias: own, arrivalAllowed: false, seats: [] };
    return { ownParticipantAlias: own, arrivalAllowed: this.grant === "open",
      seats: world.seats.slice(0, ROOM_PLUGIN_ARRIVAL.maxSeats).map(seat => {
        const occupant = world.occupancy[seat.id];
        return { id: seat.id, yaw: seat.yaw, occupantAlias: occupant ? alias(occupant) : null };
      }) };
  }
  forget(scope: string): void { this.aliases.delete(scope); }

  claim(seatId: string, owner = "default"): Promise<RoomPluginSeatOutcome> {
    this.observe();
    if (this.grant !== "open") return Promise.resolve({ error: "arrival-not-allowed" });
    if (this.inFlight) return Promise.resolve({ error: "quota-exceeded" });
    const world = this.ports.world();
    if (world.currentSeatId || world.pendingSeatId) { this.grant = "closed"; return Promise.resolve({ error: "arrival-not-allowed" }); }
    this.candidates++;
    if (!world.seats.some(seat => seat.id === seatId) || world.occupancy[seatId]) {
      this.observe(); return Promise.resolve({ result: "busy" });
    }
    const commandId = `plugin-seat:${this.nonce}:${++this.sequence}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => this.finish(commandId, { result: "offline" }, true), ROOM_PLUGIN_ARRIVAL.claimResponseMs);
      this.inFlight = { owner, commandId, seatId, resolve, timer };
      try { this.ports.claim(seatId, commandId); }
      catch { this.finish(commandId, { result: "offline" }, true); }
    });
  }
  /** Correlated server answer. Answers for other or cancelled attempts are ignored here. */
  settleClaim(result: { seatId: string; accepted: boolean; commandId?: string }): void {
    if (!this.inFlight || result.commandId !== this.inFlight.commandId) return;
    if (result.accepted) this.grant = "used";
    this.finish(result.commandId, { result: result.accepted ? "accepted" : "busy" }, false);
  }
  /** A plugin may cancel only its own still-pending claim; a confirmed seat belongs to the user. */
  cancelOwn(owner = "default"): void {
    if (this.inFlight?.owner === owner) this.finish(this.inFlight.commandId, { result: "cancelled" }, true);
  }
  /** A disabled, updated or failed instance: its pending claim is cancelled and its aliases are dropped. */
  retire(owner: string): void {
    this.cancelOwn(owner); this.forget(owner);
  }
  /** Any manual seat, stand, teleport or movement intent vetoes the arrival grant for good. */
  manualIntent(): void {
    if (this.grant === "waiting" || this.grant === "open") this.grant = "closed";
    if (this.inFlight) this.finish(this.inFlight.commandId, { result: "cancelled" }, true);
  }
  /** Connection loss closes an open grant (no retries) but not one still waiting for readiness;
   * session end closes both. A pending claim is cancelled through the barrier. */
  stop(reason: "offline" | "closed" = "closed"): void {
    if (this.grant === "open" || reason === "closed" && this.grant === "waiting") this.grant = "closed";
    if (this.inFlight) this.finish(this.inFlight.commandId, { result: reason === "offline" ? "offline" : "cancelled" }, true);
  }

  private finish(commandId: string, outcome: RoomPluginSeatOutcome, cancel: boolean): void {
    const flight = this.inFlight;
    if (!flight || flight.commandId !== commandId) return;
    this.inFlight = null; clearTimeout(flight.timer);
    if (cancel) { try { this.ports.cancel(`plugin-release:${this.nonce}:${++this.sequence}`, commandId); } catch { /* The core barrier owns recovery. */ } }
    this.observe();
    flight.resolve(outcome);
  }
}
