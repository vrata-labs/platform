import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import { privateHttp } from "./plugin-author-scenarios";

/** The deployed floor is read from the API, never assumed: activation is irreversible, and
 * the same staging tests verify the deployments on both sides of it. */
export async function identityProtocolAt(origin: string): Promise<1 | 2> {
  const health = await fetch(new URL("/health", origin), { signal: AbortSignal.timeout(15_000) });
  expect(health.ok).toBe(true);
  return (await health.json()).features?.identityProtocolVersion === 2 ? 2 : 1;
}

/** The same, through a request context's own base URL: the local server in CI, the deployment on staging. */
export async function identityProtocolOf(request: APIRequestContext): Promise<1 | 2> {
  const health = await request.get("/health");
  expect(health.ok()).toBe(true);
  return (await health.json()).features?.identityProtocolVersion === 2 ? 2 : 1;
}

export interface InvitationAdmission { token: string; participantId: string; role: string; access: { role: string }; identityProtocolVersion?: 2 }

/** One participant admitted through a genuine invitation, possibly several times. Floor 1 repeats
 * the caller's public ID; floor 2 issues its own ID and later admissions renew that identity. */
export function invitedParticipant(origin: string, roomId: string, inviteToken: string, displayName: string) {
  let participantId: string = randomUUID();
  let identityCredential: string | undefined;
  return {
    get participantId() { return participantId; },
    async admit(): Promise<InvitationAdmission> {
      const protocol = await identityProtocolAt(origin);
      const admitted = await privateHttp(origin, "/api/tokens/state", "POST", {}, protocol === 2
        ? { identityProtocolVersion: 2, roomId, displayName, ...(identityCredential ? { identityCredential } : { inviteToken }) }
        : { roomId, participantId, displayName, inviteToken });
      expect(admitted.status).toBe(200);
      const session = admitted.json<InvitationAdmission & { identityCredential?: string }>();
      if (protocol === 1) return { ...session, participantId };
      expect(session.identityProtocolVersion === 2 && session.token.startsWith("rs2.")).toBe(true);
      expect(identityCredential === undefined || session.participantId === participantId).toBe(true);
      ({ participantId, identityCredential } = session);
      const { identityCredential: _private, ...admission } = session;
      return admission;
    }
  };
}

export const admitInvitation = (origin: string, roomId: string, inviteToken: string, displayName: string) =>
  invitedParticipant(origin, roomId, inviteToken, displayName).admit();
