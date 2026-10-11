import {
  encodeRemoteBrowserFrameToken, isRemoteBrowserFrameBinding, FRAME_TOKEN_MAX_TTL_SECONDS, type RemoteBrowserFrameBinding
} from "@vrata/shared-types/remote-browser-frame-token";

/** Request-independent primitives captured before the binding RPC; nothing retains the request, its body or context. */
export interface FrameCredentialPlan {
  readonly binding: Readonly<RemoteBrowserFrameBinding>;
  readonly secret: string;
  readonly ttlSeconds: number;
  /** The original MAC-verified session expiry: no frame credential outlives it. */
  readonly proofExpiresAtSeconds: number;
  /** Precomputed outside every fence; only the token query is added inside. */
  readonly frameStreamUrl: string;
}

export interface FrameCredentialReply {
  readonly token: string;
  readonly expiresInSeconds: number;
  readonly frameStreamUrl: string;
}

/** A frozen copy of exactly the five binding fields, validated by the shared codec rule; null when malformed. */
export function captureRemoteBrowserFrameBinding(input: unknown): Readonly<RemoteBrowserFrameBinding> | null {
  if (typeof input !== "object" || input === null) return null;
  const { roomId, objectId, executorSessionId, executorInstanceId, frameStreamId } = input as Record<string, unknown>;
  const binding = { roomId, objectId, executorSessionId, executorInstanceId, frameStreamId };
  return isRemoteBrowserFrameBinding(binding) ? Object.freeze(binding) : null;
}

export function captureFrameCredentialPlan(input: FrameCredentialPlan): FrameCredentialPlan {
  const { binding, secret, ttlSeconds, proofExpiresAtSeconds, frameStreamUrl } = input;
  if (!Object.isFrozen(binding) || typeof secret !== "string" || secret.trim().length === 0
    || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > FRAME_TOKEN_MAX_TTL_SECONDS
    || !Number.isSafeInteger(proofExpiresAtSeconds) || proofExpiresAtSeconds < 1) throw new Error("invalid_frame_credential_plan");
  return Object.freeze({ binding, secret, ttlSeconds, proofExpiresAtSeconds, frameStreamUrl: new URL(frameStreamUrl).toString() });
}

/** Pure and synchronous: one clock reading bounds the claim and the reported lifetime. The new expiry never exceeds the
 * original proof's, a short remainder is reported as is with no minimum, and nothing is signed once that deadline is reached. */
export function issueRemoteBrowserFrameCredential(plan: FrameCredentialPlan, nowMs: number): FrameCredentialReply | null {
  const nowSeconds = Math.floor(nowMs / 1000);
  const exp = Math.min(nowSeconds + plan.ttlSeconds, plan.proofExpiresAtSeconds);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 1 || exp <= nowSeconds) return null;
  const { roomId, objectId, executorSessionId, executorInstanceId, frameStreamId } = plan.binding;
  const token = encodeRemoteBrowserFrameToken({ v: 2, roomId, objectId, executorSessionId, executorInstanceId, frameStreamId, exp }, plan.secret);
  const frameStreamUrl = new URL(plan.frameStreamUrl);
  frameStreamUrl.searchParams.set("token", token);
  return { token, expiresInSeconds: exp - nowSeconds, frameStreamUrl: frameStreamUrl.toString() };
}
