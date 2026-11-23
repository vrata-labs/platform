import { expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startReferenceTemplateFixture } from "./reference-template-fixture.js";

test.use({ trace: "off", screenshot: "off", video: "off" });
test("private custom room: the same owner can reload after a guarded scene replacement and rollback", async ({
  browser,
  request
}) => {
  test.setTimeout(200_000);
  const load = (p: string) => import(pathToFileURL(resolve(`apps/api/dist/${p}.js`)).href);
  const { createStoredZip } = await load("stored-zip");
  const { createIntegrationTestKey, integrationKeysEnv, signIntegrationAssertion } = await load("testing/integration-assertions");
  const key = createIntegrationTestKey();
  const tenant = "pt_01JBQ7Z8K3M4N5P6Q7R8S9T0VW",
    subject = "acct_01JBQ7Z8K3M4N5P6Q7R8S9T0VW";
  const meshData = Buffer.from(new Float32Array([-1, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const gltf = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: meshData.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: meshData.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-1, 0, 0], max: [1, 1, 0] }]
  };
  const text = JSON.stringify(gltf),
    chunk = Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4, " "));
  const model = Buffer.alloc(28 + chunk.length + meshData.length);
  [0x46546c67, 2, model.length, chunk.length, 0x4e4f534a].forEach((v, i) => model.writeUInt32LE(v, i * 4));
  chunk.copy(model, 20);
  model.writeUInt32LE(meshData.length, 20 + chunk.length);
  model.writeUInt32LE(0x004e4942, 24 + chunk.length);
  meshData.copy(model, 28 + chunk.length);
  const manifest = JSON.stringify({
    schemaVersion: 1,
    sceneId: "private-fixture",
    label: "Private fixture",
    source: "test",
    glbPath: "scene.glb",
    spawnPoints: [{ id: "main", position: { x: 0, y: 0, z: 3 }, yaw: 0 }],
    bounds: { width: 5, height: 4, depth: 5 }
  });
  const zip: Buffer = createStoredZip([
    { name: "scene.json", content: manifest },
    { name: "scene.glb", content: model }
  ]);
  const digest = createHash("sha256").update(zip).digest("hex");
  const nextLabel = "Private fixture updated";
  const nextZip: Buffer = createStoredZip([
    { name: "scene.json", content: JSON.stringify({ ...JSON.parse(manifest), label: nextLabel }) },
    { name: "scene.glb", content: model }
  ]);
  const nextDigest = createHash("sha256").update(nextZip).digest("hex");
  const approval = (version: string, archiveSha256: string) =>
    JSON.stringify({ tenantId: tenant, ownerSubject: subject, bundleId: "mine", version, archiveSha256 });
  const files = new Map<string, Buffer>();
  const s3 = createServer(async (req, res) => {
    if (!req.headers.authorization?.startsWith("AWS4-HMAC-SHA256 Credential=fixture/")) {
      res.writeHead(403).end();
      return;
    }
    const path = req.url!;
    if (req.method === "PUT" && req.headers["if-none-match"] === "*") {
      if (files.has(path)) {
        res.writeHead(412).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      files.set(path, Buffer.concat(chunks));
      res.writeHead(200).end();
      return;
    }
    const b = files.get(path);
    res.writeHead(req.method === "GET" && b ? 200 : 404).end(b);
  });
  await new Promise<void>((ok) => s3.listen(0, "127.0.0.1", ok));
  const s3Url = `http://127.0.0.1:${(s3.address() as { port: number }).port}`;
  let fixture: Awaited<ReturnType<typeof startReferenceTemplateFixture>> | undefined;
  try {
    fixture = await startReferenceTemplateFixture(process.env.VRATA_TEST_POSTGRES_URL!, {
      identityProtocol: 2,
      devRoleQuery: false,
      extraEnv: (origin) => ({
        VRATA_PORTAL_MANAGED: "true",
        VRATA_ADHOC_ROOMS: "false",
        VRATA_INTEGRATION_KEYS: integrationKeysEnv([key]),
        RUNTIME_BASE_URL: origin,
        VRATA_PRIVATE_ASSET_ORIGIN: origin.replace("127.0.0.1", "localhost"),
        VRATA_PRIVATE_SCENE_APPROVAL: approval("v1", digest),
        VRATA_PRIVATE_SCENE_S3_ENDPOINT: s3Url,
        VRATA_PRIVATE_SCENE_S3_BUCKET: "private-fixture",
        VRATA_PRIVATE_SCENE_S3_ACCESS_KEY: "fixture",
        VRATA_PRIVATE_SCENE_S3_SECRET: randomUUID()
      })
    });
    const origin = fixture.origin,
      prefix = `${origin}/integration/v1/tenants/${tenant}`;
    const headers = (id = randomUUID()) => ({ authorization: `Bearer ${signIntegrationAssertion(key)}`, "idempotency-key": id });
    const op = (path: string, data: unknown, id?: string) => request.post(prefix + path, { data, headers: headers(id) });
    expect((await request.put(prefix, { data: { displayName: "Assigned" }, headers: headers() })).status()).toBe(200);
    const upload = (version = "v1", buffer = zip) =>
      request.post(prefix + "/bundles/mine/versions", {
        headers: headers(),
        multipart: { version, bundle: { name: "approved.zip", mimeType: "application/zip", buffer } }
      });
    const imported = await upload();
    expect(imported.status(), await imported.text()).toBe(201);
    const v = await imported.json();
    expect((await (await upload()).json()).bundleVersionId).toBe(v.bundleVersionId);
    expect(files.size).toBe(2);
    const result = await op("/rooms", {
      kind: "custom",
      name: "Private fixture",
      ownerSubject: subject,
      bundleVersionId: v.bundleVersionId,
      visibility: "private",
      accessUntil: new Date(Date.now() + 3600_000).toISOString()
    });
    expect(result.status(), await result.text()).toBe(201);
    const id = (await result.json()).roomId,
      path = `/rooms/${id}`;
    const permit = (account: string) => op(path + "/grants", { role: "host", purpose: "visit", subject: account });
    expect((await permit(subject)).status()).toBe(400);
    const body = { bundleVersionId: v.bundleVersionId, expectedPublishedVersionId: null },
      k = randomUUID();
    expect((await op(path + "/publish", body, k)).status()).toBe(200);
    expect((await op(path + "/publish", body, k)).status()).toBe(200);
    expect((await op(path + "/publish", body)).status()).toBe(412);
    expect((await permit("acct_01JBQ7Z8K3M4N5P6Q7R8S9T0VX")).status()).toBe(400);
    expect((await request.post(origin + `/api${path}/delivery-descriptor`)).status()).toBeGreaterThanOrEqual(400);
    const anonManifest = await request.get(origin + `/api${path}/manifest`);
    expect([403, 404, 409]).toContain(anonManifest.status());
    expect((await anonManifest.text()).includes(v.contentHash)).toBe(false);
    expect((await request.get(s3Url + [...files.keys()][0])).status()).toBe(403);
    let lastAsset = "",
      lastGrant = "";
    const visit = async (label: string) => {
      const client = await browser.newContext();
      try {
        const grant = await permit(subject);
        expect(grant.status()).toBe(201);
        const page = await client.newPage();
        const issued = await grant.json();
        lastGrant = issued.grantId;
        page.on("response", (r) => {
          if (r.url().includes("/c/") && r.url().endsWith("/scene.glb") && r.status() === 200) lastAsset = r.url();
        });
        await page.goto(issued.entryUrl);
        await page.locator("#guest-name-input").fill("Recipient");
        await page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
        await expect
          .poll(
            () =>
              page.evaluate(() => {
                const d = (window as any).__VRATA_DEBUG__;
                return [d?.sceneDebug?.state, d?.sceneDebug?.label, d?.personalRoom?.isOwner];
              }),
            { timeout: 60_000 }
          )
          .toEqual(["loaded", label, true]);
        expect(await page.evaluate(() => JSON.stringify((window as any).__VRATA_DEBUG__.sceneDebug).includes("/c/"))).toBe(false);
        return await page.evaluate(() => (window as any).__VRATA_DEBUG__.participantId);
      } finally {
        await client.close();
      }
    };
    const person = await visit("Private fixture");
    expect(!!person).toBe(true);
    expect(await visit("Private fixture")).toBe(person);
    expect(!!lastAsset).toBe(true);
    const head = await request.head(lastAsset);
    expect(head.status()).toBe(200);
    expect(head.headers()["cache-control"]).toBe("private, no-store");
    const earlierAsset = lastAsset;
    await fixture.restartApi({ VRATA_PRIVATE_SCENE_APPROVAL: approval("v2", nextDigest) });
    expect((await upload("v2", zip)).status()).toBe(409);
    const next = await upload("v2", nextZip);
    expect(next.status(), await next.text()).toBe(201);
    const updated = await next.json();
    expect((await op(path + "/publish", { bundleVersionId: updated.bundleVersionId, expectedPublishedVersionId: randomUUID() })).status()).toBe(412);
    expect((await request.head(earlierAsset)).status()).toBe(200);
    const replacement = { bundleVersionId: updated.bundleVersionId, expectedPublishedVersionId: v.bundleVersionId };
    const apply = randomUUID();
    const replaced = await op(path + "/publish", replacement, apply);
    expect(replaced.status(),await replaced.text()).toBe(200);
    expect(await replaced.json()).toMatchObject({ roomId:id, ownerSubject:subject, publishedVersionId:updated.bundleVersionId, scene:{contentHash:updated.contentHash} });
    expect((await op(path + "/publish", replacement, apply)).status()).toBe(200);
    expect((await op(path + "/publish", replacement)).status()).toBe(412);
    expect((await request.head(earlierAsset)).status()).toBe(403);
    expect(await visit(nextLabel)).toBe(person);
    const replacedAsset = lastAsset;
    await fixture.restartApi({ VRATA_PRIVATE_SCENE_APPROVAL: approval("v1", digest) });
    const rollback = await op(path + "/publish", {bundleVersionId:v.bundleVersionId,expectedPublishedVersionId:updated.bundleVersionId});
    expect(rollback.status(),await rollback.text()).toBe(200);
    expect((await rollback.json()).publishedVersionId).toBe(v.bundleVersionId);
    expect((await request.head(replacedAsset)).status()).toBe(403);
    expect(await visit("Private fixture")).toBe(person);
    expect((await op(path + `/grants/${lastGrant}/revoke`, { reason: "review complete" })).status()).toBe(200);
    expect((await request.head(lastAsset)).status()).toBe(403);
  } finally {
    await fixture?.close();
    await new Promise<void>((done) => s3.close(() => done()));
  }
});
