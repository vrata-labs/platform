import assert from "node:assert/strict";
import test from "node:test";
import { AccessToken, TokenVerifier } from "livekit-server-sdk";
import {
  captureMediaCredentialPlan, releaseMediaCredential, resolveMediaTokenTtlSeconds, signMediaCredential, type MediaCredentialPlan
} from "./media-credential.js";

const apiKey = "media-credential-test-key";
const apiSecret = "media-credential-test-secret";
const grant = { room: "vrata-room-1", roomJoin: true, canPublish: true, canSubscribe: true } as const;
const base = { apiKey, apiSecret, identity: "participant-1", name: "Listener", grant, ttlSeconds: 120, livekitUrl: "wss://media.example.test" };
const plan = (proofExpiresAtSeconds: number, overrides: Record<string, unknown> = {}) =>
  captureMediaCredentialPlan({ ...base, proofExpiresAtSeconds, ...overrides } as MediaCredentialPlan);
const claims = (token: string) => JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;

type Signer = (token: AccessToken, sign: () => Promise<string>) => Promise<string>;
async function withSigner(signer: Signer, run: () => Promise<void>): Promise<void> {
  const original = AccessToken.prototype.toJwt;
  AccessToken.prototype.toJwt = function (this: AccessToken) { return signer(this, () => original.call(this)); };
  try { await run(); } finally { AccessToken.prototype.toJwt = original; }
}

test("MEDIA_TOKEN_TTL_SECONDS is a strict decimal safe integer within 1..86400, unset meaning 900", () => {
  assert.equal(resolveMediaTokenTtlSeconds(undefined), 900);
  for (const [raw, ttlSeconds] of [["1", 1], ["120", 120], ["900", 900], ["86400", 86_400]] as const) {
    assert.equal(resolveMediaTokenTtlSeconds(raw), ttlSeconds);
  }
  for (const raw of ["", " ", "0", "-1", "86401", "1.5", "1e3", "0x10", "+900", " 900", "900 ", "0900", "900s", "9007199254740993", "Infinity", "NaN"]) {
    assert.equal(resolveMediaTokenTtlSeconds(raw), null);
  }
});

test("SDK pin: a numeric constructor ttl is a relative span, a numeric public ttl after construction is the absolute exp", async () => {
  assert.equal(new AccessToken(apiKey, apiSecret, { identity: "participant-1", ttl: 7 }).ttl, "7s");
  const token = new AccessToken(apiKey, apiSecret, { identity: "participant-1" });
  token.ttl = 4_102_444_800;
  assert.equal(token.ttl, 4_102_444_800);
  const payload = claims(await token.toJwt());
  assert.equal(payload.exp, 4_102_444_800);
  assert.equal(payload.nbf, 0);
  assert.equal("iat" in payload, false);
});

test("the real SDK signs exactly the planned claims, the absolute expiry capped by the original proof", async () => {
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const verifier = new TokenVerifier(apiKey, apiSecret);
  const short = await signMediaCredential(plan(nowSeconds + 7), nowMs);
  assert.ok(short);
  assert.equal(short.expiresAtSeconds, nowSeconds + 7);
  assert.ok(Object.isFrozen(short));
  assert.deepEqual({ ...(await verifier.verify(short.token, 0)) },
    { video: { ...grant }, name: "Listener", iss: apiKey, sub: "participant-1", nbf: 0, exp: nowSeconds + 7 });
  const full = await signMediaCredential(plan(nowSeconds + 900), nowMs);
  assert.ok(full);
  assert.equal(full.expiresAtSeconds, nowSeconds + 120);
  assert.equal((await verifier.verify(full.token, 0)).exp, nowSeconds + 120);
  const unnamed = await signMediaCredential(plan(nowSeconds + 900, { name: "" }), nowMs);
  assert.ok(unnamed);
  assert.equal("name" in claims(unnamed.token), false);
});

test("a lapsed original proof signs nothing", async () => {
  let calls = 0;
  await withSigner((_token, sign) => { calls += 1; return sign(); }, async () => {
    const nowMs = Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    assert.equal(await signMediaCredential(plan(nowSeconds), nowMs), null);
    assert.equal(await signMediaCredential(plan(nowSeconds - 1), nowMs), null);
  });
  assert.equal(calls, 0);
});

test("signed claims that drift from the plan are refused with a fixed message", async () => {
  const nowMs = Date.now();
  const drifted = plan(Math.floor(nowMs / 1000) + 7);
  const drifts: Signer[] = [
    (token, sign) => { token.ttl = "6h"; return sign(); },
    (token, sign) => { token.identity = "participant-2"; return sign(); },
    (token, sign) => { token.name = "Other"; return sign(); },
    (token, sign) => { token.metadata = "extra"; return sign(); },
    (token, sign) => { token.addGrant({ canPublishData: true }); return sign(); },
    (token, sign) => { token.addGrant({ canSubscribe: false }); return sign(); },
    (token, sign) => { token.addGrant({ room: "vrata-room-2" }); return sign(); },
    async () => "not-a-jwt"
  ];
  for (const drift of drifts) {
    await withSigner(drift, () => assert.rejects(signMediaCredential(drifted, nowMs),
      (error: unknown) => error instanceof Error && error.message === "media_credential_claims_mismatch"));
  }
});

test("release rechecks both deadlines on one clock reading and reports the exact remainder", () => {
  const nowSeconds = 1_800_000_000;
  const nowMs = nowSeconds * 1000 + 999;
  const prepared = { token: "prepared", expiresAtSeconds: nowSeconds + 7 };
  const released = releaseMediaCredential(plan(nowSeconds + 60), prepared, nowMs);
  assert.deepEqual(released, { kind: "reply", reply: { token: "prepared", expiresInSeconds: 7, livekitUrl: "wss://media.example.test" } });
  assert.deepEqual(released.kind === "reply" && Object.keys(released.reply), ["token", "expiresInSeconds", "livekitUrl"]);
  assert.deepEqual(releaseMediaCredential(plan(nowSeconds + 60), { ...prepared, expiresAtSeconds: nowSeconds }, nowMs), { kind: "preparation_expired" });
  assert.deepEqual(releaseMediaCredential(plan(nowSeconds), prepared, nowMs), { kind: "proof_expired" });
  assert.deepEqual(releaseMediaCredential(plan(nowSeconds), { ...prepared, expiresAtSeconds: nowSeconds }, nowMs), { kind: "proof_expired" });
  assert.throws(() => releaseMediaCredential(plan(nowSeconds + 60), prepared, Number.NaN), /invalid_media_credential_clock/);
});

test("plan capture is a frozen copy of exactly the four grant fields and refuses malformed primitives", () => {
  const input = { room: "vrata-room-1", roomJoin: true, canPublish: true, canSubscribe: true, canPublishSources: ["camera"] };
  const captured = plan(1_800_000_900, { grant: input });
  input.room = "vrata-room-2";
  input.canPublish = false;
  assert.deepEqual(captured.grant, grant);
  assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured.grant));
  for (const overrides of [{ ttlSeconds: 0 }, { ttlSeconds: 86_401 }, { ttlSeconds: 1.5 }, { proofExpiresAtSeconds: 0 }, { apiKey: "" },
    { apiSecret: "" }, { identity: "" }, { name: 7 }, { livekitUrl: null }, { grant: { ...grant, room: "" } },
    { grant: { ...grant, roomJoin: false } }, { grant: { ...grant, canPublish: "yes" } }, { grant: { ...grant, canSubscribe: false } }]) {
    assert.throws(() => plan(1_800_000_900, overrides), /invalid_media_credential_plan/);
  }
});
