/** Derive a conservative native monotonic deadline from the START of the
 * authenticated token request, never response receipt or a fallback UI TTL.
 * The second removed from the lifetime covers integer-second server issuance. */
export function roomPluginTokenDeadline(requestStartedAtMs: number, expiresInSeconds: unknown): number | null {
  if (!Number.isFinite(requestStartedAtMs) || requestStartedAtMs < 0
    || typeof expiresInSeconds !== "number" || !Number.isSafeInteger(expiresInSeconds)
    || expiresInSeconds < 1 || expiresInSeconds > 86_400) return null;
  const deadline = requestStartedAtMs + (expiresInSeconds - 1) * 1000;
  return Number.isFinite(deadline) && deadline <= Number.MAX_SAFE_INTEGER ? deadline : null;
}

export interface RoomPluginTokenProof { readonly token: string; readonly deadlineMs: number }
export interface RoomPluginTokenRequest { readonly epoch: number; readonly sequence: number; readonly startedAtMs: number }

/** Native-only credentials. A token swap without its own deadline fails closed. */
export class RoomPluginTokenBound {
  private token = "";
  private deadlineMs: number | null = null;
  private epoch = 0;
  private sequence = 0;
  private admittedSequence = 0;
  private readonly requests = new WeakSet<RoomPluginTokenRequest>();
  constructor(private readonly clock: () => number = () => performance.now()) {}

  begin(): RoomPluginTokenRequest | null {
    const startedAtMs = this.clock();
    if (!Number.isFinite(startedAtMs) || startedAtMs < 0) return null;
    const request = Object.freeze({ epoch: this.epoch, sequence: ++this.sequence, startedAtMs });
    this.requests.add(request); return request;
  }

  observeToken(token: string): void {
    if (token !== this.token) { this.clear(); this.token = token; }
  }

  admit(request: RoomPluginTokenRequest | null, token: string, expiresInSeconds: unknown): boolean {
    if (!request || !this.requests.delete(request) || request.epoch !== this.epoch || request.sequence <= this.admittedSequence) return false;
    const now = this.clock();
    if (!Number.isFinite(now) || now < request.startedAtMs) return false;
    this.admittedSequence = request.sequence;
    this.token = token;
    this.deadlineMs = token ? roomPluginTokenDeadline(request.startedAtMs, expiresInSeconds) : null;
    return this.capture() !== null;
  }

  capture(): RoomPluginTokenProof | null {
    const now = this.clock();
    return this.token && this.deadlineMs !== null && Number.isFinite(now) && now >= 0 && now < this.deadlineMs
      ? Object.freeze({ token: this.token, deadlineMs: this.deadlineMs }) : null;
  }

  clear(): void { this.epoch++; this.token = ""; this.deadlineMs = null; }
}
