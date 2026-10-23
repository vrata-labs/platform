// Room identities are immutable while the room exists. Bounding their number
// is preferable to silently deleting a guest's still-valid possession proof.
export const MAX_ROOM_IDENTITIES = 10_000;
export const MAX_ROOM_WAITING_REQUESTS = 50_000;

export function roomIdentityCapacityAvailable(count: number | null): boolean {
  return count !== null && Number.isSafeInteger(count) && count >= 0 && count < MAX_ROOM_IDENTITIES;
}

export function waitingRequestCapacityAvailable(count: number | undefined): boolean {
  return count !== undefined && Number.isSafeInteger(count) && count >= 0 && count < MAX_ROOM_WAITING_REQUESTS;
}

export type AdmissionKind = "room" | "personal";
export type AdmissionLimitInput = { originHash: string; kind: AdmissionKind };

export function admissionWindows(kind: AdmissionKind): readonly { windowMs: number; limit: number }[] {
  return kind === "personal"
    ? [{ windowMs: 3_600_000, limit: 20 }, { windowMs: 86_400_000, limit: 100 }]
    : [{ windowMs: 60_000, limit: 180 }, { windowMs: 86_400_000, limit: 3_000 }];
}

export function assertAdmissionLimitInput(input: AdmissionLimitInput): void {
  if (!/^[a-f0-9]{64}$/.test(input.originHash) || (input.kind !== "room" && input.kind !== "personal")) {
    throw new Error("invalid_identity_admission_budget");
  }
}
