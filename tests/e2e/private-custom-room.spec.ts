import { expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startReferenceTemplateFixture } from "./reference-template-fixture.js";
import { assertPrivateClip, assertPrivateHeldProp, privateClipFixture } from "./private-clip-fixture.js";

test.use({ trace: "off", screenshot: "off", video: "off" });
test("private custom room: pinned scene loads for the same owner on two devices and stays out of public delivery", async ({
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
  const { model, manifest, artifact, archive, sound } = await privateClipFixture();
  const zip: Buffer = archive ?? createStoredZip([
    { name: "scene.json", content: manifest },
    { name: "scene.glb", content: model },
    ...(sound ? [{ name: sound.path, content: sound.bytes }] : [])
  ]);
  const digest = createHash("sha256").update(zip).digest("hex");
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
        VRATA_PRIVATE_SCENE_APPROVAL: JSON.stringify({
          tenantId: tenant,
          ownerSubject: subject,
          bundleId: "mine",
          version: "v1",
          archiveSha256: digest
        }),
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
    const upload = () =>
      request.post(prefix + "/bundles/mine/versions", {
        headers: headers(),
        multipart: { version: "v1", bundle: { name: "approved.zip", mimeType: "application/zip", buffer: zip } }
      });
    const imported = await upload();
    expect(imported.status(), await imported.text()).toBe(201);
    const v = await imported.json();
    expect((await (await upload()).json()).bundleVersionId).toBe(v.bundleVersionId);
    expect(files.size).toBe(sound ? 3 : 2);
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
    const people = [];
    let lastAsset = "", lastAudio = "",
      lastGrant = "";
    for (let i = 0; i < 2; i++) {
      const client = await browser.newContext();
      try {
        const grant = await permit(subject);
        expect(grant.status()).toBe(201);
        const page = await client.newPage();
        if (sound) await page.addInitScript(() => {
          const probe = { analysers: [] as AnalyserNode[], microphoneRequests: 0 };
          (window as any).__scenePlaybackProbe = probe;
          const connect = AudioNode.prototype.connect;
          AudioNode.prototype.connect = function(this: AudioNode, destination: unknown, ...args: unknown[]) {
            if (this instanceof GainNode && destination instanceof AudioDestinationNode) {
              const a = this.context.createAnalyser();
              Reflect.apply(connect, this, [a]);
              probe.analysers.push(a);
            }
            return Reflect.apply(connect, this, [destination, ...args]);
          } as typeof AudioNode.prototype.connect;
          const mic = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
          navigator.mediaDevices.getUserMedia = constraints => {
            if (constraints?.audio) probe.microphoneRequests++;
            return mic(constraints);
          };
        });
        const issued = await grant.json();
        lastGrant = issued.grantId;
        page.on("response", (r) => {
          if (r.url().includes("/c/") && r.url().endsWith("/scene.glb") && r.status() === 200) lastAsset = r.url();
          if (sound && r.url().includes("/c/") && r.url().endsWith(`/${sound.path}`) && r.status() === 200) lastAudio = r.url();
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
          .toEqual(["loaded", JSON.parse(manifest).label, true]);
        await assertPrivateClip({ page, request, roomId: id, origin, artifact, first: i === 0, adminToken: fixture.adminToken, sound: !!sound });
        if (!archive) {
          const isOn = () => page.evaluate(() => (window as any).__VRATA_DEBUG__.sceneEffects
            .find((effect: { id: string }) => effect.id === "light")?.playing);
          await expect.poll(isOn).toBe(i === 0);
          const canvas = await page.locator("#scene canvas").boundingBox();
          expect(canvas).not.toBeNull();
          const { x, y, width, height } = canvas!;
          const center = [x + width / 2, y + height / 2] as const;
          await page.mouse.move(...center);
          await expect.poll(() => page.evaluate(() => (window as any).__VRATA_DEBUG__.interactionRay.targetKind)).toBe("effect-switch");
          await page.mouse.click(...center);
          await expect.poll(isOn).toBe(i !== 0);
        }
        people.push(await page.evaluate(() => (window as any).__VRATA_DEBUG__.participantId));
        expect(await page.evaluate(() => JSON.stringify((window as any).__VRATA_DEBUG__.sceneDebug).includes("/c/"))).toBe(false);
      } finally {
        await client.close();
      }
    }
    expect(people[0] === people[1] && !!people[0]).toBe(true);
    expect(!!lastAsset).toBe(true);
    const head = await request.head(lastAsset);
    expect(head.status()).toBe(200);
    expect(head.headers()["cache-control"]).toBe("private, no-store");
    if (sound) {
      expect(!!lastAudio).toBe(true);
      const header = await request.head(lastAudio);
      expect(header.status()).toBe(200);
      expect(header.headers()["content-type"]).toBe("audio/wav");
      expect(header.headers()["cache-control"]).toBe("private, no-store");
      expect((await request.get(new URL(`/${sound.path}`, lastAudio).href)).status()).toBe(404);
    }
    expect((await op(path + `/grants/${lastGrant}/revoke`, { reason: "review complete" })).status()).toBe(200);
    expect((await request.head(lastAsset)).status()).toBe(403);
    if (sound) expect((await request.head(lastAudio)).status()).toBe(403);
    if (!archive) await test.step("grip works in the private room with emulated XR", async () => {
      const client = await browser.newContext();
      try {
        const grant = await permit(subject);
        expect(grant.status()).toBe(201);
        const issued = await grant.json();
        const entry = new URL(issued.entryUrl);
        entry.searchParams.set("debug", "1");
        entry.searchParams.set("scenefit", "0");
        entry.searchParams.set("avatarvrmock", "1");
        const page = await client.newPage();
        await page.goto(entry.href);
        await page.locator("#guest-name-input").fill("Recipient");
        await page.locator("#guest-enter-without-audio").click({ noWaitAfter: true });
        await expect.poll(() => page.evaluate(() => {
          const state = (window as any).__VRATA_DEBUG__;
          return state?.personalRoom?.isOwner && state?.sceneEffects?.some((e: { id: string }) => e.id === "tethered");
        }), { timeout: 60_000 }).toBe(true);
        await assertPrivateHeldProp(page);
      } finally {
        await client.close();
      }
    });
  } finally {
    await fixture?.close();
    await new Promise<void>((done) => s3.close(() => done()));
  }
});
