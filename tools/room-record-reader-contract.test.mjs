import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the API image declares terminal media eviction required by floor-two rollback", () => {
  const contract = JSON.parse(read("infra/docker/template-rollout.json"));
  assert.equal(contract.mediaScreenReconciler, 2);
  const dockerfile = read("apps/api/Dockerfile");
  const labels = [...dockerfile.matchAll(/^LABEL io\.vrata\.media-screen-reconciler="([^"]*)"$/gm)];
  assert.equal(labels.length, 1); assert.equal(labels[0][1], "2");
  assert(labels[0].index > dockerfile.indexOf(" AS runtime"));
});

test("the paired API/runtime image declares the exact scoped-media identity codec", () => {
  const contract = JSON.parse(read("infra/docker/template-rollout.json"));
  assert.equal(contract.mediaIdentityCodec, 2);
  const dockerfile = read("apps/api/Dockerfile");
  const labels = [...dockerfile.matchAll(/^LABEL io\.vrata\.media-identity-codec="([^"]*)"$/gm)];
  assert.equal(labels.length, 1);
  assert.equal(labels[0][1], String(contract.mediaIdentityCodec));
  assert(labels[0].index > dockerfile.indexOf(" AS runtime"));
  assert.match(dockerfile, /COPY --from=build \/app\/apps\/runtime-web\/dist \.\/apps\/runtime-web\/dist/);
});

test("the API image declares the media codec boundary it enforces on rollout and rollback", () => {
  const contract = JSON.parse(read("infra/docker/template-rollout.json"));
  assert.equal(contract.mediaCodecBoundary, 3);
  const dockerfile = read("apps/api/Dockerfile");
  const labels = [...dockerfile.matchAll(/^LABEL io\.vrata\.media-codec-boundary="([^"]*)"$/gm)];
  assert.equal(labels.length, 1);
  assert.equal(labels[0][1], String(contract.mediaCodecBoundary));
  assert(labels[0].index > dockerfile.indexOf(" AS runtime"));
});

test("the API image declares that it issues in a rotated media namespace and retires the previous ones", () => {
  const contract = JSON.parse(read("infra/docker/template-rollout.json"));
  assert.equal(contract.mediaNamespaceRotation, 1);
  const dockerfile = read("apps/api/Dockerfile");
  const labels = [...dockerfile.matchAll(/^LABEL io\.vrata\.media-namespace-rotation="([^"]*)"$/gm)];
  assert.equal(labels.length, 1);
  assert.equal(labels[0][1], String(contract.mediaNamespaceRotation));
  assert(labels[0].index > dockerfile.indexOf(" AS runtime"));
});

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

test("API and remote-browser runtime images publish the rollout contract's exact frame-token codec", () => {
  const contract = JSON.parse(read("infra/docker/template-rollout.json"));
  assert.equal(typeof contract.frameTokenCodec, "number");
  assert(Number.isSafeInteger(contract.frameTokenCodec) && contract.frameTokenCodec === 2);
  for (const path of ["apps/api/Dockerfile", "apps/remote-browser/Dockerfile"]) {
    const dockerfile = read(path);
    const labels = [...dockerfile.matchAll(/^LABEL io\.vrata\.frame-token-codec="([^"]*)"$/gm)];
    assert.equal(labels.length, 1, path);
    assert.equal(labels[0][1], String(contract.frameTokenCodec), path);
    const runtime = dockerfile.indexOf(" AS runtime");
    assert(runtime >= 0 && labels[0].index > runtime, `${path} label must be on the published runtime stage`);
  }
  const shared = JSON.parse(read("packages/shared-types/package.json"));
  assert.equal(shared.exports["."].import, "./dist/index.js");
  assert.doesNotMatch(read("packages/shared-types/src/index.ts"), /remote-browser-frame-token/, "the Node-only codec stays off the browser types entry");
});
