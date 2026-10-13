export type MediaTokenRetryReason = "room_state_changed" | "media_credential_preparation_expired";
type MediaTokenReason = MediaTokenRetryReason | "media_publish_not_allowed";

export class MediaTokenRequestError extends Error {
  readonly reason: MediaTokenReason | null;
  constructor(readonly status: number, reason: unknown) {
    super(`failed_to_load_media_token:${status}`);
    this.reason = reason === "room_state_changed" || reason === "media_credential_preparation_expired" || reason === "media_publish_not_allowed" ? reason : null;
  }
}

/** Screen permission on base connect is optional; microphone remains the user's intent. An explicit share request never
 * uses this helper. Narrow exactly once after this permission refusal, with the same still-current admitted proof. */
export async function planBaseMedia<Plan>(input: {
  optionalShare: boolean;
  proofStillCurrent: () => boolean;
  plan: (screenShare: boolean) => Promise<Plan>;
}): Promise<Plan> {
  try { return await input.plan(input.optionalShare); }
  catch (error) {
    if (!input.optionalShare || !(error instanceof MediaTokenRequestError) || error.status !== 403
      || error.reason !== "media_publish_not_allowed" || !input.proofStillCurrent()) throw error;
    return input.plan(false);
  }
}

export function retryableMediaTokenError(error: unknown): boolean {
  return error instanceof MediaTokenRequestError && (error.status === 409 && error.reason === "room_state_changed"
    || error.status === 503 && error.reason === "media_credential_preparation_expired");
}
