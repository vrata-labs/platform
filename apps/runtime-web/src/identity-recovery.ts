/** This is the sole deliberate exception to the terminal old-session fetch
 * gate: a one-use administrator proof can start a *new* v2 session. The old
 * session token and public participant ID are never sent with this request. */
export async function redeemRoomRecovery(input: {
  apiBaseUrl: string;
  roomId: string;
  displayName: string;
  credential: string;
  request?: typeof fetch;
}): Promise<{ participantId: string; identityCredential: string }> {
  const credential = input.credential.trim();
  if (!/^rr2\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(credential)) throw new Error("invalid_recovery_code");
  const response = await (input.request ?? globalThis.fetch)(new URL("/api/tokens/state", input.apiBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identityProtocolVersion: 2, roomId: input.roomId,
      displayName: input.displayName, recoveryCredential: credential })
  });
  if (!response.ok) throw new Error("recovery_denied");
  const result: unknown = await response.json();
  if (!result || typeof result !== "object") throw new Error("invalid_recovery_response");
  const value = result as Record<string, unknown>;
  if (value.identityProtocolVersion !== 2 || typeof value.participantId !== "string" || !value.participantId
    || typeof value.identityCredential !== "string" || !/^ri2\.[A-Za-z0-9_-]{1,3000}\.[A-Za-z0-9_-]{43}$/.test(value.identityCredential)) {
    throw new Error("invalid_recovery_response");
  }
  return { participantId: value.participantId, identityCredential: value.identityCredential };
}
