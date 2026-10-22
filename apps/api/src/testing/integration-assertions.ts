import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";

import { INTEGRATION_AUDIENCE, INTEGRATION_SCOPES } from "../integration-auth.js";

export interface IntegrationTestKey {
  kid: string;
  issuer: string;
  privateKey: KeyObject;
  publicJwk: { kty: string; crv: string; x: string };
}

export function createIntegrationTestKey(kid = "portal-test-1", issuer = "portal:stage"): IntegrationTestKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string };
  return { kid, issuer, privateKey, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x } };
}

export function integrationKeysEnv(keys: IntegrationTestKey[], scopes: readonly string[] = INTEGRATION_SCOPES): string {
  return JSON.stringify(keys.map(key => ({ kid: key.kid, issuer: key.issuer, scopes, publicKey: key.publicJwk })));
}

export function signIntegrationAssertion(key: IntegrationTestKey, overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const encodedHeader = encode({ alg: "EdDSA", kid: key.kid, typ: "JWT", ...header });
  const encodedPayload = encode({
    iss: key.issuer,
    aud: INTEGRATION_AUDIENCE,
    iat: now,
    exp: now + 30,
    jti: randomUUID().replaceAll("-", ""),
    scope: [...INTEGRATION_SCOPES],
    ...overrides
  });
  const signature = sign(null, Buffer.from(`${encodedHeader}.${encodedPayload}`), key.privateKey).toString("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}
