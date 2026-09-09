import test from "node:test";
import assert from "node:assert/strict";

import { redactSecrets } from "./diagnostics-redaction.js";

const redacted = "[redacted]";

for (const key of ["authorization", "cookie", "password", "secret", "token", "invite"]) {
  test(`sensitive ${key} keys are masked irrespective of case, nesting and value type`, () => {
    for (const name of [key, key.toUpperCase(), `nested_${key}_value`]) {
      for (const value of [undefined, null, false, 42, "opaque", { nested: "value" }, ["value"]]) {
        assert.equal(redactSecrets(value, name), redacted);
        assert.deepEqual(redactSecrets({ [name]: value }), { [name]: redacted });
        assert.deepEqual(redactSecrets([{ [name]: value }]), [{ [name]: redacted }]);
      }
    }
  });
}

test("ordinary primitives and strings retain their original values", () => {
  for (const value of [undefined, null, true, false, 0, -0, 42, "", "hello", "token is a field name"]) {
    assert.equal(redactSecrets(value), value);
  }
});

test("nested JSON is copied and masked without changing the input", () => {
  const input = Object.freeze({
    event: "diagnostic",
    detail: Object.freeze({ accessToken: "opaque", roomId: "room-1" }),
    samples: Object.freeze([Object.freeze({ password: "opaque", value: 1 }), "visible"])
  });
  const output = redactSecrets(input);
  assert.deepEqual(output, {
    event: "diagnostic",
    detail: { accessToken: redacted, roomId: "room-1" },
    samples: [{ password: redacted, value: 1 }, "visible"]
  });
  assert.equal(input.detail.accessToken, "opaque");
  assert.equal(input.samples[0] && typeof input.samples[0] === "object" && input.samples[0].password, "opaque");
  assert.notEqual(output, input);
});

for (const key of ["authorization", "password", "secret", "token", "invite"]) {
  test(`absolute URL ${key} parameters are masked while other fields remain`, () => {
    const input = `https://example.test/rooms?${key}=opaque&room=room-1#details`;
    const output = redactSecrets(input);
    assert.equal(typeof output, "string");
    const parsed = new URL(output as string);
    assert.equal(parsed.searchParams.get(key), redacted);
    assert.equal(parsed.searchParams.get("room"), "room-1");
    assert.equal(parsed.hash, "#details");
    assert.equal(parsed.origin, "https://example.test");
  });
}

test("URL sanitization includes all matching keys once its query guard matches", () => {
  const output = redactSecrets("https://example.test/?TOKEN=one&cookie=two&access_token=three&room=room-1") as string;
  const params = new URL(output).searchParams;
  assert.equal(params.get("TOKEN"), redacted);
  assert.equal(params.get("cookie"), redacted);
  assert.equal(params.get("access_token"), redacted);
  assert.equal(params.get("room"), "room-1");
});

test("duplicate sensitive URL parameters retain existing URLSearchParams normalization", () => {
  assert.equal(
    redactSecrets("https://example.test/?token=first&token=second&room=room-1"),
    "https://example.test/?token=%5Bredacted%5D&room=room-1"
  );
});

test("relative and malformed URLs preserve the existing fallback replacement", () => {
  assert.equal(redactSecrets("/rooms?token=opaque&room=room-1"), "/rooms?token=[redacted]&room=room-1");
  assert.equal(redactSecrets("https://[invalid?password=opaque&safe=yes"), "https://[invalid?password=[redacted]&safe=yes");
  assert.equal(redactSecrets("text?invite=opaque&token=other"), "text?invite=[redacted]&token=[redacted]");
});

test("URLs without a matching guard are returned byte-for-byte", () => {
  for (const input of [
    "https://EXAMPLE.test:443/room?item=%2f&count=1",
    "/room?view=debug",
    "https://example.test/room#token=fragment",
    "https://example.test/?access_token=opaque",
    "https://example.test/?cookie=opaque"
  ]) {
    // Characterize the existing guard; this extraction does not broaden it.
    assert.equal(redactSecrets(input), input);
  }
});

test("JWT-shaped strings preserve the existing greater-than-80-character threshold", () => {
  const long = `${"a".repeat(39)}.${"b".repeat(39)}.c`;
  const short = `${"a".repeat(38)}.${"b".repeat(39)}.c`;
  assert.equal(long.length, 81);
  assert.equal(short.length, 80);
  assert.equal(redactSecrets(long), redacted);
  assert.equal(redactSecrets(short), short);
  assert.deepEqual(redactSecrets({ message: long, values: [long] }), { message: redacted, values: [redacted] });
  assert.equal(redactSecrets(`${long}=`), `${long}=`);
  assert.equal(redactSecrets(`Bearer ${long}`), `Bearer ${long}`);
});

test("masking already sanitized JSON is stable", () => {
  const input = { token: redacted, nested: [{ password: redacted }], url: "https://example.test/?token=%5Bredacted%5D" };
  const once = redactSecrets(input);
  assert.deepEqual(redactSecrets(once), once);
});
