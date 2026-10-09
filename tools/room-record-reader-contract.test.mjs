import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("API runtime image label publishes the rollout contract's integer room-record reader", () => {
  const contract = JSON.parse(read("infra/docker/template-rollout.json"));
  assert.equal(typeof contract.roomRecordReader, "number");
  assert(Number.isSafeInteger(contract.roomRecordReader) && contract.roomRecordReader === 2);
  const dockerfile = read("apps/api/Dockerfile");
  const labels = [...dockerfile.matchAll(/^LABEL io\.vrata\.room-record-reader="([^"]*)"$/gm)];
  assert.equal(labels.length, 1);
  assert.equal(labels[0][1], String(contract.roomRecordReader));
  const runtime = dockerfile.indexOf(" AS runtime");
  assert(runtime >= 0 && labels[0].index > runtime, "label must be on the published runtime stage");
});
