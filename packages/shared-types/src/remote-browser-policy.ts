export const REMOTE_BROWSER_ROOM_POLICY_PATH = "/api/internal/remote-browser/room-policy";
export const REMOTE_BROWSER_PUBLIC_HTTPS_SESSION_PATH = "/api/internal/remote-browser/public-https/v1/session";
export const REMOTE_BROWSER_PUBLIC_HTTPS_AUTHORITY_PATH = "/api/internal/remote-browser/public-https/v1/authorize";
export const REMOTE_BROWSER_PUBLIC_HTTPS_MAX_LEASE_MS = 10_000;

export type RemoteBrowserRoomPolicy =
  | { mode: "allowlist"; roomId: string }
  | { mode: "public-https"; roomId: string; tenantId: string; policyRevision: string; validForMs: number };

export interface RemoteBrowserPublicHttpsBinding {
  tenantId: string;
  roomId: string;
  surfaceId: string;
  objectId: string;
  sessionId: string;
  executorInstanceId: string;
  policyRevision: string;
}

const bindingFields = [
  "tenantId", "roomId", "surfaceId", "objectId", "sessionId", "executorInstanceId", "policyRevision"
] as const;

export function isRemoteBrowserPublicHttpsBinding(value: unknown): value is RemoteBrowserPublicHttpsBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Record<string, unknown>;
  return bindingFields.every(key => typeof binding[key] === "string" && binding[key].length > 0 && binding[key].length <= 512)
    && binding.sessionId === `remote-browser:${binding.objectId}`
    && (binding.executorInstanceId as string).startsWith(`${binding.sessionId}:instance:`);
}

export function sameRemoteBrowserPublicHttpsBinding(left: RemoteBrowserPublicHttpsBinding, right: RemoteBrowserPublicHttpsBinding): boolean {
  return bindingFields.every(key => left[key] === right[key]);
}

export function isRemoteBrowserLeaseDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= REMOTE_BROWSER_PUBLIC_HTTPS_MAX_LEASE_MS;
}
