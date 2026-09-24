import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("YCR publish emits readable single-image manifests without attestations", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/docker-publish.yml"), "utf8");

  assert.equal(workflow.match(/^\s+uses: docker\/build-push-action@v6$/gm)?.length, 5);
  assert.equal(workflow.match(/^\s+provenance: false$/gm)?.length, 5);
  assert.equal(workflow.match(/^\s+sbom: false$/gm)?.length, 5);
  assert.match(workflow, /name: Verify published YCR manifests/);
  assert.match(workflow, /docker buildx imagetools inspect "\$image:\$tag"/);
  assert.match(workflow, /file: infra\/docker\/minio\.demo-local\.Dockerfile/);
  assert.match(workflow, /file: infra\/docker\/mc\.demo-local\.Dockerfile/);
  assert.match(workflow, /imagetools inspect "\$MINIO_IMAGE:5cb1e6309f2bd70e7d0ca77f33782beac1745790deb4c1f94444f1e7dec5fcb6"/);
  assert.match(workflow, /imagetools inspect "\$MC_IMAGE:a92b5f1af200ca25d54d78432ef6b0c47fd4340abf9759ce5d10275cd57e3318"/);
});
