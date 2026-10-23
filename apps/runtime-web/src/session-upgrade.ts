import { identityRequirementFromResponse, type IdentityRequirementReason } from "@vrata/shared-types";

export class SessionUpgradeError extends Error {
  constructor(readonly reason: IdentityRequirementReason) {
    super(reason);
    this.name = "SessionUpgradeError";
  }
}

// Terminal for this page lifetime. Only loading a new application may reopen a
// session; neither a successful late response nor a reconnect can reset it.
export function createSessionUpgradeGate() {
  let reason: IdentityRequirementReason | null = null;
  let handler: ((reason: IdentityRequirementReason) => void) | null = null;
  return {
    get reason() { return reason; },
    require(next: IdentityRequirementReason) {
      if (reason === next || reason === "identity_recovery_required") return;
      reason = next;
      handler?.(next);
    },
    assertActive() { if (reason) throw new SessionUpgradeError(reason); },
    install(onRequired: (reason: IdentityRequirementReason) => void) {
      handler = onRequired;
      if (reason) handler(reason);
      return () => { if (handler === onRequired) handler = null; };
    }
  };
}

export function createSessionAwareFetch(gate: ReturnType<typeof createSessionUpgradeGate>, request: typeof fetch): typeof fetch {
  return async (input, init) => {
    gate.assertActive();
    const response = await request(input, init);
    if ([401, 409, 426].includes(response.status)) {
      const reason = identityRequirementFromResponse(response.status, await response.clone().json().catch(() => null));
      if (reason) gate.require(reason);
    }
    gate.assertActive();
    return response;
  };
}

export const runtimeSessionGate = createSessionUpgradeGate();
export const runtimeFetch = createSessionAwareFetch(runtimeSessionGate, (...args) => globalThis.fetch(...args));

export function describeIdentityRequirement(reason: IdentityRequirementReason): string {
  return reason === "identity_recovery_required" ? "Room access needs recovery" : "Update required to rejoin this room";
}
