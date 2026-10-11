import { FRAME_TOKEN_MAX_TTL_SECONDS, decodeRemoteBrowserFrameToken } from "@vrata/shared-types/remote-browser-frame-token";

// Node-only consumer surface over the shared strict v2 codec. There is no legacy HMAC(body) fallback.
export * from "@vrata/shared-types/remote-browser-frame-token";

/** The executor fields a frame token must match exactly at upgrade. */
export interface RemoteBrowserFrameSessionView {
  readonly sessionId: string;
  readonly executorInstanceId: string;
  readonly frameStreamId?: string;
  readonly roomId: string;
  readonly objectId: string;
  readonly expiresAtMs: number;
}

export interface RemoteBrowserFrameAdmission<S extends RemoteBrowserFrameSessionView> {
  readonly session: S;
  readonly executorInstanceId: string;
  /** Socket lease: never past the token, the TTL cap, or the executor deadline. */
  readonly leaseExpiresAtSeconds: number;
}

/** One clock reading decides token validity, executor liveness and the socket lease, so they cannot disagree. */
export function admitRemoteBrowserFrameSocket<S extends RemoteBrowserFrameSessionView>(input: {
  token: string | null | undefined;
  secret: string;
  nowMs: number;
  findSession: (executorSessionId: string) => S | undefined;
}): RemoteBrowserFrameAdmission<S> | null {
  const nowSeconds = Math.floor(input.nowMs / 1000);
  const claims = decodeRemoteBrowserFrameToken(input.token, input.secret, { nowSeconds });
  if (!claims) return null;
  const session = input.findSession(claims.executorSessionId);
  // The deadline is checked directly: the expiry timer may not have stopped the session yet.
  if (!session || session.sessionId !== claims.executorSessionId || session.executorInstanceId !== claims.executorInstanceId
    || session.frameStreamId !== claims.frameStreamId || session.roomId !== claims.roomId || session.objectId !== claims.objectId
    || !(input.nowMs < session.expiresAtMs)) return null;
  const leaseExpiresAtSeconds = Math.min(claims.exp, nowSeconds + FRAME_TOKEN_MAX_TTL_SECONDS, Math.floor(session.expiresAtMs / 1000));
  if (leaseExpiresAtSeconds * 1000 <= input.nowMs) return null;
  return { session, executorInstanceId: claims.executorInstanceId, leaseExpiresAtSeconds };
}
