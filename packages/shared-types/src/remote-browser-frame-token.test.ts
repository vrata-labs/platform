import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import test from "node:test";

import {
  FRAME_TOKEN_CLOCK_SKEW_SECONDS,
  FRAME_TOKEN_MAX_BYTES,
  FRAME_TOKEN_MAX_TTL_SECONDS,
  InvalidRemoteBrowserFrameTokenError,
  RemoteBrowserFrameTokenConfigError,
  decodeRemoteBrowserFrameToken,
  encodeRemoteBrowserFrameToken,
  isRemoteBrowserFrameBinding,
  type RemoteBrowserFrameTokenPayload
} from "./remote-browser-frame-token.js";

const secret = "test-only-frame-token-secret";
const otherSecret = "test-only-other-frame-token-secret";
const nowSeconds = 1_800_000_000;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function scoped(objectId: string, instanceSuffix = "generation-1", roomId = "room-1"): RemoteBrowserFrameTokenPayload {
  const sessionId = `remote-browser:${objectId}`;
  return { v: 2, roomId, objectId, executorSessionId: sessionId, executorInstanceId: `${sessionId}:instance:${instanceSuffix}`,
    frameStreamId: `${sessionId}:frames`, exp: nowSeconds + 300 };
}
const payload = scoped("browser-1");

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
// Test-local v2 signer: a valid domain-separated MAC over arbitrary bodies, so validation runs past the signature.
const signV2Body = (body: string, key = secret) => `${body}.${createHmac("sha256", key).update(`vrata.frame.v2\n${body}`).digest("base64url")}`;
const signV2Claims = (claims: unknown, key = secret) => signV2Body(b64(JSON.stringify(claims)), key);
const without = (name: string) => Object.fromEntries(Object.entries(payload).filter(([key]) => key !== name));
// Flips a padding bit of the final character: same decoded bytes, non-canonical text.
const aliasLast = (value: string) => value.slice(0, -1) + alphabet[alphabet.indexOf(value.at(-1)!) ^ 1];
const sameBytes = (left: string, right: string) => Buffer.from(left, "base64url").equals(Buffer.from(right, "base64url"));

function accepts(token: unknown, options: { nowSeconds?: number } = { nowSeconds }): boolean {
  return decodeRemoteBrowserFrameToken(token as string, secret, options) !== null;
}

// Private, pure copy of the pre-v2 algorithm (apps/remote-browser/src/frame-token.ts at 2cf40b6) with an
// explicit clock. Deliberately not imported, so edits to the released baseline cannot weaken these checks.
interface LegacyFrameTokenPayload { roomId: string; objectId: string; executorSessionId: string; frameStreamId: string; exp: number }
const legacySign = (body: string, key: string) => createHmac("sha256", key).update(body).digest("base64url");
function legacyEncode(claims: LegacyFrameTokenPayload, key: string): string {
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${body}.${legacySign(body, key)}`;
}
function legacyDecode(token: string, key: string, now: number): LegacyFrameTokenPayload | null {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = Buffer.from(legacySign(body, key));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<LegacyFrameTokenPayload>;
    if (typeof claims.roomId !== "string" || typeof claims.objectId !== "string" || typeof claims.executorSessionId !== "string"
      || typeof claims.frameStreamId !== "string" || typeof claims.exp !== "number" || claims.exp < now) return null;
    return claims as LegacyFrameTokenPayload;
  } catch {
    return null;
  }
}

test("v2 frame token is deterministic and decodes to a frozen private copy of the exact scope", () => {
  const token = encodeRemoteBrowserFrameToken(payload, secret);
  assert.equal(token === encodeRemoteBrowserFrameToken({ ...payload }, secret), true);
  const decoded = decodeRemoteBrowserFrameToken(token, secret, { nowSeconds });
  assert.deepEqual(decoded, payload);
  assert.equal(decoded === payload, false);
  assert.equal(Object.isFrozen(decoded), true);
  assert.equal(decodeRemoteBrowserFrameToken(token, secret, { nowSeconds }) === decoded, false);
  assert.equal(accepts(token, { nowSeconds: nowSeconds + 0.9 }), true);
  assert.equal(decodeRemoteBrowserFrameToken(token, otherSecret, { nowSeconds }), null);
});

test("v2 body carries exactly the agreed claims in canonical order and no authority fields", () => {
  const [body] = encodeRemoteBrowserFrameToken(payload, secret).split(".");
  const json = Buffer.from(body, "base64url").toString("utf8");
  assert.equal(json, JSON.stringify({ v: 2, roomId: "room-1", objectId: "browser-1", executorSessionId: "remote-browser:browser-1",
    executorInstanceId: "remote-browser:browser-1:instance:generation-1", frameStreamId: "remote-browser:browser-1:frames", exp: nowSeconds + 300 }));
  const claims = JSON.parse(json) as Record<string, unknown>;
  for (const field of ["role", "permissions", "owner", "isOwner", "participantId", "sessionToken"]) {
    assert.equal(Object.hasOwn(claims, field), false);
  }
  const reordered = { exp: payload.exp, frameStreamId: payload.frameStreamId, executorInstanceId: payload.executorInstanceId,
    executorSessionId: payload.executorSessionId, objectId: payload.objectId, roomId: payload.roomId, v: 2 as const };
  assert.equal(encodeRemoteBrowserFrameToken(reordered, secret) === encodeRemoteBrowserFrameToken(payload, secret), true);
  assert.equal(signV2Claims(payload) === encodeRemoteBrowserFrameToken(payload, secret), true);
});

test("domain-separated MAC keeps legacy and v2 frame tokens from cross-decoding", () => {
  const legacyPayload = { roomId: payload.roomId, objectId: payload.objectId, executorSessionId: payload.executorSessionId,
    frameStreamId: payload.frameStreamId, exp: payload.exp };
  const legacyToken = legacyEncode(legacyPayload, secret);
  assert.deepEqual(legacyDecode(legacyToken, secret, nowSeconds), legacyPayload);
  assert.equal(accepts(legacyToken), false);

  const v2Token = encodeRemoteBrowserFrameToken(payload, secret);
  const [v2Body, v2Signature] = v2Token.split(".");
  assert.equal(legacyDecode(v2Token, secret, nowSeconds), null);
  assert.equal(v2Signature === legacySign(v2Body, secret), false);
  // Only the domain prefix protects the old reader: the same body under the legacy MAC would pass it.
  assert.equal(legacyDecode(`${v2Body}.${legacySign(v2Body, secret)}`, secret, nowSeconds) !== null, true);
  assert.equal(accepts(`${v2Body}.${legacySign(v2Body, secret)}`), false);

  // Legacy claims fail even under a valid v2 MAC: version and instance are absent.
  assert.equal(accepts(signV2Claims(legacyPayload)), false);
  assert.equal(accepts(signV2Claims({ ...legacyPayload, v: 2 })), false);
  assert.equal(accepts(signV2Claims({ ...legacyPayload, executorInstanceId: payload.executorInstanceId })), false);
});

test("decoder enforces strict two-part canonical base64url framing within the byte bound", () => {
  const token = encodeRemoteBrowserFrameToken(payload, secret);
  const [body, signature] = token.split(".");
  const flipFirst = (value: string) => (value[0] === "A" ? "B" : "A") + value.slice(1);
  assert.equal(accepts(token), true);
  assert.equal(sameBytes(aliasLast(signature), signature), true);
  for (const bad of [undefined, null, "", 42, {}, [token], body, `${body}.`, `.${signature}`, `${token}.`, `${token}.${signature}`,
    `${body}.${signature}=`, `${body}=.${signature}`, ` ${token}`, `${token}\n`, `${body}.${signature.slice(0, -1)}`, `${body}.${signature}A`,
    `${flipFirst(body)}.${signature}`, `${body}.${flipFirst(signature)}`, `${body}.${aliasLast(signature)}`,
    `${body}.${Buffer.from(signature, "base64url").toString("base64")}`, `${body}.é${signature.slice(1)}`, `${body}\u2024${signature}`,
    "A".repeat(FRAME_TOKEN_MAX_BYTES + 1), `${"e".repeat(FRAME_TOKEN_MAX_BYTES - 44)}.${signature}`]) {
    assert.equal(accepts(bad), false);
  }

  // A non-canonical body alias with a valid MAC over its text must still be refused.
  const aliasable = [0, 1, 2].map(n => b64(JSON.stringify({ ...payload, roomId: `room-1${"x".repeat(n)}` }))).find(text => text.length % 4 !== 0)!;
  assert.equal(sameBytes(aliasLast(aliasable), aliasable), true);
  assert.equal(accepts(signV2Body(aliasable)), true);
  assert.equal(accepts(signV2Body(aliasLast(aliasable))), false);

  // Validly signed whitespace-padded claims isolate the byte bound: 6111 bytes -> 8192-byte token, 6112 -> 8194.
  const json = JSON.stringify(payload);
  const padded = (bytes: number) => signV2Body(b64(json + " ".repeat(bytes - Buffer.byteLength(json))));
  assert.equal(padded(6111).length === FRAME_TOKEN_MAX_BYTES, true);
  assert.equal(accepts(padded(6111)), true);
  assert.equal(padded(6112).length > FRAME_TOKEN_MAX_BYTES, true);
  assert.equal(accepts(padded(6112)), false);
});

test("signed but malformed claims cannot acquire scope or authority", () => {
  const invalid: unknown[] = [
    null, "claims", [payload], without("v"), without("executorInstanceId"), without("exp"),
    ...[{ v: 1 }, { v: "2" }, { v: undefined }, { role: "host" }, { owner: true }, { isOwner: true }, { permissions: [] }, { participantId: "p" },
      { roomId: "" }, { roomId: 1 }, { roomId: "r".repeat(201) }, { roomId: "room\u0000" }, { roomId: "room\n" }, { roomId: "room\u007f" },
      { objectId: "" }, { objectId: "other" }, { executorSessionId: "remote-browser:other" }, { frameStreamId: "remote-browser:browser-1:frame" },
      { executorInstanceId: "remote-browser:browser-1:instance:" }, { executorInstanceId: "remote-browser:other:instance:x" },
      { executorInstanceId: "generation-1" }, { executorInstanceId: `${payload.executorInstanceId}\u0000` },
      { exp: String(payload.exp) }, { exp: 1.5 }, { exp: nowSeconds + 0.5 }, { exp: 0 }, { exp: -1 }, { exp: null },
      { exp: Number.POSITIVE_INFINITY }, { exp: Number.NaN }, { exp: Number.MAX_SAFE_INTEGER }, { exp: 9_007_199_254_741 }]
      .map(patch => ({ ...payload, ...patch })),
    scoped("o".repeat(201)),
    scoped("browser-1", "i".repeat(513 - "remote-browser:browser-1:instance:".length)),
    scoped("o".repeat(200), "i".repeat(513 - `remote-browser:${"o".repeat(200)}:instance:`.length))
  ];
  for (const claims of invalid) {
    assert.throws(() => encodeRemoteBrowserFrameToken(claims as RemoteBrowserFrameTokenPayload, secret), InvalidRemoteBrowserFrameTokenError);
    assert.equal(accepts(signV2Claims(claims)), false);
  }
  const json = JSON.stringify(payload);
  assert.equal(accepts(signV2Body(b64(json.replace(`"exp":${payload.exp}`, `"exp":1e309`)))), false);
  assert.equal(accepts(signV2Body(b64(json.replace("{", `{"__proto__":{"role":"host"},`)))), false);
  assert.equal(accepts(signV2Body(b64(json.slice(0, -1)))), false);
});

test("legitimate length edges and non-ASCII ids round-trip through the shared binding rules", () => {
  const valid = [
    scoped("browser-1", "generation-1", "r".repeat(200)),
    scoped("o".repeat(200), "3f1c2a9e-8b7d-4c6e-9a1f-0d2b4c6e8a10"),
    scoped("browser-1", "i".repeat(512 - "remote-browser:browser-1:instance:".length)),
    scoped("o".repeat(200), "i".repeat(512 - `remote-browser:${"o".repeat(200)}:instance:`.length)),
    scoped("браузер-1", "поколение-1", "комната")
  ];
  assert.equal(valid[2].executorInstanceId.length, 512);
  assert.equal(valid[3].executorInstanceId.length, 512);
  for (const claims of valid) {
    assert.equal(isRemoteBrowserFrameBinding(claims), true);
    assert.deepEqual(decodeRemoteBrowserFrameToken(encodeRemoteBrowserFrameToken(claims, secret), secret, { nowSeconds }), claims);
  }
  // API bodies carry extra fields; the binding helper checks scope only, exact keys are enforced on token claims.
  assert.equal(isRemoteBrowserFrameBinding({ ...payload, sessionToken: "opaque" }), true);
  for (const bad of [null, "binding", [], without("frameStreamId"), { ...payload, executorSessionId: "remote-browser:other" }]) {
    assert.equal(isRemoteBrowserFrameBinding(bad), false);
  }
});

test("unpaired surrogates are refused so every valid binding encodes within the decoder byte bound", () => {
  const prefixLength = (objectId: string) => `remote-browser:${objectId}:instance:`.length;
  // Each lone surrogate escapes to six JSON bytes: in-limit ids like the first case once encoded to a 10578-byte token.
  const high = "\ud800".repeat(200);
  const lone = [
    scoped(high, "\ud800".repeat(512 - prefixLength(high)), high),
    { ...payload, roomId: "room-\udc00" }, { ...payload, roomId: "\ud83d" }, { ...payload, roomId: "room\ude00\ud83d" },
    scoped("browser-\ud800"), scoped("browser-1", "generation-\udfff")
  ];
  for (const claims of lone) {
    assert.equal(isRemoteBrowserFrameBinding(claims), false);
    assert.throws(() => encodeRemoteBrowserFrameToken(claims, secret), InvalidRemoteBrowserFrameTokenError);
    assert.equal(accepts(signV2Claims(claims)), false);
  }

  // Well-formed ids cost at most three UTF-8 bytes per code unit, so the widest legitimate bindings still fit.
  const wide = "界".repeat(200);
  const emoji = "😀".repeat(100);
  for (const claims of [scoped(wide, "界".repeat(512 - prefixLength(wide)), wide), scoped(emoji, `${"😀".repeat(143)}x`, emoji)]) {
    const token = encodeRemoteBrowserFrameToken(claims, secret);
    assert.equal(claims.executorInstanceId.length, 512);
    assert.equal(isRemoteBrowserFrameBinding(claims), true);
    assert.equal(token.length <= FRAME_TOKEN_MAX_BYTES, true);
    assert.deepEqual(decodeRemoteBrowserFrameToken(token, secret, { nowSeconds }), claims);
  }
});

test("expiry is strict, capped at ttl plus skew, and uses only the caller clock", () => {
  assert.equal(FRAME_TOKEN_MAX_TTL_SECONDS, 600);
  assert.equal(FRAME_TOKEN_CLOCK_SKEW_SECONDS, 30);
  const at = (exp: number) => encodeRemoteBrowserFrameToken({ ...payload, exp }, secret);
  assert.equal(accepts(at(nowSeconds - 1)), false);
  assert.equal(accepts(at(nowSeconds)), false);
  assert.equal(accepts(at(nowSeconds + 1)), true);
  assert.equal(accepts(at(nowSeconds + 7)), true);
  assert.equal(accepts(at(nowSeconds + 630)), true);
  assert.equal(accepts(at(nowSeconds + 631)), false);
  const farFuture = at(Math.floor(Number.MAX_SAFE_INTEGER / 1000));
  assert.equal(accepts(farFuture), false);
  const token = at(nowSeconds + 300);
  for (const clock of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, Number.MAX_SAFE_INTEGER, "1800000000" as unknown as number]) {
    assert.equal(accepts(token, { nowSeconds: clock }), false);
  }
});

test("secrets are required, wrong keys fail closed, and errors never echo inputs", () => {
  const token = encodeRemoteBrowserFrameToken(payload, secret);
  for (const key of ["", "   ", undefined, null, 42]) {
    assert.throws(() => encodeRemoteBrowserFrameToken(payload, key as string),
      (error: unknown) => error instanceof RemoteBrowserFrameTokenConfigError && error.message === "remote_browser_frame_token_config_invalid");
    assert.throws(() => decodeRemoteBrowserFrameToken(token, key as string, { nowSeconds }), RemoteBrowserFrameTokenConfigError);
  }
  assert.equal(decodeRemoteBrowserFrameToken(token, otherSecret, { nowSeconds }), null);
  assert.equal(accepts(signV2Claims(payload, otherSecret)), false);
  assert.throws(() => encodeRemoteBrowserFrameToken({ ...payload, roomId: `leak\u0000${secret}` }, secret),
    (error: unknown) => error instanceof InvalidRemoteBrowserFrameTokenError && error.message === "remote_browser_frame_token_invalid"
      && !error.message.includes(secret) && !String(error.stack).includes(secret));
});
