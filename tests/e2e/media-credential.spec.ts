import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { parseRoomSessionTokenPayload, signRoomSessionToken } from "../../packages/shared-types/src/session-token.js";

// Local API/browser credential boundary. JWTs and state proofs stay in memory, never in traces or failure artifacts.
// This verifies issuance, not a connected LiveKit session or self-hosted token revocation. No staging tag.
test.use({ trace: "off", screenshot: "off", video: "off" });
const { TokenVerifier } = createRequire(resolve("apps/api/package.json"))("livekit-server-sdk");

for (const transport of ["bearer", "body"] as const) {
  test(`user media credential respects the original seven-second proof over ${transport}`, async ({ page, baseURL }) => {
    const roomId = `media-credential-${randomUUID()}`;
    const admitted = await fetch(new URL("/api/tokens/state", baseURL!), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId, participantId: randomUUID(), displayName: "Media credential listener" })
    });
    expect(admitted.status).toBe(200);
    const issued = await admitted.json() as { token?: unknown };
    expect(typeof issued.token).toBe("string");
    let original = null;
    try { original = parseRoomSessionTokenPayload(JSON.parse(Buffer.from(String(issued.token).split(".")[0] ?? "", "base64url").toString("utf8"))); }
    catch { /* only the parsed outcome is asserted */ }
    expect(original !== null && original.roomId === roomId).toBe(true);
    const proof = { ...original!, exp: Math.floor(Date.now() / 1000) + 7 };
    const token = signRoomSessionToken(proof, process.env.STATE_TOKEN_SECRET ?? "dev-state-secret");
    await page.goto(new URL("/health", baseURL!).toString());
    const before = Math.floor(Date.now() / 1000);
    const response = await page.evaluate(async input => {
      const reply = await fetch("/api/tokens/media", {
        method: "POST", headers: { "content-type": "application/json", ...(input.transport === "bearer" ? { authorization: `Bearer ${input.token}` } : {}) },
        body: JSON.stringify({ roomId: input.roomId, participantId: input.participantId, canPublishAudio: true, canPublishVideo: false,
          ...(input.transport === "body" ? { sessionToken: input.token } : {}) })
      });
      const body = await reply.json();
      return { status: reply.status, token: typeof body.token === "string" ? body.token : null,
        lifetime: body.expiresInSeconds, shape: Object.keys(body).sort().join(), hasUrl: typeof body.livekitUrl === "string" };
    }, { transport, token, roomId, participantId: proof.participantId });
    const after = Math.floor(Date.now() / 1000);
    expect(response.status).toBe(200);
    expect(response.shape).toBe("expiresInSeconds,livekitUrl,token");
    expect(response.hasUrl).toBe(true);
    let jwt = null;
    try { jwt = await new TokenVerifier(process.env.LIVEKIT_API_KEY ?? "devkey", process.env.LIVEKIT_API_SECRET ?? "secret").verify(response.token, 0); }
    catch { /* never print a JWT or verification error */ }
    expect(jwt !== null && jwt.sub === proof.participantId && jwt.video?.roomJoin === true && jwt.video?.canSubscribe === true).toBe(true);
    expect(jwt !== null && jwt.exp === proof.exp).toBe(true);
    expect(Number.isSafeInteger(response.lifetime) && response.lifetime >= 1 && response.lifetime <= 7).toBe(true);
    const releasedAt = jwt.exp - response.lifetime;
    expect(releasedAt >= before && releasedAt <= after).toBe(true);
  });
}
