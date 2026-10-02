import type { Pool, PoolClient } from "pg";
import type { PostgresStorageInitHooks } from "../storage-postgres-init.js";

export type InitPhase = keyof PostgresStorageInitHooks;
export interface InitQuery { sql: string; values: unknown[] }
export type InitTrace = ({ kind: "query" } & InitQuery) | { kind: InitPhase | "connect" | "release" };

export function createStorageInitHarness(options: {
  beforeQuery?: (query: InitQuery, index: number) => void | Promise<void>;
  beforePhase?: (phase: InitPhase, client: PoolClient) => void | Promise<void>;
  connectError?: Error;
  releaseError?: Error;
  incompleteBackfill?: boolean;
  tableSchema?: string | null;
  unlockRows?: Array<Record<string, unknown>>;
} = {}) {
  const queries: InitQuery[] = [];
  const trace: InitTrace[] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      const query = { sql, values };
      queries.push(query);
      trace.push({ kind: "query", ...query });
      await options.beforeQuery?.(query, queries.length - 1);
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      if (normalized.includes("pg_advisory_unlock")) {
        return { rows: options.unlockRows ?? [{ unlocked: true }] };
      }
      if (normalized.includes("from pg_class c") && normalized.includes("table_schema")) {
        return { rows: options.tableSchema === null ? [] : [{ table_schema: options.tableSchema ?? "public" }] };
      }
      if (normalized.startsWith("select 1 from rooms where template_version")) {
        return { rows: options.incompleteBackfill ? [{ "?column?": 1 }] : [] };
      }
      return { rows: [] };
    },
    release() {
      trace.push({ kind: "release" });
      if (options.releaseError) throw options.releaseError;
    }
  } as unknown as PoolClient;
  const pool = {
    async connect() {
      trace.push({ kind: "connect" });
      if (options.connectError) throw options.connectError;
      return client;
    },
    async query() {
      throw new Error("initialization_must_use_the_checked_out_client");
    }
  } as unknown as Pool;
  const phase = async (name: InitPhase, receivedClient: PoolClient) => {
    if (receivedClient !== client) throw new Error("initialization_client_changed");
    trace.push({ kind: name });
    await options.beforePhase?.(name, receivedClient);
  };
  const hooks: PostgresStorageInitHooks = {
    seed: (value) => phase("seed", value),
    validateStoredTemplateVersions: (value) => phase("validateStoredTemplateVersions", value),
    synchronizeTemplateCatalog: (value) => phase("synchronizeTemplateCatalog", value)
  };
  return { client, pool, hooks, queries, trace };
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
