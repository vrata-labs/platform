import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("YCR publish emits readable single-image manifests without attestations", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/docker-publish.yml"), "utf8");

  assert.equal(workflow.match(/^\s+uses: docker\/build-push-action@v6$/gm)?.length, 3);
  assert.equal(workflow.match(/^\s+provenance: false$/gm)?.length, 3);
  assert.equal(workflow.match(/^\s+sbom: false$/gm)?.length, 3);
  assert.match(workflow, /name: Verify published YCR manifests/);
  assert.match(workflow, /docker buildx imagetools inspect "\$image:\$tag"/);
});
