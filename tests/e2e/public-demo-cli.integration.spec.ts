import { expect, test } from "@playwright/test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { startReferenceTemplateFixture } from "./reference-template-fixture.js";

type JsonRecord = Record<string, any>;
type Fixture = Awaited<ReturnType<typeof startReferenceTemplateFixture>>;
type PublicDemoModule = {
  PUBLIC_DEMO_SURFACE_ID: string;
  PUBLIC_DEMO_TEMPLATE_ID: string;
  PUBLIC_DEMO_TEMPLATE_VERSION: string;
  checkPublicDemo(options: JsonRecord): Promise<JsonRecord>;
  cleanupPublicDemo(options: JsonRecord): Promise<JsonRecord>;
  publicDemoCleanupRecordPath(stateFile: string): string;
  readPublicDemoState(stateFile: string): Promise<JsonRecord>;
  seedPublicDemo(options: JsonRecord): Promise<JsonRecord>;
  sha256(bytes: Buffer): string;
};

const requireApi = createRequire(resolve("apps/api/package.json"));
const { Pool } = requireApi("pg");
const inviteTtlSeconds = 60 * 60;

test.use({ trace: "off", video: "off", screenshot: "off" });

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function apiJson(fixture: Fixture, path: string, init: RequestInit = {}): Promise<{ response: Response; data: JsonRecord }> {
  const headers = new Headers(init.headers);
  headers.set("x-vrata-admin-token", fixture.adminToken);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(new URL(path, fixture.origin), {
    ...init,
    headers
  });
  const data = await response.json() as JsonRecord;
  return { response, data };
}

test.describe("public demo CLI production core", () => {
  test.describe.configure({ mode: "serial" });
  let fixture: Fixture;
  let demo: PublicDemoModule;
  let postgresUrl: string;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    postgresUrl = process.env.VRATA_TEST_POSTGRES_URL ?? "";
    if (!postgresUrl) throw new Error("VRATA_TEST_POSTGRES_URL is required for public demo CLI integration tests");
    demo = await import(pathToFileURL(resolve("tools/public-demo.mjs")).href) as PublicDemoModule;
    fixture = await startReferenceTemplateFixture(postgresUrl, { devRoleQuery: false });
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await fixture?.close();
  });

  test("seed, rerun, API restart, and redacted cleanup preserve the demo contract", async () => {
    test.setTimeout(180_000);
    const stateDirectory = await mkdtemp(join(tmpdir(), "vrata-public-demo-integration-"));
    const stateFile = join(stateDirectory, "state.json");
    const cleanupRecord = demo.publicDemoCleanupRecordPath(stateFile);
    const coreOptions = { stateFile, adminToken: fixture.adminToken };
    let cleanupFinished = false;

    try {
      const seeded = await demo.seedPublicDemo({
        ...coreOptions,
        baseUrl: fixture.origin,
        inviteTtlSeconds
      });
      expect(seeded).toMatchObject({ status: "prepared", prepared: true, created: true });
      await expect(demo.checkPublicDemo(coreOptions)).resolves.toMatchObject({ status: "prepared", prepared: true });

      const state = await demo.readPublicDemoState(stateFile);
      const adminHeaders = { "x-vrata-admin-token": fixture.adminToken };
      const editedNote = "Integration decision: keep the participant-authenticated demo flow.";
      const noteUpdate = await apiJson(fixture, `/api/rooms/${state.roomId}/notes/shared`, {
        method: "PUT",
        body: JSON.stringify({ content: editedNote })
      });
      expect([200, 201]).toContain(noteUpdate.response.status);
      expect(noteUpdate.data.note.content).toBe(editedNote);

      const rerun = await demo.seedPublicDemo({ ...coreOptions, baseUrl: fixture.origin, inviteTtlSeconds });
      expect(rerun).toMatchObject({ status: "prepared", prepared: true, created: false, runId: state.runId });
      const noteAfterRerun = await apiJson(fixture, `/api/rooms/${state.roomId}/notes/shared`);
      expect(noteAfterRerun.response.status).toBe(200);
      expect(noteAfterRerun.data.note.content).toBe(editedNote);

      const roomResult = await apiJson(fixture, `/api/rooms/${state.roomId}`);
      expect(roomResult.response.status).toBe(200);
      expect(roomResult.data).toMatchObject({
        roomId: state.roomId,
        tenantId: state.tenantId,
        roomType: "standard",
        visibility: "private",
        guestAllowed: true,
        templateId: demo.PUBLIC_DEMO_TEMPLATE_ID,
        templateVersion: demo.PUBLIC_DEMO_TEMPLATE_VERSION,
        templateSnapshot: { templateId: demo.PUBLIC_DEMO_TEMPLATE_ID, version: demo.PUBLIC_DEMO_TEMPLATE_VERSION }
      });

      const invitesResult = await apiJson(fixture, `/api/rooms/${state.roomId}/invites`);
      expect(invitesResult.response.status).toBe(200);
      expect(invitesResult.data.items).toHaveLength(4);
      const expectedExpiry = new Date(Date.parse(state.createdAt) + inviteTtlSeconds * 1000).toISOString();
      for (const planned of state.resources.invites) {
        const invite = invitesResult.data.items.find((item: JsonRecord) => item.inviteId === planned.inviteId);
        expect(invite).toMatchObject({ roomId: state.roomId, role: planned.role, expiresAt: expectedExpiry, revokedAt: null });
      }
      expect(state.resources.invites.map((invite: JsonRecord) => invite.role)).toEqual(["host", "member", "member", "guest"]);

      const documentsResult = await apiJson(fixture, `/api/rooms/${state.roomId}/documents`);
      expect(documentsResult.response.status).toBe(200);
      expect(documentsResult.data.items).toHaveLength(1);
      const document = documentsResult.data.items[0];
      expect(document).toMatchObject({
        documentId: state.resources.document.documentId,
        roomId: state.roomId,
        tenantId: state.tenantId,
        filename: state.expected.document.filename,
        contentType: "application/pdf",
        checksum: state.expected.document.checksum,
        linkedSurfaceId: demo.PUBLIC_DEMO_SURFACE_ID,
        metadata: { kind: "pdf", pageCount: 3 }
      });
      const blobPath = join(fixture.documentStorageRoot, "documents", state.tenantId, state.roomId, document.documentId, document.filename);
      expect(await exists(blobPath)).toBe(true);
      const download = await fetch(new URL(document.downloadUrl, fixture.origin), { headers: adminHeaders });
      expect(download.status).toBe(200);
      expect(`sha256:${demo.sha256(Buffer.from(await download.arrayBuffer()))}`).toBe(state.expected.document.checksum);

      await fixture.restartApi();
      await expect(demo.checkPublicDemo(coreOptions)).resolves.toMatchObject({ status: "prepared", runId: state.runId });
      const persistedNote = await apiJson(fixture, `/api/rooms/${state.roomId}/notes/shared`);
      expect(persistedNote.data.note.content).toBe(editedNote);
      const persistedDocuments = await apiJson(fixture, `/api/rooms/${state.roomId}/documents`);
      expect(persistedDocuments.data.items).toHaveLength(1);
      expect(persistedDocuments.data.items[0]).toMatchObject({
        documentId: document.documentId,
        checksum: document.checksum,
        linkedSurfaceId: demo.PUBLIC_DEMO_SURFACE_ID,
        metadata: document.metadata
      });

      const cleaned = await demo.cleanupPublicDemo(coreOptions);
      expect(cleaned).toMatchObject({ status: "cleaned", cleaned: true, cleanupRecord });
      expect(await exists(stateFile)).toBe(false);
      const recordText = await readFile(cleanupRecord, "utf8");
      expect(recordText).not.toContain("inviteLink");
      expect(recordText).not.toContain("?invite=");
      const cleanedAgain = await demo.cleanupPublicDemo({ stateFile: cleanupRecord, adminToken: fixture.adminToken });
      expect(cleanedAgain).toMatchObject({ status: "cleaned", cleaned: true, cleanupRecord });
      cleanupFinished = true;

      const tenantsAfterCleanup = await apiJson(fixture, "/api/tenants");
      expect(tenantsAfterCleanup.response.status).toBe(200);
      expect(tenantsAfterCleanup.data.items.some((tenant: JsonRecord) => tenant.tenantId === state.tenantId)).toBe(false);
      const roomAfterCleanup = await apiJson(fixture, `/api/rooms/${state.roomId}`);
      expect(roomAfterCleanup.response.status).toBe(404);
      expect(roomAfterCleanup.data.error).toBe("room_not_found");
      expect(await exists(blobPath)).toBe(false);
      const database = new Pool({ connectionString: postgresUrl });
      try {
        const rows = await database.query(
          `select
             (select count(*)::integer from "${fixture.schema}".tenants where tenant_id = $1) as tenant_count,
             (select count(*)::integer from "${fixture.schema}".rooms where room_id = $2) as room_count`,
          [state.tenantId, state.roomId]
        );
        expect(rows.rows[0]).toEqual({ tenant_count: 0, room_count: 0 });
      } finally {
        await database.end();
      }
    } finally {
      if (!cleanupFinished) {
        const cleanupInput = await exists(stateFile) ? stateFile : await exists(cleanupRecord) ? cleanupRecord : null;
        if (cleanupInput) await demo.cleanupPublicDemo({ stateFile: cleanupInput, adminToken: fixture.adminToken });
      }
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
