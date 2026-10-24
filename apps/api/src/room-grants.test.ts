import assert from "node:assert/strict";
import test from "node:test";

import { createGrantCode, grantCodeHash, grantEntryUrl, isGrantCode } from "./room-grants.js";

test("grant codes carry 256 bits, are hashed under their own key and travel only in an https fragment", () => {
  const code = createGrantCode();
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(createGrantCode(), code);
  assert(isGrantCode(code) && !isGrantCode("short") && !isGrantCode(`${code}!`));
  const hash = grantCodeHash("secret-one-0123456789-0123456789", code);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(grantCodeHash("secret-one-0123456789-0123456789", code), hash);
  assert.notEqual(grantCodeHash("secret-two-0123456789-0123456789", code), hash);
  const roomId = "3f2b8c1e-5a6d-4e7f-9a1b-2c3d4e5f6a7b";
  assert.equal(grantEntryUrl("https://app.example.test/some/path", roomId, code), `https://app.example.test/rooms/${roomId}#grant=${code}`);
  assert.equal(grantEntryUrl("http://app.example.test", roomId, code), null);
  assert.equal(grantEntryUrl("http://127.0.0.1:4000", roomId, code), `http://127.0.0.1:4000/rooms/${roomId}#grant=${code}`);
  assert.equal(grantEntryUrl(undefined, roomId, code), null);
  assert.equal(grantEntryUrl("https://user:pass@app.example.test", roomId, code), null);
});
