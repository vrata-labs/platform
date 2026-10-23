import { ROOM_PLUGIN_LIMITS, type RoomPluginCapability } from "@vrata/room-plugin-sdk";
import type { RoomPluginRuntimeBinding, RoomPluginRuntimeSnapshot } from "./runtime-dto.js";
import type { RoomPluginTokenProof } from "./token-bound.js";

type Identity = Pick<RoomPluginRuntimeBinding, "bindingId" | "generation" | "bindingRevision" | "artifactSha256">;
export interface RoomPluginLeaseRequest {
  readonly epoch: number; readonly startedAtMs: number; readonly tokenDeadlineMs: number;
}
export interface RoomPluginEffectPermit extends Identity {
  readonly epoch: number; readonly leaseGeneration: number; readonly snapshotRevision: number; readonly deadlineMs: number;
}
const same = (left: Identity, right: Identity) => left.bindingId === right.bindingId && left.generation === right.generation
  && left.bindingRevision === right.bindingRevision && left.artifactSha256 === right.artifactSha256;
const contentKey = (binding: RoomPluginRuntimeBinding) => JSON.stringify([binding.packageId, binding.pluginId, binding.version,
  [...binding.approvedCapabilities].sort(), Object.keys(binding.config).sort().map(key => [key, binding.config[key]])]);

/** Native authority fence. Inputs are already parsed/authenticated DTOs, never VM
 * metadata. Timer delivery is not the authority check: every effect checks time. */
export class RoomPluginBindingLease {
  private epoch = 0;
  private revision = -1;
  private deadlineMs = 0;
  private leaseGeneration = 0;
  private lastRequestStartedAtMs = -Infinity;
  private bindings = new Map<string, Identity>();
  private contents = new Map<string, { identity: Identity; key: string }>();
  private readonly requests = new WeakSet<RoomPluginLeaseRequest>();
  private readonly permits = new WeakSet<RoomPluginEffectPermit>();
  constructor(private readonly clock: () => number = () => performance.now()) {}

  beginRequest(proof: RoomPluginTokenProof): RoomPluginLeaseRequest | null {
    const now = this.clock(); this.expire(now);
    if (!Number.isFinite(now) || now < 0 || !proof.token.length || !Number.isFinite(proof.deadlineMs) || now >= proof.deadlineMs) return null;
    const request = Object.freeze({ epoch: this.epoch, startedAtMs: now, tokenDeadlineMs: proof.deadlineMs });
    this.requests.add(request); return request;
  }

  accept(request: RoomPluginLeaseRequest, snapshot: RoomPluginRuntimeSnapshot): boolean {
    if (!this.requests.delete(request)) return false;
    const now = this.clock(); this.expire(now);
    const deadline = Math.min(request.startedAtMs + ROOM_PLUGIN_LIMITS.bindingLeaseMs, request.tokenDeadlineMs);
    if (request.epoch !== this.epoch || !Number.isFinite(now) || now < 0 || !Number.isFinite(request.startedAtMs)
      || request.startedAtMs < 0 || !Number.isFinite(request.tokenDeadlineMs) || now < request.startedAtMs || now >= deadline
      || snapshot.revision < this.revision || snapshot.revision === this.revision && request.startedAtMs < this.lastRequestStartedAtMs) return false;
    const contents = new Map(snapshot.bindings.map(binding => [binding.bindingId, { identity: binding, key: contentKey(binding) }]));
    for (const [id, value] of contents) {
      const previous = this.contents.get(id);
      if (previous && same(previous.identity, value.identity) && previous.key !== value.key) { this.invalidate(); return false; }
    }
    this.revision = snapshot.revision;
    this.lastRequestStartedAtMs = request.startedAtMs;
    this.deadlineMs = deadline;
    this.contents = contents;
    this.bindings = new Map(snapshot.bindings.map(binding => [binding.bindingId, Object.freeze({ bindingId: binding.bindingId,
      generation: binding.generation, bindingRevision: binding.bindingRevision, artifactSha256: binding.artifactSha256 })]));
    return true;
  }

  permit(identity: Identity): RoomPluginEffectPermit | null {
    const now = this.clock(); this.expire(now);
    const current = this.bindings.get(identity.bindingId);
    if (!current || !same(current, identity) || now >= this.deadlineMs) return null;
    const permit = Object.freeze({ ...current, epoch: this.epoch, leaseGeneration: this.leaseGeneration, snapshotRevision: this.revision, deadlineMs: this.deadlineMs });
    this.permits.add(permit); return permit;
  }

  authorize(binding: RoomPluginRuntimeBinding, capability: RoomPluginCapability): RoomPluginEffectPermit | null {
    const known = this.contents.get(binding.bindingId);
    return known && same(known.identity, binding) && known.key === contentKey(binding) && binding.approvedCapabilities.includes(capability)
      ? this.permit(binding) : null;
  }

  isCurrent(permit: RoomPluginEffectPermit): boolean {
    if (!this.permits.has(permit)) return false;
    const now = this.clock(); this.expire(now);
    const current = this.bindings.get(permit.bindingId);
    const valid = Boolean(current && same(current, permit) && permit.epoch === this.epoch && permit.leaseGeneration === this.leaseGeneration
      && permit.snapshotRevision === this.revision && Number.isFinite(now) && now >= 0 && now < permit.deadlineMs && now < this.deadlineMs);
    if (!valid) this.permits.delete(permit);
    return valid;
  }

  invalidate(): void { this.epoch++; this.deadlineMs = 0; this.bindings.clear(); }
  resetSession(): void { this.invalidate(); this.contents.clear(); this.revision = -1; this.lastRequestStartedAtMs = -Infinity; }
  diagnostics() {
    const now = this.clock(); this.expire(now);
    return { epoch: this.epoch, revision: this.revision < 0 ? null : this.revision,
      activeBindings: this.bindings.size, remainingMs: Number.isFinite(now) && now >= 0 ? Math.max(0, this.deadlineMs - now) : 0 };
  }
  private expire(now: number): void {
    if (this.deadlineMs && (!Number.isFinite(now) || now < 0 || now >= this.deadlineMs)) {
      this.leaseGeneration++; this.deadlineMs = 0; this.bindings.clear();
    }
  }
}
