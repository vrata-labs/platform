import assert from "node:assert/strict";
import test from "node:test";

import type { AssetRecord, Storage } from "./storage-contracts.js";
import { validateAssetInput, validateRoomAssetIds } from "./room-asset-validation.js";

type Template = NonNullable<Awaited<ReturnType<Storage["getTemplateVersion"]>>>;
const asset = (assetId: string, fields: Partial<AssetRecord> = {}): AssetRecord => ({
  assetId, tenantId: "tenant", kind: "model", url: "model.glb", ...fields
});
// The validator only reads assetSlots; no template or storage is initialized.
const template = (...assetSlots: string[]): Template => ({ assetSlots }) as Template;
function fixture(assets: AssetRecord[] = [], selectedTemplate: Template | null = null) {
  const calls: unknown[][] = [];
  const methods: Pick<Storage, "listAssets" | "getTemplateVersion"> = {
    async listAssets() { calls.push(["assets"]); return assets; },
    async getTemplateVersion(id, version) { calls.push(["template", id, version]); return selectedTemplate; }
  };
  return { calls, methods, storage: methods as Storage };
}

test("empty room asset lists do not read assets or templates", async () => {
  const { storage, calls } = fixture();
  assert.equal(await validateRoomAssetIds(storage, undefined, "template", "v2"), null);
  assert.equal(await validateRoomAssetIds(storage, [], "template", "v2"), null);
  assert.deepEqual(calls, []);
});

test("missing asset references are rejected with exact identifier matching", async () => {
  const { storage } = fixture([asset("model")]);
  for (const id of ["missing", "MODEL", " model", "model ", ""]) {
    assert.equal(await validateRoomAssetIds(storage, [id]), "invalid_asset_reference");
  }
});

test("validated, pending and unspecified statuses remain attachable", async () => {
  const { storage, calls } = fixture([
    asset("valid", { validationStatus: "validated" }),
    asset("pending", { validationStatus: "pending" }),
    asset("unspecified")
  ]);
  const ids = ["valid", "pending", "unspecified", "valid"];
  assert.equal(await validateRoomAssetIds(storage, ids), null);
  assert.deepEqual(calls, [["assets"]]);
  assert.deepEqual(ids, ["valid", "pending", "unspecified", "valid"]);
});

test("rejected assets are not attachable even when the template accepts their kind", async () => {
  const { storage } = fixture([asset("model", { validationStatus: "rejected" })], template("model"));
  assert.equal(await validateRoomAssetIds(storage, ["model"], "room"), "rejected_asset_not_attachable");
});

test("template slot membership is exact and empty slots reject all kinds", async () => {
  for (const slots of [[], ["MODEL"], [" model"], ["image"]]) {
    const { storage } = fixture([asset("model")], template(...slots));
    assert.equal(await validateRoomAssetIds(storage, ["model"], "room"), "asset_kind_not_supported_by_template");
  }
  const { storage } = fixture([asset("model")], template("image", "model"));
  assert.equal(await validateRoomAssetIds(storage, ["model"], "room"), null);
});

test("a missing template leaves asset kind validation unchanged", async () => {
  const { storage, calls } = fixture([asset("model")]);
  assert.equal(await validateRoomAssetIds(storage, ["model"], "absent", "v9"), null);
  assert.deepEqual(calls, [["assets"], ["template", "absent", "v9"]]);
});

test("falsy template identifiers skip lookup while whitespace is passed through", async () => {
  for (const templateId of [undefined, ""]) {
    const { storage, calls } = fixture([asset("model")], template());
    assert.equal(await validateRoomAssetIds(storage, ["model"], templateId, "v2"), null);
    assert.deepEqual(calls, [["assets"]]);
  }
  const { storage, calls } = fixture([asset("model")], template("model"));
  assert.equal(await validateRoomAssetIds(storage, ["model"], " ", " v2 "), null);
  assert.deepEqual(calls, [["assets"], ["template", " ", " v2 "]]);
});

test("the template version is forwarded and assets are read before the template", async () => {
  const { storage, calls } = fixture([asset("model")], template("model"));
  assert.equal(await validateRoomAssetIds(storage, ["model"], "room", "v3"), null);
  assert.deepEqual(calls, [["assets"], ["template", "room", "v3"]]);
});

test("asset loading is awaited before template lookup", async () => {
  const { storage, methods, calls } = fixture([], template("model"));
  let release!: (assets: AssetRecord[]) => void;
  methods.listAssets = () => {
    calls.push(["assets"]);
    return new Promise<AssetRecord[]>((resolve) => { release = resolve; });
  };
  const result = validateRoomAssetIds(storage, ["model"], "room");
  assert.deepEqual(calls, [["assets"]]);
  release([asset("model")]);
  assert.equal(await result, null);
  assert.deepEqual(calls, [["assets"], ["template", "room", undefined]]);
});

test("template lookup precedes rejection of an unknown asset", async () => {
  const { storage, calls } = fixture();
  assert.equal(await validateRoomAssetIds(storage, ["missing"], "room"), "invalid_asset_reference");
  assert.deepEqual(calls, [["assets"], ["template", "room", undefined]]);
});

test("the first failing reference wins and rejection precedes kind validation", async () => {
  const { storage } = fixture([
    asset("rejected", { validationStatus: "rejected", kind: "image" }),
    asset("wrong-kind", { kind: "image" })
  ], template("model"));
  assert.equal(await validateRoomAssetIds(storage, ["missing", "rejected"], "room"), "invalid_asset_reference");
  assert.equal(await validateRoomAssetIds(storage, ["rejected", "missing"], "room"), "rejected_asset_not_attachable");
  assert.equal(await validateRoomAssetIds(storage, ["wrong-kind", "rejected"], "room"), "asset_kind_not_supported_by_template");
});

test("duplicate storage identifiers keep the last record as before", async () => {
  const rejected = asset("same", { validationStatus: "rejected" });
  const allowed = asset("same");
  assert.equal(await validateRoomAssetIds(fixture([rejected, allowed]).storage, ["same"]), null);
  assert.equal(await validateRoomAssetIds(fixture([allowed, rejected]).storage, ["same"]), "rejected_asset_not_attachable");
});

test("storage failures propagate unchanged and prevent later calls", async () => {
  for (const error of [new Error("storage unavailable"), "failure", null]) {
    const { storage, methods, calls } = fixture();
    methods.listAssets = async () => { throw error; };
    await assert.rejects(validateRoomAssetIds(storage, ["model"], "room"), (actual: unknown) => actual === error);
    assert.deepEqual(calls, []);
  }
});

test("template lookup failures are not replaced with asset validation errors", async () => {
  const { storage, methods, calls } = fixture();
  const error = new Error("template unavailable");
  methods.getTemplateVersion = async () => { throw error; };
  await assert.rejects(validateRoomAssetIds(storage, ["missing"], "room"), (actual: unknown) => actual === error);
  assert.deepEqual(calls, [["assets"]]);
});

test("room validation does not mutate the supplied records, template or identifiers", async () => {
  const records = [Object.freeze(asset("model"))];
  Object.freeze(records);
  const selected = template("model");
  Object.freeze(selected.assetSlots);
  Object.freeze(selected);
  const ids = ["model", "model"];
  Object.freeze(ids);
  const { storage } = fixture(records, selected);
  assert.equal(await validateRoomAssetIds(storage, ids, "room"), null);
  assert.deepEqual(records, [asset("model")]);
  assert.deepEqual(selected.assetSlots, ["model"]);
  assert.deepEqual(ids, ["model", "model"]);
});

test("asset input preserves missing URL and missing filename errors", () => {
  assert.equal(validateAssetInput({}), "invalid_asset_url");
  assert.equal(validateAssetInput({ url: "" }), "invalid_asset_url");
  for (const url of ["/", "https://example.test/", "models/"]) {
    assert.equal(validateAssetInput({ url }), "missing_filename");
  }
});

test("asset input accepts the existing three extensions without imposing a URL scheme", () => {
  for (const url of ["model.glb", "model.GLTF", "texture.KtX2", ".glb", "https://example.test/a.b.glb", "relative/model.gltf"]) {
    assert.equal(validateAssetInput(Object.freeze({ url })), null, url);
  }
});

test("asset input keeps the current treatment of queries, fragments, whitespace and encoded extensions", () => {
  for (const url of ["model", "model.fbx", "model.glb.exe", "model.glb?x=1", "model.glb#part", "model.glb ", "model%2Eglb", " "]) {
    assert.equal(validateAssetInput({ url }), "unsupported_extension", url);
  }
  // The current validator checks the final suffix, not URL semantics.
  assert.equal(validateAssetInput({ url: "model.txt?name=model.glb" }), null);
  assert.equal(validateAssetInput({ url: "model.txt#model.gltf" }), null);
});
