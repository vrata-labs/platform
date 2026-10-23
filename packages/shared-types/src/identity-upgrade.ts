export type IdentityRequirementReason = "identity_upgrade_required" | "identity_recovery_required";

export interface IdentityRequirementResponse {
  error: "identity_required";
  reason: IdentityRequirementReason;
}

export const IDENTITY_UPGRADE_CLOSE_CODE = 4406;
export const IDENTITY_RECOVERY_CLOSE_CODE = 4409;

export function identityRequirementFromResponse(status: number, payload: unknown): IdentityRequirementReason | null {
  if (![401, 409, 426].includes(status) || !payload || typeof payload !== "object") return null;
  const response = payload as Partial<IdentityRequirementResponse>;
  if (response.error !== "identity_required") return null;
  return response.reason === "identity_upgrade_required" || response.reason === "identity_recovery_required" ? response.reason : null;
}

export function identityRequirementFromClose(code: number, reason: string): IdentityRequirementReason | null {
  const expected = code === IDENTITY_UPGRADE_CLOSE_CODE ? "identity_upgrade_required"
    : code === IDENTITY_RECOVERY_CLOSE_CODE ? "identity_recovery_required" : null;
  return expected && (!reason || reason === expected) ? expected : null;
}
