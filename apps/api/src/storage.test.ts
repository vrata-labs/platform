import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import { MemoryStorage, PostgresStorage, initPostgresStorageWithRetry } from "./storage.js";

interface FakeTemplateRow {
  template_id: string;
  label: string;
  asset_slots: string[];
  current_version: string | null;
  status: string | null;
}

function stableTestJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("value_not_json_serializable");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(stableTestJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableTestJson(entryValue)}`)
    .join(",")}}`;
}

function templateVersionHash(snapshot: unknown): string {
  return createHash("sha256").update(stableTestJson(snapshot)).digest("hex");
}

function createPostgresInitPool(options: {
  extraTemplates?: FakeTemplateRow[];
  versions?: Array<{ templateId: string; version: string; snapshot: unknown; contentHash: string }>;
  constraintDefinition?: Record<string, unknown>;
  functionDefinition?: Record<string, unknown>;
  triggerDefinition?: Record<string, unknown>;
  tableSchema?: string;
  versionReadErrorOnce?: Error;
} = {}) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  let releaseCount = 0;
  let directPoolQueryCount = 0;
  let versionReadError = options.versionReadErrorOnce;
  const templates = new Map<string, FakeTemplateRow>((options.extraTemplates ?? []).map((template) => [template.template_id, structuredClone(template)]));
  const versions = new Map<string, { snapshot: unknown; content_hash: string }>(
    (options.versions ?? []).map((version) => [`${version.templateId}::${version.version}`, { snapshot: structuredClone(version.snapshot), content_hash: version.contentHash }])
  );
  const client = {
    async query(sql: string, values: unknown[] = []) {
      queries.push({ sql, values });
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      if (normalized.includes("pg_advisory_lock")) {
        return { rows: [{ pg_advisory_lock: null }] };
      } else if (normalized.includes("pg_advisory_unlock")) {
        return { rows: [{ unlocked: true }] };
      } else if (normalized.includes("from pg_constraint c")) {
        return { rows: options.constraintDefinition ? [structuredClone(options.constraintDefinition)] : [] };
      } else if (normalized.includes("from pg_class c") && normalized.includes("table_schema")) {
        return { rows: [{ table_schema: options.tableSchema ?? "public" }] };
      } else if (normalized.includes("from pg_proc p")) {
        return { rows: options.functionDefinition ? [structuredClone(options.functionDefinition)] : [] };
      } else if (normalized.includes("from pg_trigger t")) {
        return { rows: options.triggerDefinition ? [structuredClone(options.triggerDefinition)] : [] };
      } else if (normalized.startsWith("insert into templates (template_id, label, asset_slots)")) {
        const [templateId, label, assetSlotsJson] = values as [string, string, string];
        if (!templates.has(templateId)) {
          templates.set(templateId, {
            template_id: templateId,
            label,
            asset_slots: JSON.parse(assetSlotsJson) as string[],
            current_version: null,
            status: null
          });
        }
      } else if (normalized.startsWith("select template_id, label, asset_slots, current_version, status from templates")) {
        return { rows: Array.from(templates.values(), (template) => structuredClone(template)) };
      } else if (normalized.startsWith("select t.template_id, t.current_version, t.status,")) {
        return {
          rows: Array.from(templates.values(), (template) => {
            const storedVersion = template.current_version
              ? versions.get(`${template.template_id}::${template.current_version}`)
              : undefined;
            return {
              template_id: template.template_id,
              current_version: template.current_version,
              status: template.status,
              version_template_id: storedVersion ? template.template_id : null,
              version: storedVersion ? template.current_version : null,
              snapshot: storedVersion?.snapshot ?? null,
              content_hash: storedVersion?.content_hash ?? null
            };
          })
        };
      } else if (normalized.startsWith("insert into template_versions")) {
        const [templateId, version, snapshotJson, contentHash] = values as [string, string, string, string];
        const key = `${templateId}::${version}`;
        if (!versions.has(key)) {
          versions.set(key, { snapshot: JSON.parse(snapshotJson) as unknown, content_hash: contentHash });
        }
      } else if (normalized.startsWith("select template_id, version, snapshot, content_hash from template_versions")) {
        if (!normalized.includes("where template_id")) {
          return {
            rows: Array.from(versions.entries(), ([key, row]) => {
              const separator = key.lastIndexOf("::");
              return {
                template_id: key.slice(0, separator),
                version: key.slice(separator + 2),
                ...structuredClone(row)
              };
            })
          };
        }
        if (versionReadError) {
          const error = versionReadError;
          versionReadError = undefined;
          throw error;
        }
        const row = versions.get(`${String(values[0])}::${String(values[1])}`);
        return {
          rows: row ? [{
            template_id: String(values[0]),
            version: String(values[1]),
            ...structuredClone(row)
          }] : []
        };
      } else if (normalized.startsWith("update templates set label =")) {
        const [templateId, label, assetSlotsJson] = values as [string, string, string];
        const existing = templates.get(templateId);
        if (existing) {
          templates.set(templateId, {
            ...existing,
            label,
            asset_slots: JSON.parse(assetSlotsJson) as string[]
          });
        }
      } else if (normalized.startsWith("update templates set current_version = coalesce")) {
        const [templateId, currentVersion, status] = values as [string, string, "active"];
        const existing = templates.get(templateId);
        if (existing) {
          templates.set(templateId, {
            ...existing,
            current_version: existing.current_version ?? currentVersion,
            status: existing.status ?? status
          });
        }
      }
      return { rows: [], rowCount: 0 };
    },
    release() {
      releaseCount += 1;
    }
  };
  const pool = {
    async connect() {
      return client;
    },
    async query() {
      directPoolQueryCount += 1;
      throw new Error("init_used_pool_query");
    }
  };
  return {
    pool,
    queries,
    templates,
    versions,
    get releaseCount() { return releaseCount; },
    get directPoolQueryCount() { return directPoolQueryCount; }
  };
}

test("MemoryStorage keeps xr telemetry events in insertion order", async () => {
  const storage = new MemoryStorage();

  await storage.addXrTelemetry("room-a", "p-1", {
    updatedAt: "2026-04-24T18:00:00.000Z",
    kind: "ray_on"
  });
  await storage.addXrTelemetry("room-a", "p-1", {
    updatedAt: "2026-04-24T18:00:01.000Z",
    kind: "trigger_press"
  });

  const events = await storage.getXrTelemetry("room-a");
  assert.equal(events.length, 2);
  assert.equal(events[0]?.participantId, "p-1");
  assert.equal(events[0]?.payload.kind, "ray_on");
  assert.equal(events[1]?.payload.kind, "trigger_press");
});

test("MemoryStorage xr telemetry snapshots are cloned on read", async () => {
  const storage = new MemoryStorage();

  await storage.addXrTelemetry("room-a", "p-1", {
    updatedAt: "2026-04-24T18:00:00.000Z",
    xrAxes: { turnX: -0.16 }
  });

  const firstRead = await storage.getXrTelemetry("room-a");
  (firstRead[0]?.payload.xrAxes as { turnX?: number }).turnX = 999;

  const secondRead = await storage.getXrTelemetry("room-a");
  assert.equal((secondRead[0]?.payload.xrAxes as { turnX?: number }).turnX, -0.16);
});

test("MemoryStorage enables screen share for new rooms by default", async () => {
  const storage = new MemoryStorage();

  const defaultRoom = await storage.createRoom({ name: "Default Feature Room" });
  const disabledRoom = await storage.createRoom({
    name: "Share Disabled Room",
    features: { voice: true, spatialAudio: true, screenShare: false }
  });

  assert.equal(defaultRoom.features.screenShare, true);
  assert.equal(disabledRoom.features.screenShare, false);
});

test("MemoryStorage defaults personal rooms to private owner state", async () => {
  const storage = new MemoryStorage();

  const room = await storage.createRoom({
    name: "Owner Personal Room",
    roomType: "personal",
    ownerParticipantId: "owner-personal"
  });

  assert.equal(room.templateId, "personal-workspace-basic");
  assert.equal(room.visibility, "private");
  assert.equal(room.guestAllowed, false);
  assert.equal(room.personalState?.lastPose, undefined);
});

test("MemoryStorage exposes versioned template catalog and clone-safe lookup", async () => {
  const storage = new MemoryStorage();

  const templates = await storage.listTemplates();
  assert.deepEqual(templates.map(({ templateId, currentVersion, status }) => ({ templateId, currentVersion, status })), [
    { templateId: "meeting-room-basic", currentVersion: "0.1.0", status: "active" },
    { templateId: "showroom-basic", currentVersion: "0.1.0", status: "active" },
    { templateId: "event-demo-basic", currentVersion: "0.1.0", status: "active" },
    { templateId: "personal-workspace-basic", currentVersion: "0.1.0", status: "active" }
  ]);

  const first = await storage.getTemplateVersion("meeting-room-basic", "0.1.0");
  assert.ok(first);
  first.assetSlots.push("spoofed-slot");
  assert.deepEqual((await storage.getTemplateVersion("meeting-room-basic"))?.assetSlots, ["logo", "hero-screen"]);
});

test("MemoryStorage hides deprecated templates while preserving existing rooms", async () => {
  const storage = new MemoryStorage();
  const existingRoom = await storage.createRoom({
    roomId: "memory-deprecated-template-room",
    templateId: "showroom-basic",
    name: "Deprecated Template Room"
  });
  const internals = storage as unknown as {
    templates: Map<string, { templateId: string; label: string; assetSlots: string[]; currentVersion: string; status: "active" | "deprecated" }>;
  };
  const template = internals.templates.get("showroom-basic");
  assert.ok(template);
  internals.templates.set("showroom-basic", { ...template, status: "deprecated" });

  assert.equal((await storage.listTemplates()).some(({ templateId }) => templateId === "showroom-basic"), false);
  assert.equal((await storage.getTemplateVersion("showroom-basic", "0.1.0"))?.version, "0.1.0");
  await assert.rejects(
    storage.createRoom({ templateId: "showroom-basic", name: "Rejected Deprecated Room" }),
    /template_deprecated:showroom-basic/
  );

  const updated = await storage.updateRoom(existingRoom.roomId, { name: "Still Editable" });
  assert.equal(updated?.name, "Still Editable");
  assert.equal(updated?.templateId, "showroom-basic");
  assert.equal(updated?.templateVersion, "0.1.0");
});

test("MemoryStorage snapshots resolved room config and ignores spoofed metadata", async () => {
  const storage = new MemoryStorage();
  const spoofedSnapshot = {
    schemaVersion: 1 as const,
    templateId: "meeting-room-basic",
    version: "9.9.9",
    label: "Spoofed",
    assetSlots: ["spoofed"],
    roomConfig: {
      roomType: "personal" as const,
      visibility: "private" as const,
      guestAllowed: false,
      sceneBundleUrl: "https://attacker.invalid/scene.json",
      features: { voice: false, spatialAudio: false, screenShare: false },
      theme: { primaryColor: "#000000", accentColor: "#000000" },
      avatarConfig: {
        avatarsEnabled: false,
        avatarQualityProfile: "mobile-lite" as const,
        avatarFallbackCapsulesEnabled: false
      }
    }
  };

  const created = await storage.createRoom({
    roomId: "snapshot-room",
    templateId: "meeting-room-basic",
    name: "Snapshot Room",
    visibility: "unlisted",
    sceneBundleUrl: "/assets/scenes/actual/scene.json",
    features: { voice: true, spatialAudio: false, screenShare: true },
    theme: { primaryColor: "#112233", accentColor: "#445566" },
    avatarConfig: {
      avatarsEnabled: true,
      avatarCatalogUrl: "/assets/avatars/actual.json",
      avatarQualityProfile: "xr",
      avatarFallbackCapsulesEnabled: true,
      avatarSeatsEnabled: false
    },
    templateVersion: "9.9.9",
    templateSnapshot: spoofedSnapshot
  });

  assert.equal(created.templateVersion, "0.1.0");
  assert.equal(created.templateSnapshot.version, "0.1.0");
  assert.equal(created.templateSnapshot.label, "Meeting Room Basic");
  assert.deepEqual(created.templateSnapshot.roomConfig, {
    roomType: "standard",
    visibility: "unlisted",
    guestAllowed: true,
    sceneBundleUrl: "/assets/scenes/actual/scene.json",
    features: { voice: true, spatialAudio: false, screenShare: true },
    theme: { primaryColor: "#112233", accentColor: "#445566" },
    avatarConfig: {
      avatarsEnabled: true,
      avatarCatalogUrl: "/assets/avatars/actual.json",
      avatarQualityProfile: "xr",
      avatarFallbackCapsulesEnabled: true,
      avatarSeatsEnabled: false
    }
  });
  assert.deepEqual(Object.keys(created.templateSnapshot).sort(), ["assetSlots", "label", "roomConfig", "schemaVersion", "templateId", "version"].sort());

  const updated = await storage.updateRoom(created.roomId, {
    visibility: "private",
    guestAllowed: false,
    sceneBundleUrl: undefined,
    features: { voice: false, spatialAudio: true, screenShare: false },
    templateVersion: "9.9.9",
    templateSnapshot: spoofedSnapshot
  });
  assert.ok(updated);
  assert.equal(updated.templateVersion, "0.1.0");
  assert.equal(updated.templateSnapshot.roomConfig.visibility, "private");
  assert.equal(updated.templateSnapshot.roomConfig.guestAllowed, false);
  assert.equal(updated.templateSnapshot.roomConfig.sceneBundleUrl, null);
  assert.deepEqual(updated.templateSnapshot.roomConfig.features, { voice: false, spatialAudio: true, screenShare: false });
});

test("MemoryStorage keeps a room pinned when its template current version advances", async () => {
  const storage = new MemoryStorage();
  const pinned = await storage.createRoom({
    roomId: "memory-pinned-room",
    templateId: "meeting-room-basic",
    name: "Memory Pinned Room"
  });
  const internals = storage as unknown as {
    templates: Map<string, { templateId: string; label: string; assetSlots: string[]; currentVersion: string; status: "active" | "deprecated" }>;
    templateVersions: Map<string, { schemaVersion: 1; templateId: string; version: string; label: string; assetSlots: string[] }>;
  };
  internals.templateVersions.set("meeting-room-basic::0.2.0", {
    schemaVersion: 1,
    templateId: "meeting-room-basic",
    version: "0.2.0",
    label: "Meeting Room Basic 0.2",
    assetSlots: ["logo", "presentation-screen"]
  });
  const template = internals.templates.get("meeting-room-basic");
  assert.ok(template);
  internals.templates.set("meeting-room-basic", { ...template, currentVersion: "0.2.0" });
  assert.deepEqual((await storage.listTemplates())[0], {
    ...template,
    label: "Meeting Room Basic 0.2",
    assetSlots: ["logo", "presentation-screen"],
    currentVersion: "0.2.0"
  });

  const updated = await storage.updateRoom(pinned.roomId, {
    templateId: "meeting-room-basic",
    visibility: "private"
  });
  assert.ok(updated);
  assert.equal(updated.templateVersion, "0.1.0");
  assert.equal(updated.templateSnapshot.version, "0.1.0");
  assert.equal(updated.templateSnapshot.roomConfig.visibility, "private");

  await assert.rejects(
    storage.updateRoom(pinned.roomId, { templateId: "showroom-basic" }),
    /room_template_binding_changed/
  );
  const afterRejectedSwitch = await storage.getRoom(pinned.roomId);
  assert.equal(afterRejectedSwitch?.templateId, "meeting-room-basic");
  assert.equal(afterRejectedSwitch?.templateVersion, "0.1.0");

  const createdAfterAdvance = await storage.createRoom({
    roomId: "memory-current-room",
    templateId: "meeting-room-basic",
    name: "Memory Current Room"
  });
  assert.equal(createdAfterAdvance.templateVersion, "0.2.0");
});

test("Postgres storage init retries transient connection failures", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const retryAttempts: number[] = [];

  await initPostgresStorageWithRetry({
    async init() {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("connect ECONNREFUSED 127.0.0.1:5432") as Error & { code: string };
        error.code = "ECONNREFUSED";
        throw error;
      }
    }
  }, {
    maxAttempts: 3,
    retryDelayMs: 25,
    onRetry: (_error, attempt) => retryAttempts.push(attempt),
    wait: async (ms) => {
      waits.push(ms);
    }
  });

  assert.equal(attempts, 3);
  assert.deepEqual(retryAttempts, [1, 2]);
  assert.deepEqual(waits, [25, 25]);
});

test("Postgres storage init fails fast on non-connection errors", async () => {
  let attempts = 0;
  const syntaxError = new Error("syntax error at or near create") as Error & { code: string };
  syntaxError.code = "42601";

  let rejected: unknown;
  try {
    await initPostgresStorageWithRetry({
      async init() {
        attempts += 1;
        throw syntaxError;
      }
    }, {
      maxAttempts: 5,
      retryDelayMs: 25,
      wait: async () => undefined
    });
  } catch (error) {
    rejected = error;
  }

  assert.equal(attempts, 1);
  assert.equal(rejected, syntaxError);
});

test("Postgres storage init preserves retryable seed read errors", async () => {
  const transientError = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  const fake = createPostgresInitPool({ versionReadErrorOnce: transientError });
  const retries: number[] = [];

  await initPostgresStorageWithRetry(
    new PostgresStorage(fake.pool as unknown as ConstructorParameters<typeof PostgresStorage>[0]),
    {
      maxAttempts: 2,
      retryDelayMs: 0,
      onRetry: (_error, attempt) => retries.push(attempt),
      wait: async () => undefined
    }
  );

  assert.deepEqual(retries, [1]);
  assert.equal(fake.queries.filter(({ sql }) => /pg_advisory_lock/.test(sql)).length, 2);
});

test("Postgres storage init adds session control column before altering its default", async () => {
  const fake = createPostgresInitPool();

  await new PostgresStorage(fake.pool as unknown as ConstructorParameters<typeof PostgresStorage>[0]).init();

  const addColumnIndex = fake.queries.findIndex(({ sql }) => sql.includes("add column if not exists session_control"));
  const alterDefaultIndex = fake.queries.findIndex(({ sql }) => sql.includes("alter column session_control set default"));
  const lockIndex = fake.queries.findIndex(({ sql }) => /pg_advisory_lock/.test(sql));
  const beginIndex = fake.queries.findIndex(({ sql }) => sql.trim().toLowerCase() === "begin");
  const firstDdlIndex = fake.queries.findIndex(({ sql }) => /create table if not exists tenants/.test(sql));
  const commitIndex = fake.queries.findIndex(({ sql }) => sql.trim().toLowerCase() === "commit");
  const unlockIndex = fake.queries.findIndex(({ sql }) => /pg_advisory_unlock/.test(sql));
  assert.equal(lockIndex, 0);
  assert.ok(lockIndex < beginIndex && beginIndex < firstDdlIndex && firstDdlIndex < commitIndex && commitIndex < unlockIndex);
  assert.notEqual(addColumnIndex, -1);
  assert.notEqual(alterDefaultIndex, -1);
  assert.ok(addColumnIndex < alterDefaultIndex);
  assert.equal(fake.directPoolQueryCount, 0);
  assert.equal(fake.releaseCount, 1);
  assert.match(fake.queries.at(-1)?.sql ?? "", /pg_advisory_unlock/);
});

test("Postgres storage init builds the nullable append-only template bridge", async () => {
  const wave2Snapshot = {
    schemaVersion: 1 as const,
    templateId: "wave2-database-only-template",
    version: "1.0.0",
    label: "Wave 2 Database Only Template",
    assetSlots: ["presentation-screen"]
  };
  const fake = createPostgresInitPool({
    extraTemplates: [
      {
        template_id: "database-only-template",
        label: "Database Only Template",
        asset_slots: ["logo"],
        current_version: null,
        status: null
      },
      {
        template_id: wave2Snapshot.templateId,
        label: wave2Snapshot.label,
        asset_slots: [...wave2Snapshot.assetSlots],
        current_version: wave2Snapshot.version,
        status: "deprecated"
      }
    ],
    versions: [{
      templateId: wave2Snapshot.templateId,
      version: wave2Snapshot.version,
      snapshot: wave2Snapshot,
      contentHash: templateVersionHash(wave2Snapshot)
    }]
  });

  await new PostgresStorage(fake.pool as unknown as ConstructorParameters<typeof PostgresStorage>[0]).init();

  assert.equal(fake.versions.size, 6);
  assert.deepEqual(fake.versions.get("database-only-template::0.1.0")?.snapshot, {
    schemaVersion: 1,
    templateId: "database-only-template",
    version: "0.1.0",
    label: "Database Only Template",
    assetSlots: ["logo"]
  });
  assert.match(fake.versions.get("database-only-template::0.1.0")?.content_hash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(fake.templates.get("database-only-template")?.current_version, "0.1.0");
  assert.equal(fake.templates.get("database-only-template")?.status, "active");
  assert.deepEqual(fake.versions.get(`${wave2Snapshot.templateId}::${wave2Snapshot.version}`)?.snapshot, wave2Snapshot);
  assert.equal(fake.versions.has(`${wave2Snapshot.templateId}::0.1.0`), false);
  assert.equal(fake.templates.get(wave2Snapshot.templateId)?.current_version, "1.0.0");
  assert.equal(fake.templates.get(wave2Snapshot.templateId)?.status, "deprecated");
  assert.deepEqual(Array.from(fake.templates.keys()).sort(), [
    "database-only-template",
    "event-demo-basic",
    "meeting-room-basic",
    "personal-workspace-basic",
    "showroom-basic",
    "wave2-database-only-template"
  ]);

  const sql = fake.queries.map((query) => query.sql).join("\n");
  assert.match(sql, /alter table templates add column if not exists current_version text/);
  assert.match(sql, /alter table templates add column if not exists status text/);
  assert.match(sql, /alter table rooms add column if not exists template_version text/);
  assert.match(sql, /alter table rooms add column if not exists template_snapshot jsonb/);
  assert.match(sql, /constraint templates_current_version_fkey/);
  assert.match(sql, /constraint rooms_template_version_fkey/);
  assert.match(sql, /create trigger template_versions_immutable/);
  assert.match(sql, /before update or delete on template_versions/);

  const legacyInsert = fake.queries.find(({ sql: querySql }) => querySql.includes("insert into rooms (room_id, tenant_id, template_id, name"));
  assert.ok(legacyInsert);
  assert.match(legacyInsert.sql, /template_version, template_snapshot/);
  assert.equal(legacyInsert.values[4], "0.1.0");
  const demoSnapshot = JSON.parse(String(legacyInsert.values[5])) as { templateId: string; version: string; roomConfig?: unknown };
  assert.equal(demoSnapshot.templateId, "meeting-room-basic");
  assert.equal(demoSnapshot.version, "0.1.0");
  assert.ok(demoSnapshot.roomConfig);
  const repairIndex = fake.queries.findIndex(({ sql: querySql }) => querySql.includes("with desired as") && querySql.includes("update rooms"));
  const triggerIndex = fake.queries.findIndex(({ sql: querySql }) => querySql.includes("create trigger template_versions_immutable"));
  assert.ok(repairIndex >= 0 && triggerIndex > repairIndex);
});

test("Postgres storage init rejects a dangling database-only current version", async () => {
  const fake = createPostgresInitPool({
    extraTemplates: [{
      template_id: "dangling-database-only-template",
      label: "Dangling Database Only Template",
      asset_slots: ["logo"],
      current_version: "1.0.0",
      status: "deprecated"
    }]
  });

  await assert.rejects(
    new PostgresStorage(fake.pool as unknown as ConstructorParameters<typeof PostgresStorage>[0]).init(),
    /template_version_not_found:dangling-database-only-template@1\.0\.0/
  );
  assert.equal(fake.versions.has("dangling-database-only-template::0.1.0"), false);
});

test("Postgres storage creates the immutable trigger function beside its table", async () => {
  const fake = createPostgresInitPool({ tableSchema: "vrata_app" });

  await new PostgresStorage(fake.pool as unknown as ConstructorParameters<typeof PostgresStorage>[0]).init();

  const sql = fake.queries.map((query) => query.sql).join("\n");
  assert.match(sql, /create function "vrata_app"\.vrata_reject_template_version_mutation\(\)/);
  assert.match(sql, /execute function "vrata_app"\.vrata_reject_template_version_mutation\(\)/);
  assert.doesNotMatch(sql, /create function public\.vrata_reject_template_version_mutation\(\)/);
});

test("Postgres template listing rejects unsupported non-null status", async () => {
  const snapshot = {
    schemaVersion: 1,
    templateId: "database-only-template",
    version: "0.1.0",
    label: "Database Only Template",
    assetSlots: ["logo"]
  };
  const createPool = (status: string | null) => ({
    async query() {
      return {
        rows: [{
          template_id: "database-only-template",
          current_version: "0.1.0",
          status,
          version_template_id: "database-only-template",
          version: "0.1.0",
          snapshot,
          content_hash: templateVersionHash(snapshot)
        }]
      };
    }
  });

  const nullStatusStorage = new PostgresStorage(createPool(null) as unknown as ConstructorParameters<typeof PostgresStorage>[0]);
  assert.equal((await nullStatusStorage.listTemplates())[0]?.status, "active");

  const deprecatedStorage = new PostgresStorage(createPool("deprecated") as unknown as ConstructorParameters<typeof PostgresStorage>[0]);
  assert.deepEqual(await deprecatedStorage.listTemplates(), []);

  const unsupportedStatusStorage = new PostgresStorage(createPool("retired") as unknown as ConstructorParameters<typeof PostgresStorage>[0]);
  await assert.rejects(
    unsupportedStatusStorage.listTemplates(),
    /unsupported_template_status:database-only-template:retired/
  );

  const invalidInit = createPostgresInitPool({
    extraTemplates: [{
      template_id: "database-only-template",
      label: "Database Only Template",
      asset_slots: ["logo"],
      current_version: "0.1.0",
      status: "retired"
    }]
  });
  await assert.rejects(
    new PostgresStorage(invalidInit.pool as unknown as ConstructorParameters<typeof PostgresStorage>[0]).init(),
    /unsupported_template_status:database-only-template:retired/
  );
});

test("Postgres storage init rejects a conflicting immutable seed snapshot", async () => {
  const fake = createPostgresInitPool({
    versions: [{
      templateId: "meeting-room-basic",
      version: "0.1.0",
      snapshot: { schemaVersion: 1, templateId: "meeting-room-basic", version: "0.1.0", label: "Changed", assetSlots: [] },
      contentHash: "bad-hash"
    }]
  });

  await assert.rejects(
    new PostgresStorage(fake.pool as unknown as ConstructorParameters<typeof PostgresStorage>[0]).init(),
    /template_version_seed_conflict:meeting-room-basic@0\.1\.0/
  );
  const rollbackIndex = fake.queries.findIndex(({ sql }) => sql.trim().toLowerCase() === "rollback");
  const unlockIndex = fake.queries.findIndex(({ sql }) => /pg_advisory_unlock/.test(sql));
  assert.notEqual(rollbackIndex, -1);
  assert.equal(fake.queries.some(({ sql }) => sql.trim().toLowerCase() === "commit"), false);
  assert.ok(rollbackIndex < unlockIndex);
  assert.equal(fake.releaseCount, 1);
  assert.match(fake.queries.at(-1)?.sql ?? "", /pg_advisory_unlock/);
});

test("Postgres storage init fails fast on a mismatched named foreign key", async () => {
  const fake = createPostgresInitPool({
    constraintDefinition: {
      contype: "f",
      convalidated: true,
      condeferrable: false,
      condeferred: false,
      confmatchtype: "s",
      confupdtype: "a",
      confdeltype: "a",
      referenced_table_matches: false,
      definition: "FOREIGN KEY (template_id) REFERENCES tenants(tenant_id)",
      columns: ["template_id"],
      referenced_columns: ["tenant_id"]
    }
  });

  await assert.rejects(
    new PostgresStorage(fake.pool as unknown as ConstructorParameters<typeof PostgresStorage>[0]).init(),
    /postgres_constraint_definition_mismatch/
  );
  assert.equal(fake.releaseCount, 1);
});

test("Postgres storage init does not overwrite a mismatched schema-qualified function", async () => {
  const fake = createPostgresInitPool({
    functionDefinition: {
      return_type: "trigger",
      language: "plpgsql",
      source: "begin return old; end",
      security_definer: false,
      definition: "CREATE FUNCTION public.vrata_reject_template_version_mutation()"
    }
  });

  await assert.rejects(
    new PostgresStorage(fake.pool as unknown as ConstructorParameters<typeof PostgresStorage>[0]).init(),
    /postgres_function_definition_mismatch/
  );
  assert.equal(fake.queries.some(({ sql }) => /create function public\.vrata_reject_template_version_mutation/.test(sql)), false);
});

test("Postgres storage init fails fast on a mismatched immutable trigger", async () => {
  const fake = createPostgresInitPool({
    functionDefinition: {
      return_type: "trigger",
      language: "plpgsql",
      source: "begin raise exception 'template_versions_are_immutable' using errcode = '55000'; return null; end",
      security_definer: false,
      volatility: "v",
      leakproof: false,
      parallel_safety: "u",
      strict: false,
      runtime_config: null,
      definition: "CREATE FUNCTION public.vrata_reject_template_version_mutation()"
    },
    triggerDefinition: {
      trigger_type: 19,
      tgenabled: "O",
      has_no_when: true,
      all_columns: true,
      function_name: "vrata_reject_template_version_mutation",
      function_arg_count: 0,
      function_schema: "public",
      definition: "CREATE TRIGGER template_versions_immutable BEFORE UPDATE ON template_versions"
    }
  });

  await assert.rejects(
    new PostgresStorage(fake.pool as unknown as ConstructorParameters<typeof PostgresStorage>[0]).init(),
    /postgres_trigger_definition_mismatch/
  );
});
